/**
 * Unlocking the admin panel in a native app (Wren for Mac).
 *
 * An app password reads and sends mail; on its own it never reaches the admin panel. To act as an
 * administrator, the app asks for the account password (never the app password) and then one
 * second step:
 *  - totp: a code from the authenticator app (or a recovery code), when 2-step sign-in is on;
 *  - web: approval from Wren in a browser where this person signed in with two factors, by typing
 *    the number the app shows, so a request can't be approved by accident or by a lucky guess;
 *  - email: a 6-digit code sent to the confirmed recovery address. Never the Wren mailbox, which
 *    whoever holds the app password can read.
 * That gives the app an admin token: 15 minutes of use and an hour at most, good only together with
 * the same app password. It reaches the whole admin panel, as a browser session does. Each request
 * still goes through the usual admin checks (role, helpdesk limits, admin IP allowlist, the owner's
 * password for the encryption key) and lands in the audit log marked as coming from the app.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Role } from '../../shared/types.js';
import { config } from '../config.js';
import { all, get, now, run, tx } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { hmac, randomDigits, randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../lib/http.js';
import { authenticateAppPassword, appPasswordRefusal } from '../http/app-password.js';
import { adminIpAllowed, browserSessions, clearRateLimit, clientIp, rateLimit, requireUserReady, type AppEnv } from '../http/context.js';
import { escapeHtml } from '../mail/compose.js';
import { getSettings } from '../settings.js';
import { audit } from './audit.js';
import { hasPasskey } from './passkeys.js';
import { clientCountry, recordSignIn } from './sign-ins.js';
import { sendSystemEmail, systemTemplate } from './system-mail.js';
import { checkTwoStepCode, roleOf, type UserRow } from './users.js';

export const UNLOCK = {
  /** From the password to the second step. */
  challengeMs: 10 * 60_000,
  /** An unlock ends after this long unused… */
  idleMs: 15 * 60_000,
  /** …and this long after it began, used or not. */
  maxMs: 60 * 60_000,
  /** Wrong emailed codes before that code stops working. */
  emailTries: 5,
};

export type UnlockStep = 'totp' | 'web' | 'email';
const STEPS: readonly UnlockStep[] = ['totp', 'web', 'email'];

/** How each unlock shows in sign-in activity. */
const SIGN_IN_METHOD = { totp: 'app-admin+2fa', web: 'app-admin+web', email: 'app-admin+email' } as const;

interface UnlockRow {
  id: string;
  ref: string;
  user_id: number;
  api_key_id: number;
  number: number;
  device: string;
  ip: string | null;
  country: string | null;
  web_state: 'asked' | 'approved' | 'denied' | null;
  email_code: string | null;
  email_tries: number;
  token_hash: string | null;
  method: string | null;
  created_at: number;
  granted_at: number | null;
  last_used_at: number | null;
  expires_at: number;
}

/** Who may open the admin panel: their role there, or null. */
export function adminRole(user: Pick<UserRow, 'role' | 'helpdesk' | 'kind' | 'status'>): Role | null {
  if (user.kind !== 'person' || user.status !== 'active') return null;
  const role = roleOf(user);
  return role === 'user' ? null : role;
}

/** The second steps this person can use, and where an emailed code would go ("a…@example.com"). */
export function unlockSteps(user: UserRow) {
  const recovery = user.recovery_email && user.recovery_verified_at ? user.recovery_email : null;
  return {
    totp: !!user.totp_enabled,
    // Approving needs a browser signed in with two factors, which takes 2-step sign-in or a passkey.
    web: !!user.totp_enabled || hasPasskey(user.id),
    email: recovery ? maskEmail(recovery) : null,
  };
}

function maskEmail(address: string): string {
  const [local, domain] = address.split('@');
  return `${local.slice(0, 1)}…@${domain}`;
}

/** A two-digit number to match, from 10 to 99. */
const twoDigits = () => 10 + (Number(randomDigits(4)) % 90);

const cleanDevice = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '');

const expired = () => new HttpError(401, 'This unlock expired. Start again.', 'unlock_expired');

