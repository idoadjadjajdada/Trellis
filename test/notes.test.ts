import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db.js';
import { FakeEmbedder } from '../src/server/embeddings.js';
import { NotesService } from '../src/server/notes.js';
import { createUser, setupDb } from './helpers.js';

let db: Db;
let notes: NotesService;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await setupDb();
  notes = new NotesService(db, new FakeEmbedder());
  alice = await createUser(db, 'Alice');
  bob = await createUser(db, 'Bob');
});

afterAll(async () => {
  await db.end();
});

const base = { type: 'decision' as const, status: 'decided' as const };

describe('saving notes', () => {
  it('creates an atom in Unsorted when no project is given', async () => {
    const r = await notes.saveNote(alice, { ...base, text: 'Storage is Postgres with the pgvector extension.' });
    expect(r.outcome).toBe('created');
    expect(r.atom.projectId).toBeNull();
    expect(r.atom.projectName).toBe('Unsorted');
    expect(r.atom.reviewState).toBe('approved');
    expect(r.atom.weight).toBeCloseTo(0.4, 5); // 0.15 + 0.5 * 0.5
  });

  it('raises the weight of a near-identical atom instead of duplicating it', async () => {
    const first = await notes.saveNote(alice, { ...base, text: 'The mobile app uses a bottom bar for navigation.' });
    const again = await notes.saveNote(alice, { ...base, text: 'The mobile app uses a bottom bar for the navigation.' });
    expect(again.outcome).toBe('duplicate');
    expect(again.atom.id).toBe(first.atom.id);
    expect(again.atom.referenceCount).toBe(1);
    expect(again.atom.weight).toBeGreaterThan(first.atom.weight);
    const live = await notes.listAtoms(alice);
    expect(live.filter((a) => a.text.includes('bottom bar'))).toHaveLength(1);
  });

  it('places notes in a named project (case-insensitive) and unknown names in Unsorted', async () => {
    const p = await notes.createProject(alice, 'Wedding');
    const known = await notes.saveNote(alice, { ...base, text: 'The venue is booked for June 14.', project: 'wedding' });
    expect(known.outcome === 'created' && known.projectMatched).toBe(true);
    expect(known.atom.projectId).toBe(p.id);
    const unknown = await notes.saveNote(alice, { ...base, text: 'Catering must be vegetarian.', project: 'Party' });
    expect(unknown.outcome === 'created' && unknown.projectMatched).toBe(false);
    expect(unknown.atom.projectId).toBeNull();
  });

  it('links contradictions as "replaces" and dims the old atom, even when the wording is nearly identical', async () => {
    const old = await notes.saveNote(alice, { ...base, text: 'The launch date is March 3 for the beta release.' });
    const next = await notes.saveNote(alice, {
      ...base,
      text: 'The launch date is March 10 for the beta release.',
      replaces: [old.atom.id],
    });
    expect(next.outcome).toBe('created');
    expect(next.atom.replaces).toEqual([old.atom.id]);
    const oldNow = await notes.getAtom(alice, old.atom.id);
    expect(oldNow.replacedBy).toEqual([next.atom.id]);
    // When both versions match about equally, search puts the current one first.
    const [first] = await notes.search(alice, 'launch date for the beta release');
    expect(first.atom.id).toBe(next.atom.id);
  });

  it('rejects replaces ids that are not the user’s notes', async () => {
    const bobs = await notes.saveNote(bob, { ...base, text: 'Bob prefers tabs over spaces in the codebase.' });
    await expect(
      notes.saveNote(alice, { ...base, text: 'Alice prefers spaces.', replaces: [bobs.atom.id] }),
    ).rejects.toThrow(/replaces/);
  });

  it('sends uncertain notes to Review, and approval makes them live', async () => {
    const r = await notes.saveNote(alice, { ...base, text: 'Maybe use Redis for caching search results.', uncertain: true });
    expect(r.atom.reviewState).toBe('pending');
    expect((await notes.listAtoms(alice, 'review')).map((a) => a.id)).toContain(r.atom.id);
    expect((await notes.listAtoms(alice, 'live')).map((a) => a.id)).not.toContain(r.atom.id);
    expect((await notes.syncState(alice)).reviewCount).toBe(1);
    await notes.approve(alice, r.atom.id);
    expect((await notes.listAtoms(alice, 'live')).map((a) => a.id)).toContain(r.atom.id);
  });

  it('validates input', async () => {
    await expect(notes.saveNote(alice, { ...base, text: '   ' })).rejects.toThrow(/required/);
    await expect(notes.saveNote(alice, { ...base, text: 'x'.repeat(1001) })).rejects.toThrow(/too long/);
    await expect(notes.saveNote(alice, { ...base, type: 'rant' as never, text: 'Hello there.' })).rejects.toThrow(/Type/);
    await expect(notes.saveNote(alice, { ...base, text: 'Hi.', importance: 3 })).rejects.toThrow(/Importance/);
  });
});

