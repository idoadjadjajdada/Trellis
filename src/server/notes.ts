import type pg from 'pg';
import { withTransaction, type Db, type Queryable } from './db.js';
import { toVectorLiteral, type Embedder } from './embeddings.js';
import { AppError, badRequest, isUuid, notFound } from './errors.js';
import {
  ATOM_STATUSES,
  ATOM_TYPES,
  UNSORTED,
  type Atom,
  type AtomStatus,
  type AtomType,
  type GraphData,
  type GraphLink,
  type Project,
  type Settings,
  type SyncState,
} from '../shared/types.js';

export const TRASH_DAYS = 30;
/** Each atom links to at most this many of its most similar atoms, so the graph never turns into a hairball. */
const MAX_LINKS_PER_ATOM = 8;
export const MAX_TEXT_LENGTH = 1000;

export const PROJECT_COLORS = [
  '#4f9dff', '#f5a524', '#3ccf91', '#e5484d', '#a78bfa', '#22c3d6',
  '#f472b6', '#a3e635', '#fb923c', '#2dd4bf', '#facc15', '#818cf8',
];

export interface SaveNoteInput {
  text: string;
  type: AtomType;
  status: AtomStatus;
  /** Project name. Unknown or missing names go to Unsorted. */
  project?: string | null;
  /** Uncertain notes wait on the Review page instead of saving straight away. */
  uncertain?: boolean;
  /** AI-rated importance, 0..1. */
  importance?: number;
  sourceAi?: string | null;
  sourceChat?: string | null;
  /** Ids of older atoms this one contradicts and replaces. */
  replaces?: string[];
}

export type SaveNoteResult =
  | { outcome: 'created'; atom: Atom; projectMatched: boolean }
  | { outcome: 'duplicate'; atom: Atom; similarity: number };

export interface UpdateNoteInput {
  text?: string;
  type?: AtomType;
  status?: AtomStatus;
  /** Project name or id; null or "Unsorted" moves the atom to Unsorted. */
  project?: string | null;
  pinned?: boolean;
  importance?: number;
  /** Ids of older atoms this one replaces (added to any existing ones). */
  replaces?: string[];
}

export interface SearchResult {
  atom: Atom;
  similarity: number;
}

type AtomScope = 'live' | 'review' | 'trash';

// Columns for building an Atom. Never selects the embedding, which is large.
const ATOM_SELECT = `
  SELECT a.id, a.text, a.type, a.status, a.review_state, a.project_id, p.name AS project_name,
         a.source_ai, a.source_chat, a.pinned, a.ai_score, a.reference_count, a.weight,
         a.created_at, a.updated_at, a.deleted_at,
         COALESCE((SELECT array_agg(r.old_atom_id ORDER BY r.created_at) FROM replacements r
                   JOIN atoms o ON o.id = r.old_atom_id
                   WHERE r.new_atom_id = a.id AND o.deleted_at IS NULL), '{}') AS replaces,
         COALESCE((SELECT array_agg(r.new_atom_id ORDER BY r.created_at) FROM replacements r
                   JOIN atoms n ON n.id = r.new_atom_id
                   WHERE r.old_atom_id = a.id AND n.deleted_at IS NULL AND n.review_state = 'approved'), '{}') AS replaced_by
  FROM atoms a
  LEFT JOIN projects p ON p.id = a.project_id`;

function toAtom(row: Record<string, any>): Atom {
  return {
    id: row.id,
    text: row.text,
    type: row.type,
    status: row.status,
    reviewState: row.review_state,
    projectId: row.project_id,
    projectName: row.project_name ?? UNSORTED,
    sourceAi: row.source_ai,
    sourceChat: row.source_chat,
    pinned: row.pinned,
    aiScore: Number(row.ai_score),
    referenceCount: Number(row.reference_count),
    weight: Number(row.weight),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    replaces: row.replaces ?? [],
    replacedBy: row.replaced_by ?? [],
  };
}

function cleanText(text: unknown): string {
  if (typeof text !== 'string') throw badRequest('Text is required');
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) throw badRequest('Text is required');
  if (t.length > MAX_TEXT_LENGTH) throw badRequest(`Text is too long (max ${MAX_TEXT_LENGTH} characters). Split it into separate notes.`);
  return t;
}

