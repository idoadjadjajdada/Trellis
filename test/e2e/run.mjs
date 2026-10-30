// End-to-end check of the web app in a real browser, with a virtual passkey authenticator.
// Usage: start Trellis, then `E2E_URL=http://localhost:3000 node test/e2e/run.mjs [screenshot-dir]`
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Loaded with require so a globally installed Playwright works too (`npm i -g playwright`).
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.E2E_URL ?? 'http://localhost:3000';
const SHOTS = process.argv[2] ?? 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const results = [];
/** The page to screenshot when a step fails. */
let current = null;
async function step(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    failures++;
    await current?.screenshot({ path: `${SHOTS}/FAIL-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png` }).catch(() => {});
    results.push(`FAIL ${name}\n     ${String(err?.message ?? err).split('\n').slice(0, 3).join(' | ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function addAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

function watchErrors(page, label) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.stack}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[134]/.test(m.text())) errors.push(`${label} console: ${m.text()}`);
  });
  return errors;
}

/** Finds a pixel of the given color in a screenshot of the graph and returns page coordinates. */
async function findColor(page, hex) {
  const box = await page.locator('.graph-layer canvas').boundingBox();
  const png = (await page.screenshot({ clip: box })).toString('base64');
  const target = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const hit = await page.evaluate(
    async ({ png, target, box }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let best = null;
      for (let y = 0; y < c.height; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          const i = (y * c.width + x) * 4;
          const d = Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]);
          if (d >= 70 || (best && d >= best.d)) continue;
          // Only pixels of the graph itself, not panels or buttons drawn over it.
          const px = box.x + (x / c.width) * box.width;
          const py = box.y + (y / c.height) * box.height;
          if (document.elementFromPoint(px, py)?.tagName !== 'CANVAS') continue;
          best = { d, x, y, w: c.width, h: c.height };
        }
      }
      return best;
    },
    { png, target, box },
  );
  return hit && { x: box.x + (hit.x / hit.w) * box.width, y: box.y + (hit.y / hit.h) * box.height };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

// ---------------------------------------------------------------- Desktop
const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await desktop.newPage();
current = page;
const errors = watchErrors(page, 'desktop');
const { cdp, authenticatorId } = await addAuthenticator(page);
let recoveryCodes = [];
let apiKey = '';

await step('sign-up with a passkey shows recovery codes', async () => {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Your name').fill('Ada');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
  recoveryCodes = (await page.locator('.codes span').allTextContents()).map((s) => s.trim());
  assert(recoveryCodes.length === 10, `expected 10 codes, got ${recoveryCodes.length}`);
  await page.screenshot({ path: `${SHOTS}/01-recovery-codes.png` });
  await page.getByRole('button', { name: 'I saved my codes' }).click();
  await page.getByText('No notes yet').waitFor();
  await page.screenshot({ path: `${SHOTS}/02-empty.png` });
});

await step('create projects and an API key in Settings', async () => {
  await page.getByRole('link', { name: 'Settings' }).click();
  for (const name of ['Trellis', 'Wedding']) {
    await page.getByLabel('New project name').fill(name);
    await page.getByRole('button', { name: 'Add project' }).click();
    await page.locator('td', { hasText: name }).first().waitFor();
  }
  await page.getByLabel('New key name').fill('Seeder');
  await page.getByRole('button', { name: 'Create key' }).click();
  apiKey = await page.getByLabel('New API key').inputValue();
  assert(apiKey.startsWith('trk_'), 'API key shown once');
  await page.screenshot({ path: `${SHOTS}/03-settings.png`, fullPage: true });
});

const seed = [
  ['Trellis stores project notes as small atoms of one to three sentences.', 'fact', 'Trellis', 0.8],
  ['Atoms are shown as a weighted 3D graph where related atoms sit close together.', 'decision', 'Trellis', 0.9],
  ['Storage is Postgres with the pgvector extension.', 'decision', 'Trellis', 0.8],
  ['The local version runs Postgres and pgvector in Docker.', 'decision', 'Trellis', 0.6],
  ['Sign-in uses passkeys with no passwords.', 'decision', 'Trellis', 0.7],
  ['Recovery codes let a user get back in after losing a passkey device.', 'decision', 'Trellis', 0.5],
  ['The 3D graph uses three.js and the 3d-force-graph library.', 'decision', 'Trellis', 0.6],
  ['The layout is force-directed: linked atoms pull together and all atoms push apart.', 'fact', 'Trellis', 0.5],
  ['Which embedding model should the local version use?', 'question', 'Trellis', 0.5],
  ['Write the README before launch.', 'task', 'Trellis', 0.4],
  ['The wedding venue is booked for June 14.', 'fact', 'Wedding', 0.9],
  ['We need to pick a caterer by March.', 'task', 'Wedding', 0.7],
  ['The caterer must offer vegetarian options.', 'decision', 'Wedding', 0.6],
  ['Maybe hire a string quartet for the ceremony.', 'idea', 'Wedding', 0.3],
  ['Buy a new bike helmet.', 'task', null, 0.3],
];

await step('seed notes through the REST API (real embeddings)', async () => {
  const ids = [];
  for (const [text, type, project, importance] of seed) {
    const res = await fetch(`${BASE}/api/v1/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, type, status: 'decided', project, importance, chat: 'Planning chat' }),
    });
    const body = await res.json();
    assert(res.status === 201, `seed ${text}: ${res.status} ${JSON.stringify(body)}`);
    ids.push(body.atom.id);
  }
  // A changed decision, and one the AI was unsure about.
  const replace = await fetch(`${BASE}/api/v1/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'The wedding venue is booked for June 21.', type: 'fact', status: 'decided', project: 'Wedding', replaces: [ids[10]] }),
  });
  assert(replace.status === 201, 'replace saved');
  const unsure = await fetch(`${BASE}/api/v1/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'The graph could use a dark blue background.', type: 'idea', status: 'proposed', project: 'Trellis', uncertain: true }),
  });
  assert(unsure.status === 201, 'uncertain saved');
  const dup = await fetch(`${BASE}/api/v1/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Storage is Postgres with the pgvector extension!', type: 'decision', status: 'decided', project: 'Trellis' }),
  });
  assert(dup.status === 200 && (await dup.json()).outcome === 'duplicate', 'near-identical note is a duplicate');
});

await step('graph picks up new notes and renders', async () => {
  await page.getByRole('link', { name: 'Graph' }).click();
  // The app polls every 10 seconds; focus triggers an immediate check.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('.topbar .badge').waitFor({ timeout: 15000 });
  await page.waitForTimeout(9000); // let the layout settle and zoom to fit
  await page.screenshot({ path: `${SHOTS}/04-graph-desktop.png` });
  const review = await page.locator('.topbar .badge').textContent();
  assert(review === '1', `review badge shows 1 (got ${review})`);
});

await step('clicking an atom in the graph opens the details panel', async () => {
  const point = await findColor(page, '#4f9dff');
  assert(point, 'found a Trellis atom on screen');
  await page.mouse.click(point.x, point.y);
  await page.getByRole('complementary', { name: 'Note details' }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${SHOTS}/05-details.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('complementary', { name: 'Note details' }).waitFor({ state: 'detached' });
});

await step('search highlights, Notes list filters, and details show connections', async () => {
  await page.keyboard.press('/');
  await page.keyboard.type('passkey');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/06-search.png` });
  await page.getByRole('link', { name: 'Notes' }).click();
  const items = page.locator('.atom-item');
  await items.first().waitFor();
  const texts = await items.allTextContents();
  assert(texts.some((t) => t.includes('Sign-in uses passkeys')), 'search finds the passkey note');
  assert(!texts.some((t) => t.includes('wedding venue')), 'search hides unrelated notes');
  await page.locator('.atom-item', { hasText: 'Sign-in uses passkeys' }).click();
  const panel = page.getByRole('complementary', { name: 'Note details' });
  await panel.waitFor();
  await panel.getByText('Planning chat').waitFor();
  const connected = await panel.locator('.connected-list li').allTextContents();
  assert(connected.some((t) => t.includes('Recovery codes')), `passkeys links to recovery codes (got ${connected.join(' | ')})`);
  await page.screenshot({ path: `${SHOTS}/07-notes.png` });
  await page.getByLabel('Search', { exact: true }).fill('');
});

