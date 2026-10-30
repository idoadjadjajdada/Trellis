import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Embedder } from './embeddings.js';
import { AppError, badRequest } from './errors.js';
import { NotesService } from './notes.js';
import { AccountService, type Session } from './auth/accounts.js';
import { ApiKeyService } from './auth/apiKeys.js';
import { SCOPE, TrellisOAuthProvider, type TokenOwner } from './auth/oauth.js';
import { mcpHandler } from './mcp.js';

const SESSION_COOKIE = 'trellis_session';
const CHALLENGE_COOKIE = 'trellis_challenge';

export interface Services {
  notes: NotesService;
  accounts: AccountService;
  apiKeys: ApiKeyService;
  oauth: TrellisOAuthProvider;
}

export function createServices(config: Config, db: Db, embedder: Embedder): Services {
  const apiKeys = new ApiKeyService(db);
  const mcpUrl = new URL('/mcp', config.publicUrl);
  return {
    notes: new NotesService(db, embedder),
    accounts: new AccountService(db, {
      origin: config.publicUrl.origin,
      rpID: config.publicUrl.hostname,
      rpName: 'Trellis',
    }),
    apiKeys,
    oauth: new TrellisOAuthProvider(db, apiKeys, mcpUrl, config.publicUrl.href),
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore malformed cookies.
    }
  }
  return out;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

export interface AppOptions {
  /** Serves the web app: Vite middleware in development, built files in production. */
  mountWeb?: (app: express.Express) => Promise<void> | void;
  /** Disables rate limits (tests). */
  disableRateLimits?: boolean;
}