describe('editing, trash and restore', () => {
  it('re-embeds on text edit so search finds the new wording', async () => {
    const r = await notes.saveNote(alice, { ...base, text: 'Use a red color scheme for the landing page.' });
    await notes.updateNote(alice, r.atom.id, { text: 'Use a green palette with serif typography.' });
    const [top] = await notes.search(alice, 'green palette serif typography');
    expect(top.atom.id).toBe(r.atom.id);
    expect(top.similarity).toBeGreaterThan(0.7);
  });

  it('moves to Trash, restores, and deletes forever', async () => {
    const r = await notes.saveNote(alice, { ...base, text: 'Remove this note about penguins later.' });
    await notes.trash(alice, r.atom.id);
    expect((await notes.listAtoms(alice, 'live')).map((a) => a.id)).not.toContain(r.atom.id);
    expect((await notes.listAtoms(alice, 'trash')).map((a) => a.id)).toContain(r.atom.id);
    await notes.restore(alice, r.atom.id);
    expect((await notes.listAtoms(alice, 'live')).map((a) => a.id)).toContain(r.atom.id);
    await notes.trash(alice, r.atom.id);
    await notes.deleteForever(alice, r.atom.id);
    await expect(notes.getAtom(alice, r.atom.id)).rejects.toThrow(/not found/);
  });

  it('purges atoms that have been in Trash for more than 30 days', async () => {
    const r = await notes.saveNote(alice, { ...base, text: 'An old note about walruses in the trash.' });
    await notes.trash(alice, r.atom.id);
    await db.query(`UPDATE atoms SET deleted_at = now() - interval '31 days' WHERE id = $1`, [r.atom.id]);
    const fresh = await notes.saveNote(alice, { ...base, text: 'A recent note about otters in the trash.' });
    await notes.trash(alice, fresh.atom.id);
    expect(await notes.purgeExpiredTrash()).toBe(1);
    await expect(notes.getAtom(alice, r.atom.id)).rejects.toThrow(/not found/);
    expect((await notes.getAtom(alice, fresh.atom.id)).deletedAt).not.toBeNull();
  });

  it('deleting a project moves its atoms to Unsorted', async () => {
    const p = await notes.createProject(alice, 'Temporary');
    const r = await notes.saveNote(alice, { ...base, text: 'A note in a temporary project about kites.', project: 'Temporary' });
    await notes.deleteProject(alice, p.id);
    expect((await notes.getAtom(alice, r.atom.id)).projectId).toBeNull();
  });

  it('refuses the reserved Unsorted name and duplicate project names', async () => {
    await expect(notes.createProject(alice, 'unsorted')).rejects.toThrow(/reserved/);
    await notes.createProject(alice, 'Garden');
    await expect(notes.createProject(alice, 'GARDEN')).rejects.toThrow(/already exists/);
  });
});

