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

/**
 * One browser can be signed in to several accounts, like Gmail. The first
 * keeps this cookie; each one added after it gets its own (wren_sid_<user id>).
 * Requests name the account they're for (X-Wren-Account, or ?account= on links
 * the browser opens itself), so a tab can never act as another account.
 */
export const SESSION_COOKIE = 'wren_sid';
/** A sign-in waiting for its 2-step code, kept apart from the accounts already signed in. */
export const PENDING_COOKIE = 'wren_mfa';
/** How many accounts one browser can be signed in to at once. */
export const MAX_ACCOUNTS = 10;

const EXTRA_COOKIE = /^wren_sid_([1-9]\d{0,14})$/;
const extraCookie = (userId: number) => `${SESSION_COOKIE}_${userId}`;

/** Cloudflare sets this header on every request that reaches the Worker. */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? '';
}

function cookieOptions(expires: number) {
  return { httpOnly: true, sameSite: 'Lax' as const, secure: config.publicUrl.startsWith('https://'), path: '/', expires: new Date(expires) };
}

/** An account signed in on this browser: the cookie holding it, its session and its owner. */
export interface BrowserSession {
  cookie: string;
  token: string;
  session: SessionRow;
  user: UserRow;
}

/** A full (not pending), unexpired session of an active person, if that's what this cookie holds. */
function validSession(cookie: string, token: string | undefined): BrowserSession | null {
  if (!token) return null;
  const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sha256(token)]);
  if (!session || session.mfa_pending || session.expires_at < now()) return null;
  const user = getUser(session.user_id);
  if (!user || user.status !== 'active') return null;
  // wren_sid_<id> only ever holds that account.
  const extra = EXTRA_COOKIE.exec(cookie);
  if (extra && Number(extra[1]) !== user.id) return null;
  return { cookie, token, session, user };
}

/** Every account signed in on this browser: the first one, then the others in the order they were added. */
export function browserSessions(c: Context): BrowserSession[] {
  const jar = getCookie(c);
  const first = validSession(SESSION_COOKIE, jar[SESSION_COOKIE]);
  const others = Object.keys(jar)
    .filter((name) => EXTRA_COOKIE.test(name))
    .map((name) => validSession(name, jar[name]))
    .filter((s): s is BrowserSession => !!s)
    .sort((a, b) => a.session.created_at - b.session.created_at);
  const out = first ? [first] : [];
  for (const s of others) if (!out.some((o) => o.user.id === s.user.id)) out.push(s);
  return out;
}

/** Where the web app shows an account on this browser: '' for the first one, /u/<id> for the others. */
export function accountPath(sessions: BrowserSession[], userId: number): string {
  return sessions[0]?.user.id === userId ? '' : `/u/${userId}`;
}

/** The account a request is for (-1: it named one that can't exist), or null when it doesn't say. */
export function requestedAccount(c: Context): number | null {
  const raw = c.req.header('x-wren-account') ?? c.req.query('account');
  if (!raw) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : -1;
}

/** This browser's session for one account. */
function sessionForAccount(c: Context, userId: number): BrowserSession | null {
  const own = validSession(extraCookie(userId), getCookie(c, extraCookie(userId)));
  if (own) return own;
  const first = validSession(SESSION_COOKIE, getCookie(c, SESSION_COOKIE));
  return first?.user.id === userId ? first : null;
}

/** The account a request acts as: the one it names, or else the first one signed in here. */
function loadSession(c: Context): BrowserSession | null {
  const want = requestedAccount(c);
  const s = want !== null ? sessionForAccount(c, want) : (validSession(SESSION_COOKIE, getCookie(c, SESSION_COOKIE)) ?? browserSessions(c)[0] ?? null);
  if (s && now() - s.session.last_seen_at > 5 * 60_000) {
    run('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?', [now(), clientIp(c), s.session.id]);
  }
  return s;
}

/** The signed-in account a request is for, if any (for routes outside the sign-in middleware). */
export function currentSession(c: Context): BrowserSession | null {
  return loadSession(c);
}

/**
 * Which cookie a new session for this account goes in: the one it already has
 * here (signing in again replaces it), the first one if that's free, or a new
 * one next to the accounts already signed in.
 */
function cookieFor(c: Context, userId: number): string {
  const firstToken = getCookie(c, SESSION_COOKIE);
  const firstRow = firstToken ? get<{ id: string; user_id: number }>('SELECT id, user_id FROM sessions WHERE id = ?', [sha256(firstToken)]) : undefined;
  const ownToken = getCookie(c, extraCookie(userId));
  const replace = (token: string | undefined) => {
    if (token) run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
  };
  if (firstRow?.user_id === userId) {
    replace(firstToken);
    // Signed in twice by some race: keep one.
    if (ownToken) {
      replace(ownToken);
      deleteCookie(c, extraCookie(userId), { path: '/' });
    }
    return SESSION_COOKIE;
  }
  if (ownToken) {
    replace(ownToken);
    return extraCookie(userId);
  }
  if (!validSession(SESSION_COOKIE, firstToken)) {
    replace(firstToken);
    return SESSION_COOKIE;
  }
  if (browserSessions(c).length >= MAX_ACCOUNTS) throw badRequest(`You can be signed in to ${MAX_ACCOUNTS} accounts at once on this device. Sign out of one first.`, 'too_many_accounts');
  return extraCookie(userId);
}

