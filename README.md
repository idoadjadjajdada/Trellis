# Trellis

Trellis stores project notes as small **atoms** (one self-contained statement of one to three sentences) and shows them as a weighted 3D graph where related atoms sit close together. Claude and ChatGPT save atoms into it automatically through a connector. Every atom belongs to a project, and the graph can show one project or all of them together.

It is one codebase that runs **hosted** (multi-user, passkey sign-in) or **locally** (Docker), with the same Postgres + pgvector database in both.

- **Graph**: three.js via `3d-force-graph`. Distance = similarity, size = importance, fade = recency. Each project is a colored layer.
- **Connector**: one remote MCP server (`/mcp`) with OAuth 2.1, used by Claude and ChatGPT. Tools: Save note, Search notes, List projects, Update note.
- **Saving rules** live in the tool descriptions (`src/server/mcp.ts`). Edit the wording there to tune what gets saved.
- **Review**: atoms the AI is unsure about wait for you to Approve, Edit, or Delete.
- **Trash**: deleted atoms are kept for 30 days, then removed for good.
- **Layouts**: desktop, iPad (portrait/landscape), and phone (installable web app with a bottom bar, bottom sheets, and swipe review).
- **REST API** with API keys for anything else.

---

## Run it locally (Docker)

```bash
cp .env.example .env        # optional; the defaults work on localhost
docker compose up -d
open http://localhost:3000
```

Create an account with a passkey, save the recovery codes, then go to **Settings → Connect an AI**.

The first start downloads the embedding model (about 130 MB) into a Docker volume. Notes can be saved once that finishes (a few seconds to a minute).

The app listens on `127.0.0.1:3000` only. Data lives in the `pgdata` volume. To back up: `docker compose exec db pg_dump -U trellis trellis > trellis.sql`.

### Claude Desktop with the local version

Claude's custom connectors are reached from Anthropic's cloud, even in Claude Desktop, so they cannot reach `localhost`. Claude Desktop can still use a local Trellis through a small stdio bridge:

1. In Trellis, open **Settings → API keys** and create a key (e.g. "Claude Desktop").
2. Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "trellis": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "TRELLIS_API_KEY=trk_...", "trellis", "node", "dist/server/stdio-bridge.js"]
    }
  }
}
```

Without Docker, point Node at your build instead: `"command": "node", "args": ["/path/to/Trellis/dist/server/stdio-bridge.js"]`, with `"env": { "TRELLIS_URL": "http://localhost:3000", "TRELLIS_API_KEY": "trk_..." }`.

To use claude.ai or ChatGPT with a local Trellis, expose it through a tunnel (e.g. Cloudflare Tunnel or ngrok) and set `PUBLIC_URL` to the tunnel's https address **before creating your account**, because passkeys are tied to the host name.

---

## Connect Claude or ChatGPT (hosted, or tunneled)

The connector URL is `https://<your-trellis>/mcp` (shown in Settings).

- **Claude**: Customize → Connectors → Add custom connector → paste the URL → Connect → sign in with your passkey → Allow.
- **ChatGPT**: Plugins → add a custom MCP server (on some plans this needs Developer mode in Settings → Security) → paste the URL → OAuth → sign in → Allow. ChatGPT changes this flow often; check OpenAI's current help pages if it looks different. As of this writing ChatGPT supports remote MCP with OAuth, dynamic client registration and PKCE, and no longer requires `search`/`fetch` tools, which is what Trellis implements.

How sign-in works: Trellis is its own OAuth 2.1 authorization server. It publishes protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource[/mcp]` and server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`. It supports dynamic client registration (RFC 7591), PKCE S256, the `resource` parameter (RFC 8707), refresh-token rotation, revocation, and the `iss` response parameter (RFC 9207). Each token only reaches its own user's atoms. Connected apps can be disconnected in Settings.

API keys (`Authorization: Bearer trk_...`) also work on `/mcp`, for clients that send a fixed header.

---

## Host it

