import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Db } from '../src/server/db.js';
import { createUser, sessionCookie, setupDb, startServer, type TestServer } from './helpers.js';

let db: Db;
let srv: TestServer;
let userId: string;
let cookie: string;

beforeAll(async () => {
  db = await setupDb();
  srv = await startServer(db);
  userId = await createUser(db, 'Connector user');
  cookie = await sessionCookie(srv.services, userId);
});

afterAll(async () => {
  await srv.close();
  await db.end();
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(body: Record<string, unknown> = {}) {
  const res = await fetch(`${srv.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'client_secret_post', ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

/** Runs the browser part of the flow: authorize → consent page → approve. Returns the redirect URL. */
async function authorize(clientId: string, challenge: string, approve = true, clientName = 'Claude') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: `${srv.url}/mcp`,
    scope: 'notes',
  });
  const res = await fetch(`${srv.url}/authorize?${params}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get('location')!, srv.url);
  expect(consent.pathname).toBe('/oauth/consent');
  const requestId = consent.searchParams.get('request')!;

  const info = await fetch(`${srv.url}/api/oauth/requests/${requestId}`, { headers: { cookie } });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ clientName, redirectHost: 'claude.ai' });

  const decision = await fetch(`${srv.url}/api/oauth/requests/${requestId}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: srv.url },
    body: JSON.stringify({ approve }),
  });
  expect(decision.status).toBe(200);
  return new URL(((await decision.json()) as { redirectTo: string }).redirectTo);
}

async function token(body: Record<string, string>, basic?: { id: string; secret: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
  const res = await fetch(`${srv.url}/token`, { method: 'POST', headers, body: new URLSearchParams(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function mcpClient(bearer: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}

const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('discovery', () => {
  it('serves protected resource metadata at both well-known paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(srv.url + path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: `${srv.url}/mcp`, authorization_servers: [`${srv.url}/`] });
    }
  });

  it('serves authorization server metadata with DCR and PKCE', async () => {
    const meta = (await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(meta.issuer).toBe(`${srv.url}/`);
    expect(meta.registration_endpoint).toBe(`${srv.url}/register`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
  });

  it('answers unknown discovery documents with a JSON 404', async () => {
    const res = await fetch(`${srv.url}/.well-known/openid-configuration`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('answers unauthenticated MCP requests with 401 and a resource_metadata pointer', async () => {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${srv.url}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe('OAuth + MCP end to end', () => {
  let accessToken = '';
  let refreshToken = '';
  let client: { client_id: string; client_secret?: string };

  it('registers, authorizes with PKCE, and exchanges the code (client_secret_basic)', async () => {
    client = await registerClient();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('state-123');
    expect(redirect.searchParams.get('iss')).toBe(`${srv.url}/`);
    const code = redirect.searchParams.get('code')!;

    const bad = await token(
      { grant_type: 'authorization_code', code, code_verifier: 'wrong'.repeat(10), redirect_uri: REDIRECT },
      { id: client.client_id, secret: client.client_secret! },
    );
    expect(bad.status).toBe(400);

    const ok = await token(
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${srv.url}/mcp` },
      { id: client.client_id, secret: client.client_secret! },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'notes' });
    accessToken = ok.body.access_token;
    refreshToken = ok.body.refresh_token;

    // Codes are single use.
    const reuse = await token(
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT },
      { id: client.client_id, secret: client.client_secret! },
    );
    expect(reuse.status).toBe(400);
  });

  it('exposes the four tools and saves through them', async () => {
    const mcp = await mcpClient(accessToken);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_projects', 'save_note', 'search_notes', 'update_note']);
    expect(tools.find((t) => t.name === 'save_note')!.title).toBe('Save note');
    expect(tools.find((t) => t.name === 'save_note')!.description).toMatch(/DO NOT SAVE/);

    await srv.services.notes.createProject(userId, 'Trellis');
    const projects = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(text(projects)).toContain('"name": "Trellis"');
    expect(text(projects)).toContain('"name": "Unsorted"');

    const saved = await mcp.callTool({
      name: 'save_note',
      arguments: { text: 'Trellis stores notes in Postgres with pgvector.', type: 'decision', status: 'decided', project: 'Trellis', chat: 'Planning' },
    });
    expect(saved.isError).toBeFalsy();
    expect(text(saved)).toContain('Saved to Trellis.');
    const id = JSON.parse(text(saved).slice(text(saved).indexOf('{'))).id as string;
    const atom = await srv.services.notes.getAtom(userId, id);
    expect(atom.sourceAi).toBe('Claude');
    expect(atom.sourceChat).toBe('Planning');

    const dup = await mcp.callTool({
      name: 'save_note',
      arguments: { text: 'Trellis stores the notes in Postgres with pgvector.', type: 'decision', status: 'decided' },
    });
    expect(text(dup)).toContain('Already saved');

    const unsure = await mcp.callTool({
      name: 'save_note',
      arguments: { text: 'Maybe the graph should glow at night.', type: 'idea', status: 'proposed', project: 'Nope', uncertain: true },
    });
    expect(text(unsure)).toContain('Review page');
    expect(text(unsure)).toContain('no project named "Nope"');

    const found = await mcp.callTool({ name: 'search_notes', arguments: { query: 'Postgres pgvector' } });
    expect(text(found)).toContain(id);

    const updated = await mcp.callTool({ name: 'update_note', arguments: { id, status: 'proposed', pinned: true } });
    expect(updated.isError).toBeFalsy();
    expect((await srv.services.notes.getAtom(userId, id)).pinned).toBe(true);

    const invalid = await mcp.callTool({ name: 'update_note', arguments: { id, project: 'Nope' } });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('No project named');
    await mcp.close();
  });

  it('rotates refresh tokens with a short grace period, and disconnecting revokes everything', async () => {
    const first = await token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, client_secret: client.client_secret! });
    expect(first.status).toBe(200);
    // A retry with the just-rotated token still works (dropped response).
    const retry = await token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, client_secret: client.client_secret! });
    expect(retry.status).toBe(200);
    // ...but not once the grace period is over.
    await db.query(`UPDATE oauth_tokens SET rotated_at = now() - interval '2 minutes' WHERE rotated_at IS NOT NULL`);
    const late = await token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, client_secret: client.client_secret! });
    expect(late.status).toBe(400);

    const apps = await (await fetch(`${srv.url}/api/apps`, { headers: { cookie } })).json();
    expect(apps.apps).toHaveLength(1);
    expect(apps.apps[0].name).toBe('Claude');

    const del = await fetch(`${srv.url}/api/apps/${encodeURIComponent(client.client_id)}`, {
      method: 'DELETE',
      headers: { cookie, origin: srv.url },
    });
    expect(del.status).toBe(200);
    const after = await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id, client_secret: client.client_secret! });
    expect(after.status).toBe(400);
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('supports public clients (token_endpoint_auth_method none) and denial', async () => {
    const pub = await registerClient({ token_endpoint_auth_method: 'none', client_name: 'ChatGPT' });
    expect(pub.client_secret).toBeUndefined();
    const { challenge } = pkce();
    const denied = await authorize(pub.client_id, challenge, false, 'ChatGPT');
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('state')).toBe('state-123');

    const { verifier, challenge: c2 } = pkce();
    const approved = await authorize(pub.client_id, c2, true, 'ChatGPT');
    const res = await token({
      grant_type: 'authorization_code',
      code: approved.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: pub.client_id,
    });
    expect(res.status).toBe(200);
    const mcp = await mcpClient(res.body.access_token);
    expect((await mcp.listTools()).tools).toHaveLength(4);
    await mcp.close();
  });

  it('rejects unsafe redirect URIs at registration', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)']) {
      const res = await fetch(`${srv.url}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a resource that is not this server', async () => {
    const c = await registerClient();
    const params = new URLSearchParams({
      response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge,
      code_challenge_method: 'S256', resource: 'https://other.example/mcp',
    });
    const res = await fetch(`${srv.url}/authorize?${params}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });
});

