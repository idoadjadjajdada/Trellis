import { expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

it('uses PUBLIC_URL first, then the hosting platform’s address, then localhost', () => {
  expect(loadConfig({}).publicUrl.href).toBe('http://localhost:3000/');
  expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://trellis-x.onrender.com' }).publicUrl.href).toBe('https://trellis-x.onrender.com/');
  expect(loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'trellis.up.railway.app' }).publicUrl.href).toBe('https://trellis.up.railway.app/');
  expect(
    loadConfig({ PUBLIC_URL: 'https://notes.example.com', RENDER_EXTERNAL_URL: 'https://trellis-x.onrender.com' }).publicUrl.href,
  ).toBe('https://notes.example.com/');
});

it('refuses plain http on a public host and paths in PUBLIC_URL', () => {
  expect(() => loadConfig({ PUBLIC_URL: 'http://notes.example.com' })).toThrow(/https/);
  expect(() => loadConfig({ PUBLIC_URL: 'https://notes.example.com/app' })).toThrow(/origin/);
});

it('reads TRUST_PROXY', () => {
  expect(loadConfig({}).trustProxy).toBe('loopback');
  expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
});
