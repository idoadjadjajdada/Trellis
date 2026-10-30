import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { withTransaction, type Db, type Queryable } from '../db.js';
import { badRequest, isUuid, notFound } from '../errors.js';
import type { ApiKeyService } from './apiKeys.js';
import { hashToken, newToken } from './tokens.js';

export const SCOPE = 'notes';
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_DAYS = 90;
const CODE_SECONDS = 5 * 60;
const REQUEST_MINUTES = 15;
/** A rotated refresh token keeps working briefly, so a client retrying after a dropped response is not logged out. */
const REFRESH_GRACE_SECONDS = 60;

export interface TokenOwner {
  userId: string;
  /** Shown as the atom's source, e.g. "Claude" or the API key's name. */
  sourceName: string;
}

export interface PendingAuthorization {
  id: string;
  clientName: string;
  redirectHost: string;
}

export interface ConnectedApp {
  clientId: string;
  name: string;
  connectedAt: string;
  lastUsedAt: string;
}

const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function checkRedirectUri(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect URI: ${uri}`);
  }
  if (url.hash) throw new InvalidClientMetadataError('Redirect URIs must not contain a fragment');
  if (DANGEROUS_SCHEMES.has(url.protocol)) throw new InvalidClientMetadataError(`Redirect URI scheme not allowed: ${url.protocol}`);
  // Plain http is only allowed for apps on the same machine (RFC 8252).
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new InvalidClientMetadataError('Redirect URIs must use https (or http on localhost)');
  }
}

export function clientDisplayName(client: Pick<OAuthClientInformationFull, 'client_name' | 'client_id'>): string {
  const name = client.client_name?.trim();
  return name ? name.slice(0, 80) : 'AI app';
}

/**
 * The OAuth 2.1 authorization server the Claude and ChatGPT connectors sign in
 * through. The MCP SDK handles the HTTP endpoints; this class stores clients,
 * codes and tokens in Postgres and sends the user to the consent page.
 */
export class TrellisOAuthProvider implements OAuthServerProvider {
  constructor(
    private db: Db,
    private apiKeys: ApiKeyService,
    /** The MCP endpoint URL; every token is issued for this resource. */
    private resourceUrl: URL,
    /** The issuer string exactly as advertised in the authorization server metadata. */
    private issuer: string,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const { rows } = await this.db.query('SELECT info FROM oauth_clients WHERE client_id = $1', [clientId]);
        return rows[0]?.info as OAuthClientInformationFull | undefined;
      },
      registerClient: async (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) throw new InvalidClientMetadataError('Client id missing');
        if (!Array.isArray(full.redirect_uris) || full.redirect_uris.length === 0 || full.redirect_uris.length > 10) {
          throw new InvalidClientMetadataError('Provide between 1 and 10 redirect URIs');
        }
        full.redirect_uris.forEach((u) => checkRedirectUri(String(u)));
        if (full.client_name) full.client_name = full.client_name.slice(0, 80);
        // Only these grants and the one scope are supported.
        full.grant_types = ['authorization_code', 'refresh_token'];
        full.response_types = ['code'];
        full.scope = SCOPE;
        await this.db.query('INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)', [full.client_id, full]);
        return full;
      },
    };
  }

  private canonicalResource(resource?: URL): string {
    const mcp = this.resourceUrl.href.replace(/\/$/, '');
    if (!resource) return mcp;
    const asked = resource.href.split('#')[0].replace(/\/$/, '');
    // Accept the MCP URL itself or the bare origin, which some clients send.
    if (asked === mcp || asked === this.resourceUrl.origin) return mcp;
    throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.canonicalResource(params.resource);
    await this.db.query('DELETE FROM oauth_requests WHERE expires_at < now()');
    const { rows } = await this.db.query(
      `INSERT INTO oauth_requests (client_id, redirect_uri, code_challenge, scopes, state, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
      [client.client_id, params.redirectUri, params.codeChallenge, [SCOPE], params.state ?? null, resource, REQUEST_MINUTES],
    );
    // The consent page signs the user in with their passkey if needed, then asks them to approve.
    res.redirect(302, `/oauth/consent?request=${rows[0].id}`);
  }

  // ---- Consent (called by the web app's API) -----------------------------

  async getPendingAuthorization(requestId: string): Promise<PendingAuthorization> {
    if (!isUuid(requestId)) throw notFound('Authorization request');
    const { rows } = await this.db.query(
      `SELECT r.id, r.redirect_uri, c.info FROM oauth_requests r
       JOIN oauth_clients c ON c.client_id = r.client_id
       WHERE r.id = $1 AND r.expires_at > now()`,
      [requestId],
    );
    if (!rows[0]) throw notFound('Authorization request (it may have expired, start connecting again)');
    return { id: rows[0].id, clientName: clientDisplayName(rows[0].info), redirectHost: new URL(rows[0].redirect_uri).host };
  }

  /** Returns the URL to send the browser back to, carrying either a code or an error. */
  async decide(requestId: string, userId: string, approve: boolean): Promise<string> {
    if (!isUuid(requestId)) throw notFound('Authorization request');
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query(
        'DELETE FROM oauth_requests WHERE id = $1 AND expires_at > now() RETURNING *',
        [requestId],
      );
      const req = rows[0];
      if (!req) throw notFound('Authorization request (it may have expired, start connecting again)');
      const url = new URL(req.redirect_uri);
      if (req.state) url.searchParams.set('state', req.state);
      if (!approve) {
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('error_description', 'The user denied access');
        return url.href;
      }
      const code = newToken('tac_');
      await client.query(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
        [hashToken(code), req.client_id, userId, req.redirect_uri, req.code_challenge, req.scopes, req.resource, CODE_SECONDS],
      );
      url.searchParams.set('code', code);
      // RFC 9207: lets the client confirm which server issued the code.
      url.searchParams.set('iss', this.issuer);
      return url.href;
    });
  }

  // ---- Token endpoint ---------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await this.db.query(
      'SELECT client_id, code_challenge FROM oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [hashToken(code)],
    );
    if (!rows[0] || rows[0].client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return withTransaction(this.db, async (q) => {
      const { rows } = await q.query(
        `UPDATE oauth_codes SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
        [hashToken(code)],
      );
      const row = rows[0];
      if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
      if (resource && this.canonicalResource(resource) !== row.resource) throw new InvalidTargetError('resource does not match');
      return this.issueTokens(q, client.client_id, row.user_id, row.resource);
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return withTransaction(this.db, async (q) => {
      const { rows } = await q.query(
        `SELECT id, client_id, user_id, resource, rotated_at FROM oauth_tokens
         WHERE token_hash = $1 AND kind = 'refresh' AND expires_at > now() AND revoked_at IS NULL
           AND (rotated_at IS NULL OR rotated_at > now() - make_interval(secs => $2))
         FOR UPDATE`,
        [hashToken(refreshToken), REFRESH_GRACE_SECONDS],
      );
      const row = rows[0];
      if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token');
      if (resource && this.canonicalResource(resource) !== row.resource) throw new InvalidTargetError('resource does not match');
      if (!row.rotated_at) await q.query('UPDATE oauth_tokens SET rotated_at = now() WHERE id = $1', [row.id]);
      return this.issueTokens(q, client.client_id, row.user_id, row.resource);
    });
  }

  private async issueTokens(q: Queryable, clientId: string, userId: string, resource: string): Promise<OAuthTokens> {
    const accessToken = newToken('tat_');
    const refreshToken = newToken('trt_');
    await q.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6, now() + make_interval(secs => $7)),
       ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(days => $8))`,
      [hashToken(accessToken), hashToken(refreshToken), clientId, userId, [SCOPE], resource, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_DAYS],
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: SCOPE,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = await this.apiKeys.verify(token);
    if (key) {
      const owner: TokenOwner = { userId: key.userId, sourceName: key.name };
      return {
        token,
        clientId: `api-key:${key.keyId}`,
        scopes: [SCOPE],
        // API keys do not expire; they are revoked from Settings.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: this.resourceUrl,
        extra: { ...owner },
      };
    }
    const { rows } = await this.db.query(
      `SELECT t.user_id, t.client_id, t.scopes, t.resource, t.expires_at, c.info
       FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) throw new InvalidTokenError('Invalid or expired access token');
    const owner: TokenOwner = { userId: row.user_id, sourceName: row.info ? clientDisplayName(row.info) : 'AI app' };
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      resource: new URL(row.resource),
      extra: { ...owner },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const { rows } = await this.db.query(
      'SELECT user_id FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2',
      [hashToken(request.token), client.client_id],
    );
    // Revoking any token disconnects that app from that user entirely.
    if (rows[0]) await this.disconnect(rows[0].user_id, client.client_id);
  }

  // ---- Settings: connected apps -----------------------------------------

  async listConnectedApps(userId: string): Promise<ConnectedApp[]> {
    const { rows } = await this.db.query(
      `SELECT t.client_id, c.info, min(t.created_at) AS connected_at, max(t.created_at) AS last_used_at
       FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.user_id = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.rotated_at IS NULL
         AND t.expires_at > now()
       GROUP BY t.client_id, c.info ORDER BY min(t.created_at)`,
      [userId],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      name: r.info ? clientDisplayName(r.info) : 'AI app',
      connectedAt: new Date(r.connected_at).toISOString(),
      lastUsedAt: new Date(r.last_used_at).toISOString(),
    }));
  }

  async disconnect(userId: string, clientId: string): Promise<void> {
    if (typeof clientId !== 'string' || !clientId) throw badRequest('Missing app id');
    await this.db.query(
      'UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL',
      [userId, clientId],
    );
  }

  async purgeExpired(): Promise<void> {
    await this.db.query(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
    await this.db.query('DELETE FROM oauth_requests WHERE expires_at < now()');
  }
}
