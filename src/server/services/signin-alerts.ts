/**
 * "New sign-in to your account" emails. Each browser gets a long-lived
 * device cookie; signing in from one Wren hasn't seen before sends an alert
 * to the person's mailbox and their verified recovery address. The very
 * first device on an account is recorded quietly.
 */
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { all, get, now, run } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { escapeHtml } from '../mail/compose.js';
import { clientIp } from '../http/context.js';
import { logger } from '../lib/log.js';
import { appUrl, sendSystemEmail, systemTemplate } from './system-mail.js';
import { getPrefs, type UserRow } from './users.js';

const log = logger('signin-alerts');
export const DEVICE_COOKIE = 'wren_dev';
const MAX_ALERTS_PER_HOUR = 5;
const KEEP_DEVICES = 50;

/** "Chrome on macOS" from a user agent. */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Record where someone signed in from; alert them if it's a new device. */
export async function noteSignIn(c: Context, user: UserRow, method: string) {
  try {
    let token = getCookie(c, DEVICE_COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      token = randomToken(24);
      setCookie(c, DEVICE_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: config.publicUrl.startsWith('https://'), path: '/', maxAge: 400 * 86_400 });
    }
    const hash = sha256(`${user.id}:${token}`);
    const ua = c.req.header('user-agent') ?? '';
    const label = describeDevice(ua);
    const ts = now();
    if (get('SELECT 1 FROM known_devices WHERE user_id = ? AND device_hash = ?', [user.id, hash])) {
      run('UPDATE known_devices SET last_seen = ? WHERE user_id = ? AND device_hash = ?', [ts, user.id, hash]);
      return;
    }
    const seen = get<{ c: number }>('SELECT COUNT(*) AS c FROM known_devices WHERE user_id = ?', [user.id])!.c;
    const recent = get<{ c: number }>('SELECT COUNT(*) AS c FROM known_devices WHERE user_id = ? AND first_seen > ?', [user.id, ts - 3_600_000])!.c;
    run('INSERT INTO known_devices (user_id, device_hash, label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', [user.id, hash, label, ts, ts]);
    const old = all<{ device_hash: string }>('SELECT device_hash FROM known_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT -1 OFFSET ?', [user.id, KEEP_DEVICES]);
    for (const o of old) run('DELETE FROM known_devices WHERE user_id = ? AND device_hash = ?', [user.id, o.device_hash]);
    if (!seen || recent >= MAX_ALERTS_PER_HOUR || user.kind === 'shared' || !getPrefs(user.id).signInAlerts) return;

    const ip = clientIp(c);
    const country = c.req.header('cf-ipcountry');
    const where = [ip && ip !== 'unknown' ? ip : '', country && country !== 'XX' ? country : ''].filter(Boolean).join(', ');
    const when = new Date(ts).toUTCString();
    const to = [user.email, ...(user.recovery_email && user.recovery_verified_at ? [user.recovery_email] : [])];
    await sendSystemEmail({
      to,
      userId: user.id,
      subject: `New sign-in: ${label}`,
      html: systemTemplate({
        title: 'New sign-in to your account',
        paragraphs: [
          `Your account <b>${escapeHtml(user.email)}</b> was just signed in to from a device we haven’t seen before.`,
          `<b>${escapeHtml(label)}</b><br>${escapeHtml(when)}${where ? `<br>${escapeHtml(where)}` : ''}<br>Signed in with ${escapeHtml(method)}`,
          'If this was you, there’s nothing to do. If not, change your password now and sign out your other sessions.',
        ],
        button: { label: 'Check your account', url: appUrl('/settings/security') },
        footer: 'You can turn these emails off in Settings → Security.',
      }),
    });
  } catch (err) {
    log.warn('Sign-in alert failed', err);
  }
}