/** The challenge this app holds, if it's still waiting for its second step. */
function challengeRow(user: UserRow, keyId: number, challenge: unknown): UnlockRow {
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(challenge)) throw expired();
  const row = get<UnlockRow>('SELECT * FROM admin_unlocks WHERE id = ? AND user_id = ? AND api_key_id = ? AND token_hash IS NULL', [sha256(challenge), user.id, keyId]);
  if (!row || row.expires_at <= now()) throw expired();
  return row;
}

/** Step one: the account password. Answers a challenge for the second step. */
export async function startUnlock(c: Context, user: UserRow, keyId: number, password: unknown, device: unknown) {
  const role = adminRole(user);
  if (!role) throw forbidden('Only administrators and helpdesk staff can open the admin panel');
  const ip = clientIp(c);
  if (!adminIpAllowed(ip)) throw new HttpError(403, 'The admin panel can’t be used from this network. Ask an administrator to add your IP address to the allowlist.', 'admin_ip_blocked');
  if (typeof password !== 'string' || !password || password.length > 256) throw badRequest('Enter your account password');
  // The same limits as the sign-in page, so this isn't a second place to guess passwords.
  const max = getSettings()['security.maxLoginAttempts'];
  rateLimit(`login:ip:${ip}`, max * 3, 15 * 60_000);
  rateLimit(`login:user:${normalizeEmail(user.email)}`, max, 15 * 60_000);
  if (!(await verifyPassword(password, user.password_hash))) {
    audit(user.id, 'auth.admin_unlock_failed', user.email, { reason: 'wrong password', device: cleanDevice(device) }, ip);
    recordSignIn(c, user.id, 'app-admin', 'wrong_password');
    throw unauthorized('That’s not your account password. (Your app password doesn’t work here.)');
  }
  clearRateLimit(`login:user:${normalizeEmail(user.email)}`);
  const steps = unlockSteps(user);
  if (!steps.totp && !steps.web && !steps.email) {
    throw new HttpError(403, 'To open the admin panel in an app, first turn on 2-step sign-in, add a passkey, or confirm a recovery email in Wren on the web (Settings → Security).', 'unlock_needs_second_step');
  }
  const challenge = randomToken(32);
  const ts = now();
  const row = { id: sha256(challenge), number: twoDigits() };
  tx(() => {
    // One unlock in progress per app.
    run('DELETE FROM admin_unlocks WHERE api_key_id = ? AND token_hash IS NULL', [keyId]);
    run(
      `INSERT INTO admin_unlocks (id, ref, user_id, api_key_id, number, device, ip, country, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, randomToken(12), user.id, keyId, row.number, cleanDevice(device), ip || null, clientCountry(c), ts, ts + UNLOCK.challengeMs],
    );
  });
  return { challenge, role, steps, expiresAt: ts + UNLOCK.challengeMs };
}

/** Ask Wren on the web to approve: the person types this number there. */
export function askWeb(user: UserRow, keyId: number, challenge: unknown) {
  const row = challengeRow(user, keyId, challenge);
  if (!unlockSteps(user).web) throw badRequest('Approving from the web needs 2-step sign-in or a passkey on your account');
  if (row.web_state === null) run(`UPDATE admin_unlocks SET web_state = 'asked' WHERE id = ?`, [row.id]);
  return { number: row.number, url: `${config.publicUrl}/approve` };
}

/** Email a 6-digit code to the confirmed recovery address (replacing any earlier one). */
export async function sendEmailCode(c: Context, user: UserRow, keyId: number, challenge: unknown) {
  const row = challengeRow(user, keyId, challenge);
  const to = user.recovery_email && user.recovery_verified_at ? user.recovery_email : null;
  if (!to) throw badRequest('Your account has no confirmed recovery email');
  rateLimit(`admin-unlock-email:${user.id}`, 5, 60 * 60_000);
  const code = randomDigits(6);
  run('UPDATE admin_unlocks SET email_code = ?, email_tries = 0 WHERE id = ?', [hmac(`admin-unlock:${row.id}:${code}`), row.id]);
  const where = [clientIp(c), clientCountry(c)].filter(Boolean).join(', ');
  await sendSystemEmail({
    to: [to],
    userId: user.id,
    subject: 'Your code to unlock the admin panel',
    html: systemTemplate({
      title: 'Unlock the admin panel',
      paragraphs: [
        `${escapeHtml(row.device || 'An app')} asked to unlock the admin panel for <b>${escapeHtml(user.email)}</b>${where ? ` (${escapeHtml(where)})` : ''}, after your account password was entered. To allow it, enter this code there:`,
        `<b>${code}</b>`,
        'The code works once, for 10 minutes. If this wasn’t you, don’t enter it anywhere: someone has your password. Change it and revoke your app passwords in Settings → Security.',
      ],
    }),
  });
  return { sentTo: maskEmail(to) };
}

/**
 * Step two. Answers the admin token, or { waiting: true } while a web approval hasn't come yet
 * (the app asks again every few seconds).
 */
export function finishUnlock(c: Context, user: UserRow, keyId: number, challenge: unknown, step: unknown, code: unknown) {
  const row = challengeRow(user, keyId, challenge);
  if (!adminRole(user)) throw forbidden('Only administrators and helpdesk staff can open the admin panel');
  if (!STEPS.includes(step as UnlockStep)) throw badRequest('step is totp, web or email');
  const s = step as UnlockStep;
  const ip = clientIp(c);
  const fail = (reason: string, failure: 'wrong_code' | 'denied', message: string) => {
    audit(user.id, 'auth.admin_unlock_failed', user.email, { reason, step: s, device: row.device }, ip);
    recordSignIn(c, user.id, SIGN_IN_METHOD[s], failure);
    return unauthorized(message);
  };
  if (s === 'web') {
    if (row.web_state === 'denied') {
      run('DELETE FROM admin_unlocks WHERE id = ?', [row.id]);
      throw fail('denied in the browser', 'denied', 'The request was denied in the browser');
    }
    if (row.web_state !== 'approved') return { waiting: true as const };
  } else {
    const clean = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
    if (!clean || clean.length > 32) throw badRequest('Enter the code');
    // The same limit as the sign-in page's code step.
    rateLimit(`mfa:${user.id}`, 8, 15 * 60_000);
    if (s === 'totp') {
      if (!user.totp_enabled || !checkTwoStepCode(user, clean, ip)) throw fail('wrong 2-step code', 'wrong_code', 'That code is not valid');
    } else {
      const ok = !!row.email_code && row.email_tries < UNLOCK.emailTries && safeEqual(row.email_code, hmac(`admin-unlock:${row.id}:${clean}`));
      if (!ok) {
        run('UPDATE admin_unlocks SET email_tries = email_tries + 1 WHERE id = ?', [row.id]);
        throw fail('wrong emailed code', 'wrong_code', row.email_code && row.email_tries + 1 >= UNLOCK.emailTries ? 'Too many wrong codes. Send a new one.' : 'That code is not valid');
      }
    }
    clearRateLimit(`mfa:${user.id}`);
  }
  const token = randomToken(32);
  const ts = now();
  tx(() => {
    // One unlock per app at a time.
    run('DELETE FROM admin_unlocks WHERE api_key_id = ? AND token_hash IS NOT NULL', [keyId]);
    run('UPDATE admin_unlocks SET token_hash = ?, method = ?, email_code = NULL, granted_at = ?, last_used_at = ?, expires_at = ? WHERE id = ?', [
      sha256(token),
      s,
      ts,
      ts,
      ts + UNLOCK.maxMs,
      row.id,
    ]);
  });
  audit(user.id, 'auth.admin_unlocked', user.email, { step: s, device: row.device, via: 'app' }, ip);
  recordSignIn(c, user.id, SIGN_IN_METHOD[s]);
  return { token, role: adminRole(user), expiresAt: ts + UNLOCK.maxMs, idleSeconds: UNLOCK.idleMs / 1000 };
}

/** End this app's unlock (it locks itself on quit, sleep and screen lock). */
export function lockAdmin(user: UserRow, keyId: number) {
  return { locked: run('DELETE FROM admin_unlocks WHERE user_id = ? AND api_key_id = ?', [user.id, keyId]).changes > 0 };
}

// ── Approving from the web ──────────────────────────────────────────────────

/** Unlock requests waiting for approval for the accounts signed in on this browser. */
export function pendingApprovals(c: Context) {
  const ts = now();
  return browserSessions(c).flatMap(({ user, session }) =>
    all<UnlockRow>(`SELECT * FROM admin_unlocks WHERE user_id = ? AND web_state = 'asked' AND token_hash IS NULL AND expires_at > ? ORDER BY created_at`, [user.id, ts]).map((r) => ({
      id: r.ref,
      accountId: user.id,
      account: user.email,
      device: r.device,
      ip: r.ip,
      country: r.country,
      at: r.created_at,
      expiresAt: r.expires_at,
      // A browser signed in with only a password can't vouch for a second factor.
      canApprove: !!session.strong,
    })),
  );
}

/** The number typed in the browser (approve if it's the app's, deny if not), or null to deny. */
export function answerApproval(c: Context, ref: string, number: number | null) {
  const row = /^[A-Za-z0-9_-]{8,40}$/.test(ref)
    ? get<UnlockRow>(`SELECT * FROM admin_unlocks WHERE ref = ? AND web_state = 'asked' AND token_hash IS NULL AND expires_at > ?`, [ref, now()])
    : undefined;
  const s = row && browserSessions(c).find((b) => b.user.id === row.user_id);
  if (!row || !s) throw notFound('This request is no longer waiting. Start again in the app if you still need it.');
  const ip = clientIp(c);
  if (number !== null && !s.session.strong) throw forbidden('To approve, sign out and sign in again with your 2-step code or a passkey');
  if (number !== null && number === row.number) {
    run(`UPDATE admin_unlocks SET web_state = 'approved' WHERE id = ?`, [row.id]);
    audit(row.user_id, 'auth.admin_unlock_approved', s.user.email, { device: row.device, from: row.ip }, ip);
    return { approved: true };
  }
  run(`UPDATE admin_unlocks SET web_state = 'denied' WHERE id = ?`, [row.id]);
  audit(row.user_id, 'auth.admin_unlock_denied', s.user.email, { device: row.device, from: row.ip, reason: number === null ? 'denied' : 'wrong number' }, ip);
  if (number !== null) throw badRequest('That isn’t the number the app showed, so the request was denied. Start again in the app if it was you.');
  return { approved: false };
}

// ── Using an unlock ─────────────────────────────────────────────────────────

/** The admin token's row, if it's still good for this app password. */
function grantRow(user: UserRow, keyId: number, token: string): UnlockRow | null {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = get<UnlockRow>('SELECT * FROM admin_unlocks WHERE token_hash = ? AND user_id = ? AND api_key_id = ?', [sha256(token), user.id, keyId]);
  if (!row) return null;
  const ts = now();
  if (row.expires_at <= ts || (row.last_used_at ?? 0) <= ts - UNLOCK.idleMs) {
    run('DELETE FROM admin_unlocks WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

/**
 * Who is calling /api/admin: an app with its app password and an unlock (X-Wren-Admin), or else a
 * browser session as usual. The usual admin checks run after this either way.
 */
export const adminCaller: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('x-wren-admin');
  if (token === undefined) return requireUserReady(c, next);
  const locked = () => new HttpError(401, 'The admin panel is locked. Unlock it again.', 'admin_locked');
  const found = authenticateAppPassword(c.req.header('authorization'));
  if (!found || appPasswordRefusal(found.user)) throw locked();
  const row = grantRow(found.user, found.keyId, token);
  if (!row) throw locked();
  run('UPDATE admin_unlocks SET last_used_at = ? WHERE id = ?', [now(), row.id]);
  c.set('user', found.user);
  c.set('session', null);
  c.set('apiKeyId', found.keyId);
  c.set('via', 'app');
  await next();
};

export function pruneUnlocks(ts = now()) {
  run('DELETE FROM admin_unlocks WHERE expires_at < ?', [ts]);
}
