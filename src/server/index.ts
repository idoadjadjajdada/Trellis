import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createEmbedder } from './embeddings.js';
import { createApp, createServices } from './app.js';
import { mountBuiltWeb, mountDevWeb } from './web.js';

const HOUR = 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

  const embedder = createEmbedder(config);
  const services = createServices(config, db, embedder);
  const app = await createApp(config, services, {
    mountWeb: config.isProduction ? mountBuiltWeb : mountDevWeb,
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`Trellis is running at ${config.publicUrl.origin}`);
    console.log(`MCP connector URL: ${new URL('/mcp', config.publicUrl).href}`);
  });

  // Load the embedding model now, then bring any atoms from an older model up to date.
  void (async () => {
    try {
      await embedder.warmUp?.();
      const n = await services.notes.reembedStale();
      if (n) console.log(`[embeddings] re-embedded ${n} note(s) with ${embedder.model}`);
    } catch (err) {
      console.error(`[embeddings] could not load ${embedder.model}:`, (err as Error).message);
    }
  })();

  const cleanUp = async () => {
    try {
      const purged = await services.notes.purgeExpiredTrash();
      if (purged) console.log(`[trash] removed ${purged} note(s) older than 30 days`);
      await services.accounts.purgeExpired();
      await services.oauth.purgeExpired();
    } catch (err) {
      console.error('[cleanup] failed:', (err as Error).message);
    }
  };
  void cleanUp();
  const timer = setInterval(cleanUp, HOUR);

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
