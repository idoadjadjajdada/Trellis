import { createHash, randomBytes } from 'node:crypto';

/** A random, URL-safe secret with an optional readable prefix. */
export function newToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are long random strings, so a plain SHA-256 is enough to store them
 * safely: there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i

/** e.g. "k7mq-4xht-p2wd-9cfe" (80 bits of entropy). */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

export function normalizeRecoveryCode(code: string): string {
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return c.replace(/(.{4})(?=.)/g, '$1-');
}