await step('edit with E, then Delete moves to Trash and Undo restores', async () => {
  await page.locator('.atom-item', { hasText: 'Sign-in uses passkeys' }).click();
  await page.keyboard.press('e');
  const textarea = page.getByRole('complementary', { name: 'Note details' }).locator('textarea');
  await textarea.waitFor();
  await textarea.fill('Sign-in uses passkeys, so there are no passwords at all.');
  await page.getByRole('button', { name: 'Save' }).click();
  await textarea.waitFor({ state: 'detached' });
  await page.getByRole('complementary', { name: 'Note details' }).locator('.atom-big-text', { hasText: 'so there are no passwords at all' }).waitFor();
  await page.keyboard.press('Delete');
  await page.getByText('Moved to Trash.').waitFor();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.atom-item', { hasText: 'no passwords at all' }).waitFor();
});

await step('filters: project checkbox and minimum weight', async () => {
  const before = await page.locator('.atom-item').count();
  await page.getByRole('complementary', { name: 'Projects and filters' }).getByLabel('Wedding').uncheck().catch(async () => {
    await page.locator('.side-panel.left label', { hasText: 'Wedding' }).locator('input').uncheck();
  });
  const after = await page.locator('.atom-item').count();
  assert(after < before, `hiding Wedding hides notes (${before} -> ${after})`);
  await page.locator('.side-panel.left label', { hasText: 'Wedding' }).locator('input').check();
  await page.getByLabel('Minimum weight').fill('0.6');
  const heavy = await page.locator('.atom-item').count();
  assert(heavy < before, `min weight hides light notes (${before} -> ${heavy})`);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert((await page.locator('.atom-item').count()) === before, 'clear filters restores the list');
});

