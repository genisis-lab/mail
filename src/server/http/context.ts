import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { get, now, run } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, HttpError, tooMany, unauthorized } from '../lib/http.js';
import { getSettings } from '../settings.js';
import { getUser, mustChangePassword, mustSetup2fa, type UserRow } from '../services/users.js';

export interface SessionRow {
  id: string;
  user_id: number;
  mfa_pending: number;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export type AppEnv = {
  Variables: {
    /** The mailbox being acted on: the signed-in user, or a shared mailbox they belong to. */
    user: UserRow;
    /** The person who is signed in (differs from `user` inside a shared mailbox). */
    actor: UserRow;
    mailbox: { id: number; canSend: boolean } | null;
    session: SessionRow | null;
    apiKeyId: number | null;
  };
};

export type Ctx = Context<AppEnv>;

export const SESSION_COOKIE = 'wren_sid';

/** Cloudflare sets this header on every request that reaches the Worker. */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? '';
}

/** A full session, or (mfaPending) one waiting for the 2-step code; `viaPasskey` marks a passkey sign-in waiting for it. */
export function createSession(c: Context, userId: number, mfaPending = false, viaPasskey = false): string {
  const token = randomToken(32);
  const ts = now();
  const days = getSettings()['security.sessionDays'];
  const expires = mfaPending ? ts + 10 * 60_000 : ts + days * 86_400_000;
  run(
    `INSERT INTO sessions (id, user_id, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, mfaPending ? (viaPasskey ? 2 : 1) : 0, clientIp(c), (c.req.header('user-agent') ?? '').slice(0, 300), ts, ts, expires],
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.publicUrl.startsWith('https://'),
    path: '/',
    expires: new Date(expires),
  });
  return token;
}

export function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

function loadSession(c: Context): { session: SessionRow; user: UserRow } | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sha256(token)]);
  if (!session || session.expires_at < now()) return null;
  const user = getUser(session.user_id);
  if (!user || user.status !== 'active') return null;
  if (now() - session.last_seen_at > 5 * 60_000) {
    run('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?', [now(), clientIp(c), session.id]);
  }
  return { session, user };
}

/** Resolve "Authorization: Bearer wren_…" API keys. */
function loadApiKey(c: Context): { user: UserRow; keyId: number } | null {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const key = auth.slice(7).trim();
  const row = get<{ id: number; user_id: number }>('SELECT id, user_id FROM api_keys WHERE key_hash = ?', [sha256(key)]);
  if (!row) return null;
  const user = getUser(row.user_id);
  if (!user || user.status !== 'active') return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now(), row.id]);
  return { user, keyId: row.id };
}

/** Require a fully signed-in user (password + 2FA when enabled). */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = loadSession(c);
  if (!s || s.session.mfa_pending) throw unauthorized();
  c.set('user', s.user);
  c.set('session', s.session);
  c.set('apiKeyId', null);
  await next();
};

/** Like requireUser, but blocks everything except 2FA setup when policy demands it. */
/**
 * Lets mail routes act on a shared mailbox the signed-in user belongs to,
 * selected with the X-Wren-Mailbox header (or ?mailbox= for plain links).
 */
export const actAsMailbox: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get('user');
  c.set('actor', actor);
  c.set('mailbox', null);
  const raw = c.req.header('x-wren-mailbox') ?? c.req.query('mailbox');
  if (raw && Number(raw) !== actor.id) {
    const id = Number(raw);
    const member = Number.isInteger(id) && id > 0 ? get<{ can_send: number }>('SELECT can_send FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', [id, actor.id]) : undefined;
    const box = member ? getUser(id) : undefined;
    if (!member || !box || box.kind !== 'shared' || box.status !== 'active') throw forbidden('You don’t have access to that mailbox');
    c.set('user', box);
    c.set('mailbox', { id, canSend: !!member.can_send });
  }
  await next();
};

export const requireUserReady: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = loadSession(c);
  if (!s || s.session.mfa_pending) throw unauthorized();
  if (mustChangePassword(s.user)) throw new HttpError(403, 'Choose a new password first', 'password_change_required');
  if (mustSetup2fa(s.user)) throw new HttpError(403, 'Two-factor authentication must be set up first', 'mfa_setup_required');
  c.set('user', s.user);
  c.set('session', s.session);
  c.set('apiKeyId', null);
  await next();
};

export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const k = loadApiKey(c);
  if (!k) throw unauthorized('Invalid API key');
  c.set('user', k.user);
  c.set('session', null);
  c.set('apiKeyId', k.keyId);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) throw forbidden('Administrator access required');
  await next();
};

export function getPendingSession(c: Context): { session: SessionRow; user: UserRow; passkey: boolean } | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ? AND mfa_pending > 0', [sha256(token)]);
  if (!session || session.expires_at < now()) return null;
  const user = getUser(session.user_id);
  return user && user.status === 'active' ? { session, user, passkey: session.mfa_pending === 2 } : null;
}

/** Fixed-window rate limiter backed by SQLite (survives restarts). */
export function rateLimit(key: string, max: number, windowMs: number) {
  const ts = now();
  const row = get<{ count: number; reset_at: number }>('SELECT count, reset_at FROM login_attempts WHERE key = ?', [key]);
  if (!row || row.reset_at < ts) {
    run('INSERT INTO login_attempts (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at', [
      key,
      ts + windowMs,
    ]);
    return;
  }
  if (row.count >= max) throw tooMany(`Too many attempts. Try again in ${Math.ceil((row.reset_at - ts) / 60000)} minute(s).`);
  run('UPDATE login_attempts SET count = count + 1 WHERE key = ?', [key]);
}

export function clearRateLimit(key: string) {
  run('DELETE FROM login_attempts WHERE key = ?', [key]);
}

/** Parse and validate a JSON body with a zod schema. */
export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw badRequest('Invalid JSON body');
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest(`${issue.path.join('.') || 'body'}: ${issue.message}`, 'validation');
  }
  return r.data;
}

export function intParam(c: Context, name: string): number {
  const v = Number.parseInt(c.req.param(name) ?? '', 10);
  if (!Number.isFinite(v) || v <= 0) throw badRequest(`Invalid ${name}`);
  return v;
}

