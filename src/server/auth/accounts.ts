import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withTransaction, type Db, type Queryable } from '../db.js';
import { AppError, badRequest, isUuid, notFound } from '../errors.js';
import type { Me } from '../../shared/types.js';
import { hashToken, newRecoveryCode, newToken, normalizeRecoveryCode } from './tokens.js';

const SESSION_DAYS = 30;
const RECOVERY_SESSION_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const RECOVERY_CODE_COUNT = 10;

export interface Session {
  userId: string;
  recovery: boolean;
  tokenHash: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

type Transport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

/** Guess a friendly default name for a new passkey from the browser's user agent. */
export function passkeyNameFromUserAgent(ua = ''): string {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Passkey';
}

export class AccountService {
  constructor(
    private db: Db,
    private rp: { origin: string; rpID: string; rpName: string },
  ) {}

  // ---- Sessions ---------------------------------------------------------

  async createSession(userId: string, recovery = false, q: Queryable = this.db): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken('ts_');
    const expiresAt = recovery
      ? new Date(Date.now() + RECOVERY_SESSION_MINUTES * 60_000)
      : new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await q.query('INSERT INTO sessions (token_hash, user_id, expires_at, recovery) VALUES ($1, $2, $3, $4)', [
      hashToken(token),
      userId,
      expiresAt,
      recovery,
    ]);
    return { token, expiresAt };
  }

  async getSession(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const { rows } = await this.db.query(
      'SELECT user_id, recovery FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [tokenHash],
    );
    if (!rows[0]) return null;
    return { userId: rows[0].user_id, recovery: rows[0].recovery, tokenHash };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async me(session: Session): Promise<Me> {
    const { rows } = await this.db.query('SELECT id, display_name FROM users WHERE id = $1', [session.userId]);
    if (!rows[0]) throw notFound('User');
    return { id: rows[0].id, displayName: rows[0].display_name, recovery: session.recovery };
  }

  // ---- Challenges -------------------------------------------------------

  private async saveChallenge(kind: 'register' | 'login' | 'add', challenge: string, userId: string | null, pending: object | null) {
    // Opportunistically clear out stale challenges.
    await this.db.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
    const { rows } = await this.db.query(
      `INSERT INTO webauthn_challenges (kind, challenge, user_id, pending, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id`,
      [kind, challenge, userId, pending, CHALLENGE_MINUTES],
    );
    return rows[0].id as string;
  }

  /** Single use: the challenge is deleted as it is read. */
  private async takeChallenge(id: string | undefined, kind: 'register' | 'login' | 'add', q: Queryable = this.db) {
    if (!isUuid(id)) throw badRequest('Sign-in expired. Please try again.');
    const { rows } = await q.query(
      'DELETE FROM webauthn_challenges WHERE id = $1 AND kind = $2 RETURNING challenge, user_id, pending, expires_at',
      [id, kind],
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at) < new Date()) throw badRequest('Sign-in expired. Please try again.');
    return row as { challenge: string; user_id: string | null; pending: any };
  }

  // ---- Registration (new account) ----------------------------------------

  async startRegistration(displayName: unknown) {
    if (typeof displayName !== 'string' || !displayName.trim()) throw badRequest('Name is required');
    const name = displayName.trim().slice(0, 60);
    const webauthnUserId = randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: this.rp.rpName,
      rpID: this.rp.rpID,
      userName: name,
      userDisplayName: name,
      userID: webauthnUserId,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await this.saveChallenge('register', options.challenge, null, {
      displayName: name,
      webauthnUserId: webauthnUserId.toString('base64url'),
    });
    return { options, challengeId };
  }

  async finishRegistration(challengeId: string | undefined, response: RegistrationResponseJSON, userAgent?: string) {
    return withTransaction(this.db, async (client) => {
      const ch = await this.takeChallenge(challengeId, 'register', client);
      const verification = await this.verifyRegistration(response, ch.challenge);
      const { rows } = await client.query(
        'INSERT INTO users (display_name, webauthn_user_id) VALUES ($1, $2) RETURNING id',
        [ch.pending.displayName, Buffer.from(ch.pending.webauthnUserId, 'base64url')],
      );
      const userId = rows[0].id as string;
      await this.insertPasskey(client, userId, verification, passkeyNameFromUserAgent(userAgent));
      const recoveryCodes = await this.replaceRecoveryCodes(userId, client);
      const session = await this.createSession(userId, false, client);
      return { userId, session, recoveryCodes };
    });
  }