await step('Review page: approve the uncertain note', async () => {
  await page.getByRole('link', { name: /Review/ }).click();
  await page.getByText('dark blue background').waitFor();
  await page.screenshot({ path: `${SHOTS}/08-review.png` });
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Nothing to review.').waitFor();
});

await step('Trash page lists and restores', async () => {
  await page.getByRole('link', { name: 'Notes' }).click();
  await page.locator('.atom-item', { hasText: 'bike helmet' }).click();
  await page.getByRole('complementary', { name: 'Note details' }).getByRole('button', { name: 'Delete' }).click();
  await page.goto(`${BASE}/trash`);
  await page.getByText('bike helmet').waitFor();
  await page.screenshot({ path: `${SHOTS}/09-trash.png` });
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByText('Trash is empty.').waitFor();
});

await step('sign out and sign back in with the passkey', async () => {
  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page.getByRole('link', { name: 'Notes' }).waitFor();
});

await step('OAuth consent page: Allow sends the code back to the AI app', async () => {
  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
  });
  const client = await reg.json();
  await page.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, body: 'callback reached' }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  await page.goto(`${BASE}/authorize?${params}`);
  await page.getByText('wants to search, save and update notes').waitFor();
  await page.screenshot({ path: `${SHOTS}/10-consent.png` });
  await Promise.all([page.waitForURL(/claude\.ai/), page.getByRole('button', { name: 'Allow' }).click()]);
  const url = new URL(page.url());
  assert(url.searchParams.get('code')?.startsWith('tac_') && url.searchParams.get('state') === 'xyz', 'code and state returned');
});

await step('recovery code: sign in, forced to add a passkey, then in', async () => {
  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  // Simulate a lost device: remove all passkeys from the virtual authenticator.
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Add a new passkey' }).waitFor();
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('link', { name: 'Notes' }).waitFor();
  await page.goto(`${BASE}/settings`);
  await page.getByText('9 of 10 codes left.').waitFor();
  assert((await page.locator('section', { hasText: 'Passkeys' }).locator('tr').count()) === 2, 'two passkeys after recovery');
});

errors.length && results.push(...errors.map((e) => `WARN ${e}`));
await desktop.close();

// ---------------------------------------------------------------- iPad portrait
await step('iPad portrait: panels start closed, top bar present', async () => {
  const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
  const p = await ctx.newPage();
  current = p;
  const errs = watchErrors(p, 'ipad');
  await addAuthenticator(p);
  await p.goto(BASE);
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.getByLabel('Your name').fill('Tablet');
  await p.getByRole('button', { name: 'Create passkey' }).click();
  await p.getByRole('button', { name: 'I saved my codes' }).click();
  await p.getByRole('button', { name: 'Open projects and filters' }).waitFor();
  assert((await p.locator('.side-panel').count()) === 0, 'no panel open in portrait');
  const h = await p.locator('.topbar nav a').first().evaluate((el) => el.getBoundingClientRect().height);
  assert(h >= 44, `touch targets at least 44px (got ${h})`);
  await p.screenshot({ path: `${SHOTS}/11-ipad.png` });
  if (errs.length) throw new Error(errs.join('; '));
  await ctx.close();
});