/**
 * Sign an account in on this browser, next to any already signed in. A sign-in
 * waiting for its 2-step code (mfaPending; `viaPasskey` marks a passkey
 * sign-in) waits in its own cookie and signs no one out.
 */
export function createSession(c: Context, userId: number, mfaPending = false, viaPasskey = false): string {
  const token = randomToken(32);
  const ts = now();
  const days = getSettings()['security.sessionDays'];
  const expires = mfaPending ? ts + 10 * 60_000 : ts + days * 86_400_000;
  const cookie = mfaPending ? PENDING_COOKIE : cookieFor(c, userId);
  if (mfaPending) clearPending(c);
  run(
    `INSERT INTO sessions (id, user_id, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, mfaPending ? (viaPasskey ? 2 : 1) : 0, clientIp(c), (c.req.header('user-agent') ?? '').slice(0, 300), ts, ts, expires],
  );
  if (!mfaPending) clearPending(c);
  setCookie(c, cookie, token, cookieOptions(expires));
  return token;
}

/** Forget a sign-in that was waiting for its 2-step code. */
export function clearPending(c: Context) {
  const token = getCookie(c, PENDING_COOKIE);
  if (token) {
    run('DELETE FROM sessions WHERE id = ? AND mfa_pending > 0', [sha256(token)]);
    deleteCookie(c, PENDING_COOKIE, { path: '/' });
  }
  // One started before a browser could hold several accounts waited in the first cookie.
  const first = getCookie(c, SESSION_COOKIE);
  if (first && run('DELETE FROM sessions WHERE id = ? AND mfa_pending > 0', [sha256(first)]).changes) deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/**
 * Sign out on this browser: the account the request is for, or every account
 * (`everyone`). When the first account goes, the next one takes its cookie, so
 * links that name no account keep working. Says who was signed out and how many
 * accounts are left.
 */
export function signOut(c: Context, everyone = false): { signedOut: number[]; remaining: number } {
  clearPending(c);
  const sessions = browserSessions(c);
  if (everyone) {
    const jar = getCookie(c);
    for (const name of Object.keys(jar)) {
      if (name !== SESSION_COOKIE && !EXTRA_COOKIE.test(name)) continue;
      run('DELETE FROM sessions WHERE id = ?', [sha256(jar[name])]);
      deleteCookie(c, name, { path: '/' });
    }
    return { signedOut: sessions.map((s) => s.user.id), remaining: 0 };
  }
  const want = requestedAccount(c);
  const target = want === null ? sessions[0] : sessions.find((s) => s.user.id === want);
  if (!target) {
    // Nothing signed in to sign out of: still clear a stale first cookie, as signing out always did.
    if (want === null && getCookie(c, SESSION_COOKIE)) {
      run('DELETE FROM sessions WHERE id = ?', [sha256(getCookie(c, SESSION_COOKIE)!)]);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
    }
    return { signedOut: [], remaining: sessions.length };
  }
  run('DELETE FROM sessions WHERE id = ?', [target.session.id]);
  const next = target.cookie === SESSION_COOKIE ? sessions.find((s) => s !== target) : undefined;
  if (next) {
    setCookie(c, SESSION_COOKIE, next.token, cookieOptions(next.session.expires_at));
    deleteCookie(c, next.cookie, { path: '/' });
  } else {
    deleteCookie(c, target.cookie, { path: '/' });
  }
  return { signedOut: [target.user.id], remaining: sessions.length - 1 };
}

/** Drop cookies of accounts whose session ended elsewhere (signed out on another device, expired, suspended). */
export function tidyAccountCookies(c: Context, sessions: BrowserSession[]) {
  for (const name of Object.keys(getCookie(c))) {
    if (EXTRA_COOKIE.test(name) && !sessions.some((s) => s.cookie === name)) deleteCookie(c, name, { path: '/' });
  }
}

/** What a key may do: "send" (the HTTP send API) or "mail" (an app password for mail apps over JMAP). */
export type KeyScope = 'send' | 'mail';

/** Look up an API key or app password and its active owner. */
export function findApiKey(key: string, scope: KeyScope): { user: UserRow; keyId: number } | null {
  const row = get<{ id: number; user_id: number; scopes: string }>('SELECT id, user_id, scopes FROM api_keys WHERE key_hash = ?', [sha256(key)]);
  if (!row || !row.scopes.split(',').includes(scope)) return null;
  const user = getUser(row.user_id);
  if (!user || user.status !== 'active') return null;
  // Mail apps call often; a minute's precision is plenty for "last used". An app refused because
  // an admin turned mail apps off for this person isn't "using" its password (JMAP answers it 403).
  if (scope !== 'mail' || !user.mail_apps_blocked) run('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)', [now(), row.id, now() - 60_000]);
  return { user, keyId: row.id };
}

/** Resolve "Authorization: Bearer wren_…" API keys. */
function loadApiKey(c: Context): { user: UserRow; keyId: number } | null {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return findApiKey(auth.slice(7).trim(), 'send');
}

/** Require a fully signed-in user (password + 2FA when enabled). */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = loadSession(c);
  if (!s) throw unauthorized();
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
  if (!s) throw unauthorized();
  assertUserReady(s.user);
  c.set('user', s.user);
  c.set('session', s.session);
  c.set('apiKeyId', null);
  await next();
};

function assertUserReady(user: UserRow) {
  if (mustChangePassword(user)) throw new HttpError(403, 'Choose a new password first', 'password_change_required');
  if (mustSetup2fa(user)) throw new HttpError(403, 'Two-factor authentication must be set up first', 'mfa_setup_required');
}

/** Only the steps needed to finish enrollment may bypass account readiness. */
export const requireAccountUser: MiddlewareHandler<AppEnv> = (c, next) => {
  const enrollment = c.req.method === 'POST' && ['/api/account/password', '/api/account/password/required', '/api/account/2fa/setup', '/api/account/2fa/enable'].includes(c.req.path);
  return (enrollment ? requireUser : requireUserReady)(c, next);
};

export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const k = loadApiKey(c);
  if (!k) throw unauthorized('Invalid API key');
  assertUserReady(k.user);
  c.set('user', k.user);
  c.set('session', null);
  c.set('apiKeyId', k.keyId);
  await next();
};

/**
 * What helpdesk staff may do under /api/admin: account support for ordinary
 * people, and invitations for them. Anything not listed is refused. Routes with
 * a person's id (target) only reach a person with role 'user' who isn't helpdesk
 * staff themselves; the routes check what can't be told from the path (PUT
 * /users/:id: suspend or reactivate only; invites: role 'user' only).
 */
const HELPDESK_ROUTES: { method: string; path: RegExp; target?: true }[] = [
  { method: 'GET', path: /^\/users$/ },
  { method: 'GET', path: /^\/users\/(\d+)(?:\/detail)?$/, target: true },
  { method: 'PUT', path: /^\/users\/(\d+)$/, target: true },
  { method: 'POST', path: /^\/users\/(\d+)\/(?:unlock|signout|reset-2fa|reset-link|setup-link|password)$/, target: true },
  { method: 'DELETE', path: /^\/users\/(\d+)\/(?:passkeys|sessions\/[a-f0-9]{16})$/, target: true },
  { method: 'GET', path: /^\/invites$/ },
  { method: 'POST', path: /^\/invites(?:\/\d+\/resend)?$/ },
  { method: 'DELETE', path: /^\/invites\/\d+$/ },
];

/** Whether helpdesk staff may make this request under /api/admin (`path` without the prefix). */
function helpdeskAllowed(method: string, path: string, me: UserRow): boolean {
  for (const r of HELPDESK_ROUTES) {
    const m = method === r.method ? r.path.exec(path) : null;
    if (!m) continue;
    if (!r.target) return true;
    const target = getUser(Number(m[1]));
    // An unknown id falls through to the route's own 404.
    return !target || (target.role === 'user' && !target.helpdesk && target.kind === 'person' && target.id !== me.id);
  }
  return false;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (user?.role === 'admin' || user?.role === 'owner') return next();
  if (user?.helpdesk) {
    if (!helpdeskAllowed(c.req.method, c.req.path.replace(/^\/api\/admin/, ''), user)) throw forbidden('Helpdesk staff can’t do that');
    return next();
  }
  throw forbidden('Administrator access required');
};

/** A sign-in on this browser waiting for its 2-step code. */
export function getPendingSession(c: Context): { session: SessionRow; user: UserRow; passkey: boolean } | null {
  // The first cookie: one started before a browser could hold several accounts.
  for (const name of [PENDING_COOKIE, SESSION_COOKIE]) {
    const token = getCookie(c, name);
    if (!token) continue;
    const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ? AND mfa_pending > 0', [sha256(token)]);
    if (!session || session.expires_at < now()) continue;
    const user = getUser(session.user_id);
    if (user && user.status === 'active') return { session, user, passkey: session.mfa_pending === 2 };
  }
  return null;
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