describe('API keys and the REST API', () => {
  it('creates a key, uses it for REST and MCP, and revokes it', async () => {
    const created = await fetch(`${srv.url}/api/keys`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: srv.url },
      body: JSON.stringify({ name: 'Claude Desktop' }),
    });
    expect(created.status).toBe(201);
    const { key, info } = (await created.json()) as { key: string; info: { id: string } };
    expect(key.startsWith('trk_')).toBe(true);

    const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const post = await fetch(`${srv.url}/api/v1/notes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'The REST API accepts API keys for scripts.', type: 'fact', status: 'decided' }),
    });
    expect(post.status).toBe(201);
    const saved = (await post.json()) as { atom: { id: string; sourceAi: string } };
    expect(saved.atom.sourceAi).toBe('Claude Desktop');

    const search = await fetch(`${srv.url}/api/v1/notes/search?query=${encodeURIComponent('REST API keys')}`, { headers: auth });
    expect(((await search.json()) as any).results[0].atom.id).toBe(saved.atom.id);

    const patch = await fetch(`${srv.url}/api/v1/notes/${saved.atom.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ type: 'decision' }) });
    expect(((await patch.json()) as any).note.type).toBe('decision');

    const mcp = await mcpClient(key);
    expect((await mcp.listTools()).tools).toHaveLength(4);
    await mcp.close();

    await fetch(`${srv.url}/api/keys/${info.id}`, { method: 'DELETE', headers: { cookie, origin: srv.url } });
    const after = await fetch(`${srv.url}/api/v1/projects`, { headers: auth });
    expect(after.status).toBe(401);
  });
});

describe('web API protections', () => {
  it('requires a session', async () => {
    expect((await fetch(`${srv.url}/api/graph`)).status).toBe(401);
  });

  it('blocks cross-site writes', async () => {
    const res = await fetch(`${srv.url}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Evil' }),
    });
    expect(res.status).toBe(403);
  });

  it('limits a recovery-code session to adding a passkey', async () => {
    const [code] = await srv.services.accounts.replaceRecoveryCodes(userId);
    const res = await fetch(`${srv.url}/api/auth/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.url },
      body: JSON.stringify({ code: code.toUpperCase().replace(/-/g, ' ') }),
    });
    expect(res.status).toBe(200);
    const recoveryCookie = res.headers.get('set-cookie')!.split(';')[0];
    const me = await (await fetch(`${srv.url}/api/me`, { headers: { cookie: recoveryCookie } })).json();
    expect(me.recovery).toBe(true);
    expect((await fetch(`${srv.url}/api/graph`, { headers: { cookie: recoveryCookie } })).status).toBe(403);
    expect((await fetch(`${srv.url}/api/passkeys/options`, { method: 'POST', headers: { cookie: recoveryCookie, origin: srv.url } })).status).toBe(200);
    // The code is single use.
    const again = await fetch(`${srv.url}/api/auth/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.url },
      body: JSON.stringify({ code }),
    });
    expect(again.status).toBe(401);
  });

  it('returns the graph for the signed-in user', async () => {
    const res = await fetch(`${srv.url}/api/graph`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const g = (await res.json()) as { atoms: unknown[]; projects: unknown[] };
    expect(g.atoms.length).toBeGreaterThan(0);
  });
});
