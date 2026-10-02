/** One-time links: password reset, account setup, and recovery-email verification. */
import { get, now, run } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type TokenKind = 'reset' | 'setup' | 'verify_recovery';

const LIFETIME: Record<TokenKind, number> = {
  reset: 60 * 60_000, // 1 hour
  setup: 7 * 86_400_000, // 7 days
  verify_recovery: 3 * 86_400_000,
};

/** Create a token (replacing any unused one of the same kind for the user). */
export function issueToken(userId: number, kind: TokenKind, data?: unknown): string {
  const token = randomToken(32);
  const ts = now();
  run('DELETE FROM auth_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL', [userId, kind]);
  run('INSERT INTO auth_tokens (token_hash, user_id, kind, data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    sha256(token),
    userId,
    kind,
    data === undefined ? null : JSON.stringify(data),
    ts + LIFETIME[kind],
    ts,
  ]);
  return token;
}

export interface TokenRow {
  user_id: number;
  kind: TokenKind;
  data: string | null;
  expires_at: number;
  used_at: number | null;
}

/** Look up a valid (unused, unexpired) token without consuming it. */
export function peekToken(token: string, kinds: TokenKind[]): TokenRow | null {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = get<TokenRow>('SELECT user_id, kind, data, expires_at, used_at FROM auth_tokens WHERE token_hash = ?', [sha256(token)]);
  if (!row || row.used_at || row.expires_at < now() || !kinds.includes(row.kind)) return null;
  return row;
}

/** Consume a token. Returns the row only the first time. */
export function consumeToken(token: string, kinds: TokenKind[]): TokenRow | null {
  const row = peekToken(token, kinds);
  if (!row) return null;
  const r = run('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [now(), sha256(token)]);
  return r.changes === 1 ? row : null;
}

export function pruneTokens() {
  run('DELETE FROM auth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', [now() - 86_400_000, now() - 7 * 86_400_000]);
}
