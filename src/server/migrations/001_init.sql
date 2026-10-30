CREATE EXTENSION IF NOT EXISTS vector;

-- Accounts --------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        text NOT NULL,
  webauthn_user_id    bytea NOT NULL UNIQUE,
  duplicate_threshold double precision NOT NULL DEFAULT 0.9
                      CHECK (duplicate_threshold > 0 AND duplicate_threshold <= 1),
  link_threshold      double precision NOT NULL DEFAULT 0.65
                      CHECK (link_threshold > 0 AND link_threshold <= 1),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
  id            text PRIMARY KEY,               -- base64url credential id
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text,
  backed_up     boolean NOT NULL DEFAULT false,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes(user_id);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- A recovery-code session may only add a passkey; it cannot use the app.
  recovery     boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('register', 'login', 'add')),
  challenge   text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  pending     jsonb,
  expires_at  timestamptz NOT NULL
);

-- Notes -----------------------------------------------------------------

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  color       text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_user_name_idx ON projects(user_id, lower(name));

CREATE TABLE atoms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       uuid REFERENCES projects(id) ON DELETE SET NULL,  -- NULL = Unsorted
  text             text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1000),
  type             text NOT NULL CHECK (type IN ('decision', 'fact', 'task', 'idea', 'question')),
  status           text NOT NULL CHECK (status IN ('decided', 'proposed')),
  review_state     text NOT NULL DEFAULT 'approved' CHECK (review_state IN ('approved', 'pending')),
  source_ai        text,
  source_chat      text,
  pinned           boolean NOT NULL DEFAULT false,
  ai_score         double precision NOT NULL DEFAULT 0.5 CHECK (ai_score >= 0 AND ai_score <= 1),
  reference_count  integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  -- Importance, 0..1: pinned atoms are full weight, otherwise a mix of the
  -- AI-rated score and how often the atom has been referenced again.
  weight           double precision GENERATED ALWAYS AS (
                     CASE WHEN pinned THEN 1.0
                     ELSE LEAST(1.0, 0.15 + 0.5 * ai_score
                          + 0.35 * LEAST(1.0, ln(1.0 + reference_count::double precision) / ln(11.0)))
                     END) STORED,
  embedding        vector,
  embedding_model  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX atoms_user_live_idx ON atoms(user_id) WHERE deleted_at IS NULL;
CREATE INDEX atoms_deleted_idx ON atoms(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX atoms_project_idx ON atoms(project_id);

-- "new_atom replaces old_atom". The old atom dims in the graph.
CREATE TABLE replacements (
  new_atom_id  uuid NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  old_atom_id  uuid NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (new_atom_id, old_atom_id),
  CHECK (new_atom_id <> old_atom_id)
);
CREATE INDEX replacements_old_idx ON replacements(old_atom_id);

-- Connector access ------------------------------------------------------

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);

CREATE TABLE oauth_clients (
  client_id   text PRIMARY KEY,
  info        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- An authorization request waiting for the user to approve it.
CREATE TABLE oauth_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  state           text,
  resource        text,
  expires_at      timestamptz NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  resource        text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE oauth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL DEFAULT '{}',
  resource    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Set when a refresh token is exchanged for a new one (it keeps working for a short grace period).
  rotated_at  timestamptz,
  -- Set when the user disconnects the app; never honored again.
  revoked_at  timestamptz
);
CREATE INDEX oauth_tokens_user_client_idx ON oauth_tokens(user_id, client_id);

-- Change tracking -------------------------------------------------------
-- Every write to a user's notes bumps users.data_version, so open apps can
-- cheaply check whether they need to reload.

ALTER TABLE users ADD COLUMN data_version bigint NOT NULL DEFAULT 0;

CREATE FUNCTION bump_data_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE users SET data_version = data_version + 1 WHERE id = OLD.user_id;
  ELSE
    UPDATE users SET data_version = data_version + 1 WHERE id = NEW.user_id;
    IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      UPDATE users SET data_version = data_version + 1 WHERE id = OLD.user_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER atoms_bump AFTER INSERT OR UPDATE OR DELETE ON atoms
  FOR EACH ROW EXECUTE FUNCTION bump_data_version();
CREATE TRIGGER projects_bump AFTER INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION bump_data_version();
