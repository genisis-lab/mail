/**
 * Sign-in history for admins: each attempt on an existing account, kept 90
 * days, with where it came from. A successful sign-in is flagged "new
 * location" when that person hasn't signed in from its country (or, without
 * one, its /24 or /48 network) in the last 90 days. Attempts on addresses
 * that don't exist stay in the audit log only.
 */
import type { Context } from 'hono';
import { all, get, now, run } from '../db/index.js';
import { ipNetwork } from '../lib/ip.js';
import { clientIp } from '../http/context.js';

export const SIGN_IN_DAYS = 90;
const DAY = 86_400_000;

/** password+2fa / passkey+2fa: the 2-step code step; link: a password reset or setup link. */
export type SignInMethod = 'password' | 'passkey' | 'password+2fa' | 'passkey+2fa' | 'link';
export type SignInFailure = 'wrong_password' | 'wrong_code' | 'passkey_rejected' | 'suspended';

/** The two-letter country Cloudflare says the request came from, if it says. */
export function clientCountry(c: Context): string | null {
  const raw = c.req.header('cf-ipcountry') ?? (c.req.raw as { cf?: { country?: unknown } }).cf?.country;
  const cc = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  // XX: unknown; T1: Tor.
  return /^[A-Z][A-Z0-9]$/.test(cc) && cc !== 'XX' ? cc : null;
}

/** Where a sign-in came from, for comparing with earlier ones: its country, else its network. */
export function signInLocation(country: string | null, ip: string): string {
  return country ?? ipNetwork(ip);
}

/**
 * Whether a successful sign-in from `location` is somewhere new for this person:
 * they have signed in within the window, but never from there. The first
 * sign-in on record sets the baseline quietly.
 */
export function isNewLocation(userId: number, location: string, ts = now()): boolean {
  if (!location) return false;
  const since = ts - SIGN_IN_DAYS * DAY;
  const before = `SELECT 1 FROM sign_ins WHERE user_id = ? AND ok = 1 AND created_at > ? AND location`;
  return !!get(`${before} != '' LIMIT 1`, [userId, since]) && !get(`${before} = ? LIMIT 1`, [userId, since, location]);
}

/** Record an attempt on an existing account. Answers whether a successful one came from a new location. */
export function recordSignIn(c: Context, userId: number, method: SignInMethod, failure?: SignInFailure): { newLocation: boolean } {
  const ts = now();
  const ip = clientIp(c);
  const country = clientCountry(c);
  const location = signInLocation(country, ip);
  const newLocation = !failure && isNewLocation(userId, location, ts);
  run(
    'INSERT INTO sign_ins (user_id, ok, method, reason, ip, country, location, user_agent, new_location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, failure ? 0 : 1, method, failure ?? null, ip || null, country, location, (c.req.header('user-agent') ?? '').slice(0, 300) || null, newLocation ? 1 : 0, ts],
  );
  return { newLocation };
}

/** One person's recent sign-ins, newest first. */
export function recentSignIns(userId: number, limit = 50) {
  return all<{ id: number; ok: number; method: string; reason: string | null; ip: string | null; country: string | null; user_agent: string | null; new_location: number; created_at: number }>(
    'SELECT id, ok, method, reason, ip, country, user_agent, new_location, created_at FROM sign_ins WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [userId, limit],
  ).map((r) => ({
    id: r.id,
    ok: !!r.ok,
    method: r.method,
    reason: r.reason,
    ip: r.ip,
    country: r.country,
    userAgent: r.user_agent,
    newLocation: !!r.new_location,
    at: r.created_at,
  }));
}

/** For the admin overview: failed sign-ins in the last day and new-location ones in the last week, and whose. */
export function signInSummary(ts = now()) {
  const failedSince = ts - DAY;
  const newSince = ts - 7 * DAY;
  const users = all<{ id: number; email: string; failed: number; new_location: number }>(
    `SELECT u.id, u.email, SUM(s.ok = 0 AND s.created_at > ?) AS failed, SUM(s.new_location = 1 AND s.created_at > ?) AS new_location
       FROM sign_ins s JOIN users u ON u.id = s.user_id
      WHERE s.created_at > ? AND ((s.ok = 0 AND s.created_at > ?) OR s.new_location = 1)
      GROUP BY u.id ORDER BY failed DESC, new_location DESC, u.email LIMIT 5`,
    [failedSince, newSince, newSince, failedSince],
  );
  const totals = get<{ failed: number | null; new_location: number | null }>(
    'SELECT SUM(ok = 0 AND created_at > ?) AS failed, SUM(new_location = 1) AS new_location FROM sign_ins WHERE created_at > ?',
    [failedSince, newSince],
  );
  return {
    failed24h: totals?.failed ?? 0,
    newLocation7d: totals?.new_location ?? 0,
    users: users.map((u) => ({ id: u.id, email: u.email, failed: u.failed, newLocation: u.new_location })),
  };
}

export function pruneSignIns(ts = now()) {
  run('DELETE FROM sign_ins WHERE created_at < ?', [ts - SIGN_IN_DAYS * DAY]);
}