function checkType(type: unknown): AtomType {
  if (!ATOM_TYPES.includes(type as AtomType)) throw badRequest(`Type must be one of: ${ATOM_TYPES.join(', ')}`);
  return type as AtomType;
}

function checkStatus(status: unknown): AtomStatus {
  if (!ATOM_STATUSES.includes(status as AtomStatus)) throw badRequest(`Status must be one of: ${ATOM_STATUSES.join(', ')}`);
  return status as AtomStatus;
}

function checkScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw badRequest('Importance must be a number from 0 to 1');
  return n;
}

function checkIds(ids: unknown, field: string): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || !ids.every(isUuid)) throw badRequest(`${field} must be a list of note ids`);
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

const trimOrNull = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export class NotesService {
  // Similarity links are the slowest query; cache them per user until something changes.
  private linkCache = new Map<string, GraphLink[]>();

  constructor(
    private db: Db,
    private embedder: Embedder,
  ) {}

  get embeddingModel() {
    return this.embedder.model;
  }

  private async embedOne(text: string): Promise<string> {
    let v: number[];
    try {
      [v] = await this.embedder.embed([text]);
    } catch (err) {
      console.error('[embeddings] failed:', (err as Error).message);
      throw new AppError(503, 'Trellis could not process the text right now (the embedding model may still be loading). Try again in a minute.');
    }
    return toVectorLiteral(v);
  }

  // ---- Settings ---------------------------------------------------------

  async getSettings(userId: string): Promise<Settings> {
    const { rows } = await this.db.query(
      'SELECT duplicate_threshold, link_threshold FROM users WHERE id = $1',
      [userId],
    );
    if (!rows[0]) throw notFound('User');
    return { duplicateThreshold: Number(rows[0].duplicate_threshold), linkThreshold: Number(rows[0].link_threshold) };
  }

  async updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings(userId);
    const next = { ...current };
    for (const key of ['duplicateThreshold', 'linkThreshold'] as const) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < 0.3 || n > 1) throw badRequest('Thresholds must be between 0.3 and 1');
      next[key] = Math.round(n * 1000) / 1000;
    }
    await this.db.query('UPDATE users SET duplicate_threshold = $2, link_threshold = $3 WHERE id = $1', [
      userId,
      next.duplicateThreshold,
      next.linkThreshold,
    ]);
    return next;
  }

  // ---- Projects ---------------------------------------------------------

  async listProjects(userId: string): Promise<Project[]> {
    const { rows } = await this.db.query(
      `SELECT p.id, p.name, p.color,
              (SELECT count(*) FROM atoms a
               WHERE a.project_id = p.id AND a.deleted_at IS NULL AND a.review_state = 'approved')::int AS atom_count
       FROM projects p WHERE p.user_id = $1 ORDER BY lower(p.name)`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, atomCount: r.atom_count }));
  }

  async unsortedCount(userId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM atoms
       WHERE user_id = $1 AND project_id IS NULL AND deleted_at IS NULL AND review_state = 'approved'`,
      [userId],
    );
    return rows[0].n;
  }

  private validateProjectName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('Project name is required');
    const n = name.replace(/\s+/g, ' ').trim();
    if (n.length > 80) throw badRequest('Project name is too long (max 80 characters)');
    if (n.toLowerCase() === UNSORTED.toLowerCase()) throw badRequest(`"${UNSORTED}" is reserved`);
    return n;
  }

  private validateColor(color: unknown): string {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest('Color must look like #4f9dff');
    return color.toLowerCase();
  }

  async createProject(userId: string, name: unknown, color?: unknown): Promise<Project> {
    const clean = this.validateProjectName(name);
    let chosen: string;
    if (color !== undefined && color !== null && color !== '') {
      chosen = this.validateColor(color);
    } else {
      const { rows } = await this.db.query('SELECT color FROM projects WHERE user_id = $1', [userId]);
      const used = new Set(rows.map((r) => r.color));
      chosen = PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[rows.length % PROJECT_COLORS.length];
    }
    try {
      const { rows } = await this.db.query(
        'INSERT INTO projects (user_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color',
        [userId, clean, chosen],
      );
      return { ...rows[0], atomCount: 0 };
    } catch (err) {
      if ((err as pg.DatabaseError).code === '23505') throw new AppError(409, `A project named "${clean}" already exists`);
      throw err;
    }
  }

  async updateProject(userId: string, projectId: string, patch: { name?: unknown; color?: unknown }): Promise<Project> {
    if (!isUuid(projectId)) throw notFound('Project');
    const sets: string[] = [];
    const params: unknown[] = [userId, projectId];
    if (patch.name !== undefined) {
      params.push(this.validateProjectName(patch.name));
      sets.push(`name = $${params.length}`);
    }
    if (patch.color !== undefined) {
      params.push(this.validateColor(patch.color));
      sets.push(`color = $${params.length}`);
    }
    if (sets.length) {
      try {
        const { rowCount } = await this.db.query(
          `UPDATE projects SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2`,
          params,
        );
        if (!rowCount) throw notFound('Project');
      } catch (err) {
        if ((err as pg.DatabaseError).code === '23505') throw new AppError(409, 'A project with that name already exists');
        throw err;
      }
    }
    const project = (await this.listProjects(userId)).find((p) => p.id === projectId);
    if (!project) throw notFound('Project');
    return project;
  }

  /** Deletes a project. Its atoms move to Unsorted; nothing is lost. */
  async deleteProject(userId: string, projectId: string): Promise<void> {
    if (!isUuid(projectId)) throw notFound('Project');
    const { rowCount } = await this.db.query('DELETE FROM projects WHERE user_id = $1 AND id = $2', [userId, projectId]);
    if (!rowCount) throw notFound('Project');
  }

  /** Finds a project by name (case-insensitive) or id. Returns null for Unsorted. */
  private async findProject(q: Queryable, userId: string, nameOrId: string | null | undefined) {
    if (nameOrId === null || nameOrId === undefined) return { id: null, matched: true };
    const value = String(nameOrId).replace(/\s+/g, ' ').trim();
    if (!value || value.toLowerCase() === UNSORTED.toLowerCase()) return { id: null, matched: true };
    const { rows } = await q.query(
      `SELECT id FROM projects WHERE user_id = $1 AND (lower(name) = lower($2) OR id::text = lower($2)) LIMIT 1`,
      [userId, value],
    );
    return rows[0] ? { id: rows[0].id as string, matched: true } : { id: null, matched: false };
  }

  // ---- Reading atoms ----------------------------------------------------

  async getAtom(userId: string, id: string, q: Queryable = this.db): Promise<Atom> {
    if (!isUuid(id)) throw notFound();
    const { rows } = await q.query(`${ATOM_SELECT} WHERE a.user_id = $1 AND a.id = $2`, [userId, id]);
    if (!rows[0]) throw notFound();
    return toAtom(rows[0]);
  }

  async listAtoms(userId: string, scope: AtomScope = 'live'): Promise<Atom[]> {
    const where = {
      live: `a.deleted_at IS NULL AND a.review_state = 'approved'`,
      review: `a.deleted_at IS NULL AND a.review_state = 'pending'`,
      trash: `a.deleted_at IS NOT NULL`,
    }[scope];
    const order = scope === 'trash' ? 'a.deleted_at DESC' : scope === 'review' ? 'a.created_at ASC' : 'a.updated_at DESC';
    const { rows } = await this.db.query(`${ATOM_SELECT} WHERE a.user_id = $1 AND ${where} ORDER BY ${order}`, [userId]);
    return rows.map(toAtom);
  }

  /** Finds atoms by meaning. Includes notes waiting for review so the AI does not submit them twice. */
  async search(
    userId: string,
    query: string,
    opts: { project?: string | null; limit?: number; includePending?: boolean } = {},
  ): Promise<SearchResult[]> {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) throw badRequest('Search query is required');
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 10), 1), 50);
    const vec = await this.embedOne(q.slice(0, MAX_TEXT_LENGTH));
    const params: unknown[] = [userId, vec, this.embedder.model, limit];
    let projectFilter = '';
    if (opts.project !== undefined && opts.project !== null && opts.project !== '') {
      const project = await this.findProject(this.db, userId, opts.project);
      if (!project.matched) return [];
      projectFilter = project.id ? `AND a.project_id = $${params.push(project.id)}` : 'AND a.project_id IS NULL';
    }
    const pendingFilter = opts.includePending === false ? `AND a.review_state = 'approved'` : '';
    const { rows } = await this.db.query(
      `${ATOM_SELECT.replace('SELECT a.id,', 'SELECT 1 - (a.embedding <=> $2::vector) AS similarity, a.id,')}
       WHERE a.user_id = $1 AND a.deleted_at IS NULL AND a.embedding_model = $3 ${projectFilter} ${pendingFilter}
       -- Outdated (replaced) notes rank a little lower, so the current version of a decision comes first.
       ORDER BY (a.embedding <=> $2::vector)
         + CASE WHEN EXISTS (SELECT 1 FROM replacements r JOIN atoms n ON n.id = r.new_atom_id
                             WHERE r.old_atom_id = a.id AND n.deleted_at IS NULL AND n.review_state = 'approved')
           THEN 0.05 ELSE 0 END
       LIMIT $4`,
      params,
    );
    return rows.map((r) => ({ atom: toAtom(r), similarity: Math.round(Number(r.similarity) * 1000) / 1000 }));
  }

  // ---- Saving -----------------------------------------------------------

  async saveNote(userId: string, input: SaveNoteInput): Promise<SaveNoteResult> {
    const text = cleanText(input.text);
    const type = checkType(input.type);
    const status = checkStatus(input.status);
    const aiScore = input.importance === undefined || input.importance === null ? 0.5 : checkScore(input.importance);
    const replaces = checkIds(input.replaces, 'replaces');
    const vec = await this.embedOne(text);
    const { duplicateThreshold } = await this.getSettings(userId);

    return withTransaction(this.db, async (client) => {
      // Serialize saves per user so two near-identical notes arriving at once cannot both be created.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`save:${userId}`]);

      if (replaces.length) {
        const { rows } = await client.query(
          'SELECT id FROM atoms WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
          [userId, replaces],
        );
        if (rows.length !== replaces.length) throw badRequest('Some ids in replaces do not match an existing note');
      }

      // 1. Near-identical atom already saved? Raise its weight instead of adding a duplicate.
      // Atoms being replaced are excluded (a corrected date reads almost the same as the
      // old one), and so are atoms that have already been replaced.
      const { rows: dupRows } = await client.query(
        `SELECT a.id, 1 - (a.embedding <=> $2::vector) AS similarity
         FROM atoms a
         WHERE a.user_id = $1 AND a.deleted_at IS NULL AND a.embedding_model = $3
           AND NOT (a.id = ANY($4::uuid[]))
           AND NOT EXISTS (SELECT 1 FROM replacements r JOIN atoms n ON n.id = r.new_atom_id
                           WHERE r.old_atom_id = a.id AND n.deleted_at IS NULL)
         ORDER BY a.embedding <=> $2::vector
         LIMIT 1`,
        [userId, vec, this.embedder.model, replaces],
      );
      const dup = dupRows[0];
      if (dup && Number(dup.similarity) >= duplicateThreshold) {
        await client.query('UPDATE atoms SET reference_count = reference_count + 1 WHERE id = $1', [dup.id]);
        const atom = await this.getAtom(userId, dup.id, client);
        return { outcome: 'duplicate', atom, similarity: Math.round(Number(dup.similarity) * 1000) / 1000 };
      }

      // 2. Pick the project. Unknown names go to Unsorted instead of guessing.
      const project = await this.findProject(client, userId, input.project);

      const { rows } = await client.query(
        `INSERT INTO atoms (user_id, project_id, text, type, status, review_state, source_ai, source_chat,
                            ai_score, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11)
         RETURNING id`,
        [
          userId,
          project.id,
          text,
          type,
          status,
          input.uncertain ? 'pending' : 'approved',
          trimOrNull(input.sourceAi, 80),
          trimOrNull(input.sourceChat, 200),
          aiScore,
          vec,
          this.embedder.model,
        ],
      );
      const id = rows[0].id as string;

      // 3. Contradictions: link "replaces" so the old atom dims.
      for (const oldId of replaces) {
        await client.query('INSERT INTO replacements (new_atom_id, old_atom_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, oldId]);
      }
      const atom = await this.getAtom(userId, id, client);
      return { outcome: 'created', atom, projectMatched: project.matched };
    });
  }

  async updateNote(userId: string, id: string, patch: UpdateNoteInput): Promise<Atom> {
    if (!isUuid(id)) throw notFound();
    const sets: string[] = [];
    const params: unknown[] = [userId, id];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(sql.replace('?', `$${params.length}`));
    };

    let contentChanged = false;
    if (patch.text !== undefined) {
      const text = cleanText(patch.text);
      // Re-embed so the atom moves to its correct spot in the graph.
      const vec = await this.embedOne(text);
      add('text = ?', text);
      add('embedding = ?::vector', vec);
      add('embedding_model = ?', this.embedder.model);
      contentChanged = true;
    }
    if (patch.type !== undefined) {
      add('type = ?', checkType(patch.type));
      contentChanged = true;
    }
    if (patch.status !== undefined) {
      add('status = ?', checkStatus(patch.status));
      contentChanged = true;
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== 'boolean') throw badRequest('Pinned must be true or false');
      add('pinned = ?', patch.pinned);
    }
    if (patch.importance !== undefined) add('ai_score = ?', checkScore(patch.importance));
    const replaces = checkIds(patch.replaces, 'replaces');
    if (replaces.includes(id.toLowerCase())) throw badRequest('A note cannot replace itself');

    return withTransaction(this.db, async (client) => {
      if (patch.project !== undefined) {
        const project = await this.findProject(client, userId, patch.project);
        if (!project.matched) throw badRequest(`No project named "${patch.project}". Use List projects to see the names.`);
        add('project_id = ?', project.id);
        contentChanged = true;
      }
      if (contentChanged) sets.push('updated_at = now()');

      const { rows: existing } = await client.query(
        'SELECT id FROM atoms WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
        [userId, id],
      );
      if (!existing[0]) throw notFound();
      if (sets.length) await client.query(`UPDATE atoms SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2`, params);

      if (replaces.length) {
        const { rows } = await client.query(
          'SELECT id FROM atoms WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
          [userId, replaces],
        );
        if (rows.length !== replaces.length) throw badRequest('Some ids in replaces do not match an existing note');
        const { rows: cycle } = await client.query(
          'SELECT 1 FROM replacements WHERE new_atom_id = ANY($1::uuid[]) AND old_atom_id = $2',
          [replaces, id],
        );
        if (cycle.length) throw badRequest('One of those notes already replaces this one');
        for (const oldId of replaces) {
          await client.query('INSERT INTO replacements (new_atom_id, old_atom_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, oldId]);
        }
        // Bump the version so open apps pick up the new link.
        await client.query('UPDATE atoms SET updated_at = updated_at WHERE id = $1', [id]);
      }
      return this.getAtom(userId, id, client);
    });
  }

  // ---- Review and Trash -------------------------------------------------

  async approve(userId: string, id: string): Promise<Atom> {
    if (!isUuid(id)) throw notFound();
    const { rowCount } = await this.db.query(
      `UPDATE atoms SET review_state = 'approved' WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [userId, id],
    );
    if (!rowCount) throw notFound();
    return this.getAtom(userId, id);
  }

  /** Moves an atom to Trash. It is removed for good after TRASH_DAYS. */
  async trash(userId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound();
    const { rowCount } = await this.db.query(
      'UPDATE atoms SET deleted_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL',
      [userId, id],
    );
    if (!rowCount) throw notFound();
  }

  async restore(userId: string, id: string): Promise<Atom> {
    if (!isUuid(id)) throw notFound();
    const { rowCount } = await this.db.query(
      'UPDATE atoms SET deleted_at = NULL WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL',
      [userId, id],
    );
    if (!rowCount) throw notFound();
    return this.getAtom(userId, id);
  }

  /** Deletes one atom in Trash for good. */
  async deleteForever(userId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound();
    const { rowCount } = await this.db.query(
      'DELETE FROM atoms WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL',
      [userId, id],
    );
    if (!rowCount) throw notFound();
  }

  async emptyTrash(userId: string): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM atoms WHERE user_id = $1 AND deleted_at IS NOT NULL', [userId]);
    return rowCount ?? 0;
  }

  /** Removes atoms that have been in Trash longer than TRASH_DAYS, for every user. */
  async purgeExpiredTrash(): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM atoms WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $1)`,
      [TRASH_DAYS],
    );
    return rowCount ?? 0;
  }

  /**
   * Re-embeds atoms whose vectors came from a different model (e.g. after
   * switching EMBEDDING_MODEL). Returns how many were updated.
   */
  async reembedStale(batchSize = 32): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.db.query(
        `SELECT id, text FROM atoms WHERE embedding_model IS DISTINCT FROM $1 OR embedding IS NULL
         ORDER BY created_at LIMIT $2`,
        [this.embedder.model, batchSize],
      );
      if (!rows.length) return total;
      const vectors = await this.embedder.embed(rows.map((r) => r.text));
      for (let i = 0; i < rows.length; i++) {
        await this.db.query('UPDATE atoms SET embedding = $2::vector, embedding_model = $3 WHERE id = $1', [
          rows[i].id,
          toVectorLiteral(vectors[i]),
          this.embedder.model,
        ]);
      }
      total += rows.length;
    }
  }

  // ---- Graph ------------------------------------------------------------

  async syncState(userId: string): Promise<SyncState> {
    const { rows } = await this.db.query(
      `SELECT u.data_version, u.link_threshold,
              (SELECT count(*) FROM atoms a WHERE a.user_id = u.id AND a.deleted_at IS NULL
                 AND a.review_state = 'pending')::int AS review_count
       FROM users u WHERE u.id = $1`,
      [userId],
    );
    if (!rows[0]) throw notFound('User');
    return { version: `${rows[0].data_version}:${rows[0].link_threshold}`, reviewCount: rows[0].review_count };
  }

  async graph(userId: string): Promise<GraphData> {
    const [atoms, projects, settings, sync] = await Promise.all([
      this.listAtoms(userId, 'live'),
      this.listProjects(userId),
      this.getSettings(userId),
      this.syncState(userId),
    ]);

    const cacheKey = `${userId}:${sync.version}:${this.embedder.model}`;
    let similar = this.linkCache.get(cacheKey);
    if (!similar) {
      // For each atom, its nearest neighbours above the link threshold.
      const { rows } = await this.db.query(
        `WITH live AS MATERIALIZED (
           SELECT id, embedding FROM atoms
           WHERE user_id = $1 AND deleted_at IS NULL AND review_state = 'approved'
             AND embedding_model = $2 AND embedding IS NOT NULL)
         SELECT a.id AS source, n.id AS target, n.similarity
         FROM live a
         CROSS JOIN LATERAL (
           SELECT b.id, 1 - (a.embedding <=> b.embedding) AS similarity
           FROM live b WHERE b.id <> a.id
           ORDER BY a.embedding <=> b.embedding
           LIMIT $3) n
         WHERE n.similarity >= $4`,
        [userId, this.embedder.model, MAX_LINKS_PER_ATOM, settings.linkThreshold],
      );
      const seen = new Map<string, GraphLink>();
      for (const r of rows) {
        const [s, t] = r.source < r.target ? [r.source, r.target] : [r.target, r.source];
        const key = `${s}|${t}`;
        if (!seen.has(key)) {
          seen.set(key, { source: s, target: t, similarity: Math.round(Number(r.similarity) * 1000) / 1000, kind: 'similar' });
        }
      }
      similar = [...seen.values()];
      for (const key of this.linkCache.keys()) if (key.startsWith(`${userId}:`)) this.linkCache.delete(key);
      if (this.linkCache.size > 200) this.linkCache.delete(this.linkCache.keys().next().value!);
      this.linkCache.set(cacheKey, similar);
    }

    const liveIds = new Set(atoms.map((a) => a.id));
    const replaceLinks: GraphLink[] = [];
    for (const a of atoms) {
      for (const oldId of a.replaces) {
        if (liveIds.has(oldId)) replaceLinks.push({ source: a.id, target: oldId, similarity: 1, kind: 'replaces' });
      }
    }
    return { atoms, links: [...similar, ...replaceLinks], projects, linkThreshold: settings.linkThreshold };
  }
}
