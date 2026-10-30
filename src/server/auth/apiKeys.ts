import type { Db } from '../db.js';
import { badRequest, isUuid, notFound } from '../errors.js';
import { hashToken, newToken } from './tokens.js';

export const API_KEY_PREFIX = 'trk_';

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export class ApiKeyService {
  constructor(private db: Db) {}

  /** Returns the full key once. Only its hash is stored. */
  async create(userId: string, name: unknown): Promise<{ key: string; info: ApiKeyInfo }> {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('Give the key a name, e.g. "Claude Desktop"');
    const key = newToken(API_KEY_PREFIX);
    const { rows } = await this.db.query(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, prefix, created_at, last_used_at`,
      [userId, name.trim().slice(0, 60), key.slice(0, API_KEY_PREFIX.length + 6), hashToken(key)],
    );
    return { key, info: this.toInfo(rows[0]) };
  }

  async list(userId: string): Promise<ApiKeyInfo[]> {
    const { rows } = await this.db.query(
      `SELECT id, name, prefix, created_at, last_used_at FROM api_keys
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [userId],
    );
    return rows.map((r) => this.toInfo(r));
  }

  async revoke(userId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound('API key');
    const { rowCount } = await this.db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL',
      [userId, id],
    );
    if (!rowCount) throw notFound('API key');
  }

  async verify(key: string): Promise<{ userId: string; keyId: string; name: string } | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const { rows } = await this.db.query(
      `UPDATE api_keys SET last_used_at = now()
       WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, user_id, name`,
      [hashToken(key)],
    );
    return rows[0] ? { userId: rows[0].user_id, keyId: rows[0].id, name: rows[0].name } : null;
  }

  private toInfo(r: Record<string, any>): ApiKeyInfo {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    };
  }
}