// ---------------------------------------------------------------- Phone
await step('phone: bottom bar, one project, filter sheet, details sheet, swipe review', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  current = p;
  const errs = watchErrors(p, 'phone');
  await addAuthenticator(p);
  await p.goto(BASE);
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.getByLabel('Your name').fill('Phone');
  await p.getByRole('button', { name: 'Create passkey' }).click();
  await p.getByRole('button', { name: 'I saved my codes' }).click();
  for (const label of ['Graph', 'Notes', 'Review', 'Settings']) await p.locator('.bottom-nav').getByRole('link', { name: label }).waitFor();

  // Seed this user's notes through a key made in Settings.
  await p.locator('.bottom-nav').getByRole('link', { name: 'Settings' }).click();
  await p.getByLabel('New project name').fill('Trellis');
  await p.getByRole('button', { name: 'Add project' }).click();
  await p.locator('td', { hasText: 'Trellis' }).first().waitFor();
  await p.getByLabel('New project name').fill('Garden');
  await p.getByRole('button', { name: 'Add project' }).click();
  await p.locator('td', { hasText: 'Garden' }).first().waitFor();
  await p.getByLabel('New key name').fill('Phone seeder');
  await p.getByRole('button', { name: 'Create key' }).click();
  const key = await p.getByLabel('New API key').inputValue();
  const post = (body) =>
    fetch(`${BASE}/api/v1/notes`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [text, project] of [
    ['Storage is Postgres with the pgvector extension.', 'Trellis'],
    ['The local version runs Postgres and pgvector in Docker.', 'Trellis'],
    ['Sign-in uses passkeys with no passwords.', 'Trellis'],
    ['Plant tomatoes after the last frost.', 'Garden'],
  ]) await post({ text, type: 'decision', status: 'decided', project });
  await post({ text: 'Maybe add a pond to the garden.', type: 'idea', status: 'proposed', project: 'Garden', uncertain: true });

  // Reload: with no saved filters, the phone opens on one project (the biggest).
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE);
  await p.getByRole('button', { name: 'Reset view' }).waitFor();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/12-phone-graph.png` });
  await p.getByRole('button', { name: 'Filter' }).click();
  const sheet = p.getByRole('dialog', { name: 'Filter' });
  await sheet.waitFor();
  const gardenChecked = await sheet.locator('label', { hasText: 'Garden' }).locator('input').isChecked();
  const trellisChecked = await sheet.locator('label', { hasText: 'Trellis' }).locator('input').isChecked();
  assert(trellisChecked && !gardenChecked, 'phone opens on the biggest project only');
  await p.screenshot({ path: `${SHOTS}/13-phone-filter.png` });
  await sheet.getByRole('button', { name: 'Done' }).click();

  // Tap an atom (bigger invisible tap area) to open the half-height details sheet.
  const point = await findColor(p, '#4f9dff');
  assert(point, 'found an atom on the phone screen');
  await p.touchscreen.tap(point.x, point.y);
  const details = p.getByRole('dialog', { name: 'Note details' });
  await details.waitFor({ timeout: 5000 });
  for (const b of ['Edit', 'Delete']) await details.getByRole('button', { name: b }).waitFor();
  await details.getByRole('button', { name: /Connected/ }).waitFor();
  await p.screenshot({ path: `${SHOTS}/14-phone-details.png` });
  await details.getByRole('button', { name: /Connected/ }).click();
  await details.getByText('Weight').waitFor(); // expanded to full screen
  await details.getByRole('button', { name: 'Close' }).click();
  await details.waitFor({ state: 'detached' });

  // Long-press an atom: a menu with Edit, Pin and Delete.
  const lp = await findColor(p, '#4f9dff');
  const touch = await ctx.newCDPSession(p);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lp.x, y: lp.y }] });
  await p.waitForTimeout(800);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const menu = p.getByRole('menu');
  await menu.waitFor({ timeout: 3000 });
  for (const item of ['Edit', 'Pin', 'Delete']) await menu.getByRole('menuitem', { name: item }).waitFor();
  await p.screenshot({ path: `${SHOTS}/14b-phone-longpress.png` });
  await menu.getByRole('menuitem', { name: 'Pin' }).click();
  await p.waitForTimeout(800);
  const pinned = await p.evaluate(async () => (await (await fetch('/api/notes')).json()).atoms.filter((a) => a.pinned).length);
  assert(pinned === 1, `long-press Pin pins one atom (got ${pinned})`);

  // Notes screen: searchable list.
  await p.locator('.bottom-nav').getByRole('link', { name: 'Notes' }).click();
  await p.getByLabel('Search notes').fill('docker');
  await p.locator('.atom-item', { hasText: 'Docker' }).waitFor();
  await p.screenshot({ path: `${SHOTS}/15-phone-notes.png` });

  // Review screen: swipe right to approve.
  await p.locator('.bottom-nav').getByRole('link', { name: 'Review' }).click();
  const card = p.locator('.review-card');
  await card.waitFor();
  await p.screenshot({ path: `${SHOTS}/16-phone-review.png` });
  const box = await card.boundingBox();
  const y = box.y + box.height / 2;
  await card.dispatchEvent('pointerdown', { clientX: box.x + 40, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true });
  for (let i = 1; i <= 10; i++) {
    await card.dispatchEvent('pointermove', { clientX: box.x + 40 + i * 25, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true });
  }
  await card.dispatchEvent('pointerup', { clientX: box.x + 290, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true });
  await p.getByText('Nothing to review.').waitFor();
  if (errs.length) throw new Error(errs.join('; '));
  await ctx.close();
});

await browser.close();
console.log(results.join('\n'));
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
