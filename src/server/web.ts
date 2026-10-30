import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Serves the built web app, falling back to index.html for client-side routes. */
export function mountBuiltWeb(app: express.Express) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) throw new Error(`Web app not built: ${index} is missing. Run "npm run build".`);
  app.use(
    express.static(dir, {
      index: false,
      setHeaders(res, file) {
        // Hashed asset names never change; everything else is revalidated.
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}

/** Development: Vite serves the web app with hot reload on the same origin as the API. */
export async function mountDevWeb(app: express.Express) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