export async function createApp(config: Config, services: Services, options: AppOptions = {}) {
  const { notes, accounts, apiKeys, oauth } = services;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const secureCookies = config.publicUrl.protocol === 'https:';
  const mcpUrl = new URL('/mcp', config.publicUrl);
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.publicUrl).href;
  const limit = (windowMinutes: number, max: number) =>
    options.disableRateLimits
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : rateLimit({ windowMs: windowMinutes * 60_000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false });

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // The consent page must never be framed (clickjacking).
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- OAuth for the Claude and ChatGPT connectors ------------------------

  const oauthMetadata = {
    ...createOAuthMetadata({ provider: oauth, issuerUrl: config.publicUrl, scopesSupported: [SCOPE] }),
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    authorization_response_iss_parameter_supported: true,
  };
  const protectedResourceMetadata = {
    resource: mcpUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Trellis',
  };
  const cors = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
  // Served before the SDK router so these extended versions win.
  app.get('/.well-known/oauth-authorization-server', cors, (_req, res) => {
    res.json(oauthMetadata);
  });
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors, (_req, res) => {
    res.json(protectedResourceMetadata);
  });

  // The SDK only reads client credentials from the form body; also accept HTTP Basic (RFC 6749 2.3.1).
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }), (req, _res, next) => {
    const header = req.headers.authorization;
    if (header?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
        req.body = { ...(req.body ?? {}) };
        try {
          req.body.client_id ??= decode(decoded.slice(0, i));
          req.body.client_secret ??= decode(decoded.slice(i + 1));
        } catch {
          // Leave the body alone; client authentication fails normally.
        }
      }
    }
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: 'Trellis',
      ...(options.disableRateLimits
        ? {
            authorizationOptions: { rateLimit: false },
            tokenOptions: { rateLimit: false },
            clientRegistrationOptions: { rateLimit: false },
            revocationOptions: { rateLimit: false },
          }
        : {}),
    }),
  );

  // Anything else under /.well-known (e.g. OpenID discovery) is a JSON 404, not the web app.
  app.use('/.well-known', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ---- MCP endpoint -----------------------------------------------------

  const bearer = requireBearerAuth({ verifier: oauth, resourceMetadataUrl, expectedResource: mcpUrl });
  app.options('/mcp', cors);
  app.post('/mcp', cors, bearer, express.json({ limit: '1mb' }), mcpHandler(notes));
  app.all('/mcp', cors, bearer, (_req, res) => {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    res.setHeader('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  // ---- REST API for other integrations (API key) ---------------------------

  const v1 = express.Router();
  v1.use(cors, requireBearerAuth({ verifier: oauth }), express.json({ limit: '100kb' }));
  const ownerOf = (req: Request) => (req as Request & { auth?: { extra?: TokenOwner } }).auth!.extra as TokenOwner;
  v1.get('/projects', async (req, res) => {
    const { userId } = ownerOf(req);
    const [projects, unsorted] = await Promise.all([notes.listProjects(userId), notes.unsortedCount(userId)]);
    res.json({ projects, unsortedCount: unsorted });
  });
  v1.get('/notes/search', async (req, res) => {
    const { userId } = ownerOf(req);
    const results = await notes.search(userId, String(req.query.query ?? req.query.q ?? ''), {
      project: typeof req.query.project === 'string' ? req.query.project : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ results });
  });
  v1.get('/notes/:id', async (req, res) => {
    res.json({ note: await notes.getAtom(ownerOf(req).userId, req.params.id) });
  });
  v1.post('/notes', async (req, res) => {
    const who = ownerOf(req);
    const b = req.body ?? {};
    const result = await notes.saveNote(who.userId, {
      text: b.text,
      type: b.type,
      status: b.status,
      project: b.project,
      uncertain: b.uncertain === true,
      importance: b.importance,
      replaces: b.replaces,
      sourceAi: typeof b.source === 'string' && b.source.trim() ? b.source : who.sourceName,
      sourceChat: b.chat,
    });
    res.status(result.outcome === 'created' ? 201 : 200).json(result);
  });
  v1.patch('/notes/:id', async (req, res) => {
    const b = req.body ?? {};
    const note = await notes.updateNote(ownerOf(req).userId, req.params.id, {
      text: b.text,
      type: b.type,
      status: b.status,
      project: b.project,
      pinned: b.pinned,
      importance: b.importance,
      replaces: b.replaces,
    });
    res.json({ note });
  });
  app.use('/api/v1', v1);

  // ---- Web app API (passkey session cookie) --------------------------------

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // Cookie-authenticated writes must come from our own pages (CSRF defense on top of SameSite=Lax).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.publicUrl.origin) {
        next(new AppError(403, `Requests must come from ${config.publicUrl.origin}`));
        return;
      }
    }
    next();
  });

  const setSessionCookie = (res: Response, token: string, expiresAt: Date) => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  };
  const setChallengeCookie = (res: Response, id: string) => {
    res.cookie(CHALLENGE_COOKIE, id, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/api', maxAge: 5 * 60_000 });
  };
  const takeChallengeCookie = (req: Request, res: Response) => {
    res.clearCookie(CHALLENGE_COOKIE, { path: '/api' });
    return parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
  };

  api.use(async (req, _res, next) => {
    try {
      const session = await accounts.getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (session) req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  });

  // Sign-up and sign-in
  const authLimit = limit(15, 60);
  api.get('/auth/config', (_req, res) => {
    res.json({ allowSignup: config.allowSignup });
  });
  api.post('/auth/register/options', authLimit, async (req, res) => {
    if (!config.allowSignup) throw new AppError(403, 'New accounts are turned off on this server');
    const { options, challengeId } = await accounts.startRegistration(req.body?.displayName);
    setChallengeCookie(res, challengeId);
    res.json(options);
  });
  api.post('/auth/register/verify', authLimit, async (req, res) => {
    if (!config.allowSignup) throw new AppError(403, 'New accounts are turned off on this server');
    const result = await accounts.finishRegistration(takeChallengeCookie(req, res), req.body, req.headers['user-agent']);
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    res.json({ recoveryCodes: result.recoveryCodes });
  });
  api.post('/auth/login/options', authLimit, async (_req, res) => {
    const { options, challengeId } = await accounts.startLogin();
    setChallengeCookie(res, challengeId);
    res.json(options);
  });
  api.post('/auth/login/verify', authLimit, async (req, res) => {
    const result = await accounts.finishLogin(takeChallengeCookie(req, res), req.body);
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    res.json({ ok: true });
  });
  api.post('/auth/recovery', limit(15, 10), async (req, res) => {
    const result = await accounts.useRecoveryCode(req.body?.code);
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    res.json({ ok: true });
  });
  api.post('/auth/logout', async (req, res) => {
    if (req.session) await accounts.deleteSession(req.session.tokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Everything below needs a signed-in user.
  api.use((req, _res, next) => {
    if (!req.session) {
      next(new AppError(401, 'Please sign in'));
      return;
    }
    // A recovery-code session may only add a new passkey.
    const allowed = ['/me', '/passkeys/options', '/passkeys/verify'];
    if (req.session.recovery && !allowed.includes(req.path)) {
      next(new AppError(403, 'Add a new passkey to finish signing in'));
      return;
    }
    next();
  });
  const uid = (req: Request) => req.session!.userId;

  api.get('/me', async (req, res) => {
    res.json(await accounts.me(req.session!));
  });
  api.patch('/me', async (req, res) => {
    await accounts.updateDisplayName(uid(req), req.body?.displayName);
    res.json(await accounts.me(req.session!));
  });

  // Passkeys and recovery
  api.get('/passkeys', async (req, res) => {
    res.json({ passkeys: await accounts.listPasskeys(uid(req)) });
  });
  api.post('/passkeys/options', async (req, res) => {
    const { options, challengeId } = await accounts.startAddPasskey(uid(req));
    setChallengeCookie(res, challengeId);
    res.json(options);
  });
  api.post('/passkeys/verify', async (req, res) => {
    await accounts.finishAddPasskey(req.session!, takeChallengeCookie(req, res), req.body, req.headers['user-agent']);
    res.json({ ok: true });
  });
  api.patch('/passkeys/:id', async (req, res) => {
    await accounts.renamePasskey(uid(req), req.params.id, req.body?.name);
    res.json({ ok: true });
  });
  api.delete('/passkeys/:id', async (req, res) => {
    await accounts.deletePasskey(uid(req), req.params.id);
    res.json({ ok: true });
  });
  api.get('/recovery-codes', async (req, res) => {
    res.json({ remaining: await accounts.recoveryCodesLeft(uid(req)) });
  });
  api.post('/recovery-codes', async (req, res) => {
    res.json({ recoveryCodes: await accounts.replaceRecoveryCodes(uid(req)) });
  });

  // OAuth consent
  api.get('/oauth/requests/:id', async (req, res) => {
    res.json(await oauth.getPendingAuthorization(req.params.id));
  });
  api.post('/oauth/requests/:id', async (req, res) => {
    if (typeof req.body?.approve !== 'boolean') throw badRequest('approve must be true or false');
    res.json({ redirectTo: await oauth.decide(req.params.id, uid(req), req.body.approve) });
  });

  // Connector access
  api.get('/connection', (_req, res) => {
    res.json({ mcpUrl: mcpUrl.href, apiUrl: new URL('/api/v1', config.publicUrl).href });
  });
  api.get('/apps', async (req, res) => {
    res.json({ apps: await oauth.listConnectedApps(uid(req)) });
  });
  api.delete('/apps/:clientId', async (req, res) => {
    await oauth.disconnect(uid(req), req.params.clientId);
    res.json({ ok: true });
  });
  api.get('/keys', async (req, res) => {
    res.json({ keys: await apiKeys.list(uid(req)) });
  });
  api.post('/keys', async (req, res) => {
    res.status(201).json(await apiKeys.create(uid(req), req.body?.name));
  });
  api.delete('/keys/:id', async (req, res) => {
    await apiKeys.revoke(uid(req), req.params.id);
    res.json({ ok: true });
  });

  // Settings
  api.get('/settings', async (req, res) => {
    res.json(await notes.getSettings(uid(req)));
  });
  api.patch('/settings', async (req, res) => {
    res.json(await notes.updateSettings(uid(req), req.body ?? {}));
  });

  // Notes
  api.get('/sync', async (req, res) => {
    res.json(await notes.syncState(uid(req)));
  });
  api.get('/graph', async (req, res) => {
    res.json(await notes.graph(uid(req)));
  });
  api.get('/notes', async (req, res) => {
    const scope = req.query.scope === 'review' || req.query.scope === 'trash' ? req.query.scope : 'live';
    res.json({ atoms: await notes.listAtoms(uid(req), scope) });
  });
  api.get('/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ results: [] });
      return;
    }
    const results = await notes.search(uid(req), q, { limit: 30, includePending: false });
    res.json({ results: results.map((r) => ({ id: r.atom.id, similarity: r.similarity })) });
  });
  api.get('/notes/:id', async (req, res) => {
    res.json({ atom: await notes.getAtom(uid(req), req.params.id) });
  });
  api.patch('/notes/:id', async (req, res) => {
    const b = req.body ?? {};
    const atom = await notes.updateNote(uid(req), req.params.id, {
      text: b.text,
      type: b.type,
      status: b.status,
      project: b.projectId,
      pinned: b.pinned,
    });
    res.json({ atom });
  });
  api.post('/notes/:id/approve', async (req, res) => {
    res.json({ atom: await notes.approve(uid(req), req.params.id) });
  });
  api.delete('/notes/:id', async (req, res) => {
    await notes.trash(uid(req), req.params.id);
    res.json({ ok: true });
  });
  api.post('/notes/:id/restore', async (req, res) => {
    res.json({ atom: await notes.restore(uid(req), req.params.id) });
  });
  api.delete('/trash/:id', async (req, res) => {
    await notes.deleteForever(uid(req), req.params.id);
    res.json({ ok: true });
  });
  api.delete('/trash', async (req, res) => {
    res.json({ deleted: await notes.emptyTrash(uid(req)) });
  });

  // Projects
  api.get('/projects', async (req, res) => {
    const [projects, unsortedCount] = await Promise.all([notes.listProjects(uid(req)), notes.unsortedCount(uid(req))]);
    res.json({ projects, unsortedCount });
  });
  api.post('/projects', async (req, res) => {
    res.status(201).json({ project: await notes.createProject(uid(req), req.body?.name, req.body?.color) });
  });
  api.patch('/projects/:id', async (req, res) => {
    res.json({ project: await notes.updateProject(uid(req), req.params.id, { name: req.body?.name, color: req.body?.color }) });
  });
  api.delete('/projects/:id', async (req, res) => {
    await notes.deleteProject(uid(req), req.params.id);
    res.json({ ok: true });
  });

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Not found')));

  if (options.mountWeb) await options.mountWeb(app);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large' });
      return;
    }
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
