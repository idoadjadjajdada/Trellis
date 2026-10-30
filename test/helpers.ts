import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig, type Config } from '../src/server/config.js';
import { createPool, migrate, type Db } from '../src/server/db.js';
import { FakeEmbedder } from '../src/server/embeddings.js';
import { createApp, createServices, type Services } from '../src/server/app.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trellis_test';

export async function setupDb(): Promise<Db> {
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  return db;
}

export async function createUser(db: Db, name = 'Test user'): Promise<string> {
  const { rows } = await db.query('INSERT INTO users (display_name, webauthn_user_id) VALUES ($1, $2) RETURNING id', [
    name,
    randomBytes(32),
  ]);
  return rows[0].id;
}

export interface TestServer {
  url: string;
  config: Config;
  services: Services;
  db: Db;
  close(): Promise<void>;
}

/** Starts the real app on a random port with the fake embedder. */
export async function startServer(db: Db): Promise<TestServer> {
  // The public URL must match the port, so listen first, then build the app.
  const { createServer } = await import('node:http');
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig({ PUBLIC_URL: `http://localhost:${port}`, EMBEDDING_PROVIDER: 'fake', DATABASE_URL: TEST_DB_URL });
  const services = createServices(config, db, new FakeEmbedder());
  const app = await createApp(config, services, { disableRateLimits: true });
  server.on('request', app);
  return {
    url: `http://localhost:${port}`,
    config,
    services,
    db,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A signed-in browser session cookie for a user. */
export async function sessionCookie(services: Services, userId: string): Promise<string> {
  const { token } = await services.accounts.createSession(userId);
  return `trellis_session=${token}`;
}