describe('isolation between users', () => {
  it('never shows or changes another user’s atoms', async () => {
    const secret = await notes.saveNote(alice, { ...base, text: 'Alice secret plan about the surprise party.' });
    expect((await notes.listAtoms(bob)).map((a) => a.id)).not.toContain(secret.atom.id);
    expect((await notes.search(bob, 'Alice secret plan about the surprise party')).map((r) => r.atom.id)).not.toContain(
      secret.atom.id,
    );
    await expect(notes.getAtom(bob, secret.atom.id)).rejects.toThrow(/not found/);
    await expect(notes.updateNote(bob, secret.atom.id, { text: 'hacked' })).rejects.toThrow(/not found/);
    await expect(notes.trash(bob, secret.atom.id)).rejects.toThrow(/not found/);
    await expect(notes.approve(bob, secret.atom.id)).rejects.toThrow(/not found/);
    const graph = await notes.graph(bob);
    expect(graph.atoms.map((a) => a.id)).not.toContain(secret.atom.id);
    // Bob saving the same text creates his own atom rather than bumping Alice's.
    const bobs = await notes.saveNote(bob, { ...base, text: 'Alice secret plan about the surprise party.' });
    expect(bobs.outcome).toBe('created');
    expect((await notes.getAtom(alice, secret.atom.id)).referenceCount).toBe(0);
  });

  it('keeps project names per user', async () => {
    const a = await notes.createProject(alice, 'Shared name');
    const b = await notes.createProject(bob, 'Shared name');
    expect(a.id).not.toBe(b.id);
    await expect(notes.updateProject(bob, a.id, { name: 'Mine now' })).rejects.toThrow(/not found/);
    await expect(notes.deleteProject(bob, a.id)).rejects.toThrow(/not found/);
  });
});

describe('graph', () => {
  it('links similar atoms above the threshold, adds replaces links, and leaves out pending atoms', async () => {
    const carol = await createUser(db, 'Carol');
    await notes.updateSettings(carol, { linkThreshold: 0.5 });
    const a = await notes.saveNote(carol, { ...base, text: 'Sign in uses passkeys with no passwords at all.' });
    const b = await notes.saveNote(carol, { ...base, text: 'Passkeys mean users sign in with no passwords.' });
    const c = await notes.saveNote(carol, { ...base, text: 'The garden needs tomatoes and basil this spring.' });
    const d = await notes.saveNote(carol, { ...base, text: 'Recovery codes cover lost passkey devices.', replaces: [a.atom.id] });
    const pending = await notes.saveNote(carol, { ...base, text: 'Maybe add dark mode toggle.', uncertain: true });

    const graph = await notes.graph(carol);
    const ids = graph.atoms.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([a.atom.id, b.atom.id, c.atom.id, d.atom.id]));
    expect(ids).not.toContain(pending.atom.id);

    const has = (s: string, t: string, kind: string) =>
      graph.links.some((l) => l.kind === kind && ((l.source === s && l.target === t) || (l.source === t && l.target === s)));
    expect(has(a.atom.id, b.atom.id, 'similar')).toBe(true);
    expect(has(a.atom.id, c.atom.id, 'similar')).toBe(false);
    expect(has(d.atom.id, a.atom.id, 'replaces')).toBe(true);
    for (const l of graph.links.filter((x) => x.kind === 'similar')) expect(l.similarity).toBeGreaterThanOrEqual(0.5);

    // Raising the threshold removes weaker links (and the cache notices).
    await notes.updateSettings(carol, { linkThreshold: 0.99 });
    const strict = await notes.graph(carol);
    expect(strict.links.filter((l) => l.kind === 'similar')).toHaveLength(0);
  });

  it('bumps the sync version on every change', async () => {
    const v1 = (await notes.syncState(alice)).version;
    const r = await notes.saveNote(alice, { ...base, text: 'A brand new note about lighthouses.' });
    const v2 = (await notes.syncState(alice)).version;
    expect(v2).not.toBe(v1);
    await notes.updateNote(alice, r.atom.id, { pinned: true });
    expect((await notes.syncState(alice)).version).not.toBe(v2);
  });

  it('re-embeds atoms from another model', async () => {
    await db.query(`UPDATE atoms SET embedding_model = 'old-model' WHERE user_id = $1`, [alice]);
    const n = await notes.reembedStale();
    expect(n).toBeGreaterThan(0);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM atoms WHERE embedding_model <> 'fake-64'`);
    expect(rows[0].n).toBe(0);
  });
});