  private async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.rp.origin,
        expectedRPID: this.rp.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw badRequest(`Passkey could not be verified: ${(err as Error).message}`);
    }
    if (!verification.verified) throw badRequest('Passkey could not be verified');
    return verification.registrationInfo;
  }

  private async insertPasskey(
    q: Queryable,
    userId: string,
    info: Awaited<ReturnType<AccountService['verifyRegistration']>>,
    name: string,
  ) {
    try {
      await q.query(
        `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          info.credential.id,
          userId,
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          info.credential.transports ?? [],
          info.credentialDeviceType,
          info.credentialBackedUp,
          name,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'This passkey is already registered');
      throw err;
    }
  }

  // ---- Sign-in ----------------------------------------------------------

  async startLogin() {
    // No allowCredentials: the browser offers any Trellis passkey on the device.
    const options = await generateAuthenticationOptions({ rpID: this.rp.rpID, userVerification: 'preferred' });
    const challengeId = await this.saveChallenge('login', options.challenge, null, null);
    return { options, challengeId };
  }

  async finishLogin(challengeId: string | undefined, response: AuthenticationResponseJSON) {
    const ch = await this.takeChallenge(challengeId, 'login');
    if (!response || typeof response.id !== 'string') throw badRequest('Invalid sign-in response');
    const { rows } = await this.db.query('SELECT * FROM passkeys WHERE id = $1', [response.id]);
    const pk = rows[0];
    if (!pk) throw new AppError(401, 'This passkey is not registered with Trellis');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.rp.origin,
        expectedRPID: this.rp.rpID,
        requireUserVerification: false,
        credential: {
          id: pk.id,
          publicKey: new Uint8Array(pk.public_key),
          counter: Number(pk.counter),
          transports: pk.transports as Transport[],
        },
      });
    } catch (err) {
      throw new AppError(401, `Passkey could not be verified: ${(err as Error).message}`);
    }
    if (!verification.verified) throw new AppError(401, 'Passkey could not be verified');

    await this.db.query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [
      pk.id,
      verification.authenticationInfo.newCounter,
    ]);
    const session = await this.createSession(pk.user_id);
    return { userId: pk.user_id as string, session };
  }

  // ---- Recovery codes ---------------------------------------------------

  async replaceRecoveryCodes(userId: string, q: Queryable = this.db): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const code of codes) {
      await q.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashToken(code)]);
    }
    return codes;
  }

  async recoveryCodesLeft(userId: string): Promise<number> {
    const { rows } = await this.db.query(
      'SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    );
    return rows[0].n;
  }

  /**
   * Signs in with a one-time recovery code. The resulting session can only add
   * a new passkey; once one is added it becomes a normal session.
   */
  async useRecoveryCode(code: unknown) {
    if (typeof code !== 'string' || !code.trim()) throw badRequest('Enter a recovery code');
    const { rows } = await this.db.query(
      `UPDATE recovery_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL RETURNING user_id`,
      [hashToken(normalizeRecoveryCode(code))],
    );
    if (!rows[0]) throw new AppError(401, 'That recovery code is not valid or was already used');
    const session = await this.createSession(rows[0].user_id, true);
    return { userId: rows[0].user_id as string, session };
  }

  // ---- Managing passkeys ------------------------------------------------

  async listPasskeys(userId: string): Promise<PasskeyInfo[]> {
    const { rows } = await this.db.query(
      'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    }));
  }

  async startAddPasskey(userId: string) {
    const { rows: users } = await this.db.query('SELECT display_name, webauthn_user_id FROM users WHERE id = $1', [userId]);
    if (!users[0]) throw notFound('User');
    const existing = await this.db.query('SELECT id, transports FROM passkeys WHERE user_id = $1', [userId]);
    const options = await generateRegistrationOptions({
      rpName: this.rp.rpName,
      rpID: this.rp.rpID,
      userName: users[0].display_name,
      userDisplayName: users[0].display_name,
      userID: new Uint8Array(users[0].webauthn_user_id),
      attestationType: 'none',
      excludeCredentials: existing.rows.map((r) => ({ id: r.id, transports: r.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await this.saveChallenge('add', options.challenge, userId, null);
    return { options, challengeId };
  }

  async finishAddPasskey(session: Session, challengeId: string | undefined, response: RegistrationResponseJSON, userAgent?: string) {
    return withTransaction(this.db, async (client) => {
      const ch = await this.takeChallenge(challengeId, 'add', client);
      if (ch.user_id !== session.userId) throw badRequest('Sign-in expired. Please try again.');
      const info = await this.verifyRegistration(response, ch.challenge);
      await this.insertPasskey(client, session.userId, info, passkeyNameFromUserAgent(userAgent));
      if (session.recovery) {
        // The user proved who they are and now has a working passkey again.
        await client.query(
          `UPDATE sessions SET recovery = false, expires_at = now() + make_interval(days => $2) WHERE token_hash = $1`,
          [session.tokenHash, SESSION_DAYS],
        );
      }
    });
  }

  async renamePasskey(userId: string, id: string, name: unknown): Promise<void> {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('Name is required');
    const { rowCount } = await this.db.query('UPDATE passkeys SET name = $3 WHERE user_id = $1 AND id = $2', [
      userId,
      id,
      name.trim().slice(0, 60),
    ]);
    if (!rowCount) throw notFound('Passkey');
  }

  async deletePasskey(userId: string, id: string): Promise<void> {
    await withTransaction(this.db, async (client) => {
      const { rows } = await client.query('SELECT id FROM passkeys WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!rows.some((r) => r.id === id)) throw notFound('Passkey');
      if (rows.length <= 1) throw badRequest('You cannot remove your only passkey. Add another one first.');
      await client.query('DELETE FROM passkeys WHERE user_id = $1 AND id = $2', [userId, id]);
    });
  }

  async updateDisplayName(userId: string, name: unknown): Promise<void> {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('Name is required');
    await this.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId, name.trim().slice(0, 60)]);
  }

  // ---- Maintenance ------------------------------------------------------

  async purgeExpired(): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE expires_at < now()');
    await this.db.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  }
}