Trellis is a single Node process plus Postgres with pgvector.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | The origin people and AI apps use. Must be `https://` unless localhost. Passkeys are bound to its host name. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/trellis` | Postgres 16+ with the `vector` extension available. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `EMBEDDING_PROVIDER` | `local` | `local` (in-process model) or `openai`. |
| `EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` (local), `text-embedding-3-small` (openai) | Changing it re-embeds every atom on the next start. |
| `OPENAI_API_KEY` | | Required for `EMBEDDING_PROVIDER=openai`. |
| `MODEL_CACHE_DIR` | | Where the local model is downloaded. |
| `LOCAL_MODEL_PATH` | | A folder with pre-downloaded models; nothing is downloaded when set. |
| `ALLOW_SIGNUP` | `true` | Set `false` to stop new accounts. |
| `TRUST_PROXY` | loopback only | Set `true` (or the number of hops) behind a reverse proxy, so rate limits see real client IPs. |

```bash
docker build -t trellis .
docker run -p 3000:3000 -e PUBLIC_URL=https://trellis.example.com -e DATABASE_URL=... -e TRUST_PROXY=true trellis
```

Migrations run automatically on start (guarded by an advisory lock, so several instances can start at once). The server is stateless apart from Postgres, so you can run more than one instance.

---

## Develop

Requirements: Node 22+, Postgres 16 with pgvector (or `docker compose up -d db` and add `ports: ["5432:5432"]` to the `db` service).

```bash
npm install
npm run dev          # API + Vite on http://localhost:3000 (same origin, so passkeys work)
npm run typecheck
npm test             # integration tests against a real Postgres (creates the trellis_test database)
npm run build && npm start
```

Tests use `TEST_ADMIN_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`) to create a `trellis_test` database, and a deterministic fake embedder so they run offline.

Browser end-to-end test (real browser, virtual passkey authenticator, desktop + iPad + phone):

```bash
npm i -g playwright && npx playwright install chromium   # once
npm run build && npm start &                               # or docker compose up -d
npm run test:e2e
```

### Layout

```
src/server/          Express app, MCP server, OAuth, passkeys, notes service, migrations
src/server/mcp.ts    The four tools and the saving rules (tool descriptions)
src/server/notes.ts  Saving (dedup, replaces, review), search, graph links, trash
src/web/             React app: graph, panels, Notes, Review, Settings, Trash
src/shared/types.ts  Types shared by both
test/                Integration tests (Vitest) and the browser e2e script
```

---

## How it works

**Saving** (`NotesService.saveNote`):
1. The text is embedded and compared with the user's existing atoms. If one is at least as similar as the duplicate threshold (default 0.9), its reference count goes up (raising its weight) instead of adding a duplicate. Atoms being replaced, and atoms already replaced, are skipped: a corrected date reads almost the same as the old one.
2. `replaces` links the new atom to older ones it contradicts. The old atom stays but dims, and search ranks it a little lower.
3. The project is matched by name (case-insensitive). Unknown or missing names go to **Unsorted**; the AI never creates projects.
4. `uncertain: true` sends the atom to Review instead of saving it straight away.

**Weight** (atom size, 0 to 1): pinned atoms are 1; otherwise `0.15 + 0.5 × AI score + 0.35 × min(1, ln(1 + references) / ln 11)`.

**Links**: each atom links to up to 8 of its most similar atoms above the link threshold, with strength equal to the similarity. Links are computed in Postgres and cached until the user's data changes. "Replaces" links are drawn in orange with an arrow.

**Layout**: force-directed. Positions are computed, never saved. New atoms start next to their most similar neighbor, and the existing graph keeps its positions, so it shifts instead of scrambling.

**Recency**: opacity halves every 60 days of age, never below 30%.

---

## Open questions from the spec, and what v1 does

- **Embedding model**: `bge-small-en-v1.5` running in-process via transformers.js, for both hosted and local. It is small (33M parameters, 384 dimensions), fast on CPU, scores well for its size, needs no API key, and gives the hosted and local versions identical vectors. `EMBEDDING_PROVIDER=openai` is available if you prefer an API.
- **Lost passkey device**: both. Ten one-time recovery codes are shown at sign-up (and can be regenerated in Settings), and you can add a passkey on each device you use. A recovery code only lets you add a new passkey; the session becomes a normal one after that.
- **ChatGPT**: its current connector support (remote MCP + OAuth with dynamic client registration + PKCE, arbitrary tools) matches what Trellis implements. It could not be tested against ChatGPT itself from the build environment, so treat it as expected to work, not verified.
- **Thresholds**: duplicates at 0.90 (as the spec suggested). Links start at **0.65**, not 0.75. Measured on real project notes with this model, 0.75 linked only near-paraphrases (4 links among 20 atoms), which leaves a graph of floating dots. 0.65 linked related decisions (e.g. Postgres ↔ Docker, passkeys ↔ recovery codes) and nothing unrelated. Both are sliders in **Settings → Graph**.
- **Mobile**: an installable web app (manifest + service worker), as decided.

## Limits worth knowing

- Similarity links are computed for all of a user's atoms at once, which is fine for thousands of atoms; tens of thousands would need an index-based approach.
- Changing `PUBLIC_URL`'s host name makes existing passkeys stop working (that is how passkeys work). Use a recovery code, then add a new passkey.
- Pinning an atom's *position* in the graph is not in v1 (the spec lists it as later). "Pin" means importance.
