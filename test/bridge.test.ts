import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Db } from '../src/server/db.js';
import { createUser, setupDb, startServer, type TestServer } from './helpers.js';

let db: Db;
let srv: TestServer;

beforeAll(async () => {
  db = await setupDb();
  srv = await startServer(db);
});

afterAll(async () => {
  await srv.close();
  await db.end();
});

it('the stdio bridge lets a desktop MCP client use Trellis with an API key', async () => {
  const userId = await createUser(db, 'Desktop user');
  const { key } = await srv.services.apiKeys.create(userId, 'Claude Desktop');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/server/stdio-bridge.ts'],
    env: { ...process.env, TRELLIS_URL: srv.url, TRELLIS_API_KEY: key } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'desktop-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(['list_projects', 'save_note', 'search_notes', 'update_note']);
  const res = await client.callTool({
    name: 'save_note',
    arguments: { text: 'The local version works with Claude Desktop through a stdio bridge.', type: 'fact', status: 'decided' },
  });
  expect(res.isError).toBeFalsy();
  const atoms = await srv.services.notes.listAtoms(userId);
  expect(atoms).toHaveLength(1);
  expect(atoms[0].sourceAi).toBe('Claude Desktop');
  await client.close();
});
