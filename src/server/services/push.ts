/**
 * Web Push (RFC 8030) with VAPID (RFC 8292). A push says only which accounts
 * have new mail (encrypted for the browser, RFC 8291): the service worker
 * wakes up, asks Wren what's new over each account's session on that browser
 * and shows the notification itself. Nothing about the message passes through
 * the push service. One browser can get the notifications of every account
 * signed in on it, so a subscription is kept per account and device.
 */
import { all, get, getMeta, IN_LIST, listParam, now, run, setMeta } from '../db/index.js';
import { logger } from '../lib/log.js';
import { encryptPayload } from '../lib/webpush.js';
import { config } from '../config.js';
import { platform } from '../platform.js';

const log = logger('push');

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

interface Vapid {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateJwk: JsonWebKey;
}

let cached: { vapid: Vapid; key: CryptoKey } | null = null;

/** The instance's VAPID key pair, generated on first use and kept in the database. */
async function vapid(): Promise<{ vapid: Vapid; key: CryptoKey }> {
  if (cached) return cached;
  let v: Vapid | null = null;
  const stored = getMeta('vapid');
  if (stored) v = JSON.parse(stored) as Vapid;
  if (!v) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    v = { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
    setMeta('vapid', JSON.stringify(v));
  }
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cached = { vapid: v, key };
  return cached;
}

export async function vapidPublicKey(): Promise<string> {
  return (await vapid()).vapid.publicKey;
}

/** VAPID JWT (ES256) for one push service origin. */
export async function vapidJwt(audience: string, expiresAt = Math.floor(now() / 1000) + 12 * 3600): Promise<string> {
  const { key } = await vapid();
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const host = (() => {
    try {
      return new URL(config.publicUrl).hostname;
    } catch {
      return 'localhost';
    }
  })();
  const payload = b64url(enc.encode(JSON.stringify({ aud: audience, exp: expiresAt, sub: `mailto:postmaster@${host}` })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Push services browsers use. Anything else is refused, so the server can't be pointed at arbitrary URLs. */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** This device gets the account's notifications (a browser shares one subscription between its accounts). */
export function saveSubscription(userId: number, sub: SubscriptionInput, userAgent: string | null) {
  run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null, now()],
  );
}

/** This device stops getting the account's notifications. Returns how many other accounts it still notifies. */
export function removeSubscription(userId: number, endpoint: string): number {
  run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);
  return get<{ c: number }>('SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = ?', [endpoint])?.c ?? 0;
}

/**
 * A browser's subscription only notifies accounts signed in on it: forget the
 * ones that were signed out there before Wren cleaned up on sign-out.
 */
export function pruneDevice(endpoint: string, signedIn: number[]) {
  run(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id NOT IN ${IN_LIST}`, [endpoint, listParam(signedIn)]);
}

/**
 * Push to every device of these users: once per device, naming the accounts on
 * it that have something new. Returns how many devices took it.
 */
export async function pushToUsers(userIds: number[]): Promise<number> {
  if (!userIds.length) return 0;
  const subs = all<{ user_id: number; endpoint: string; p256dh: string; auth: string }>(
    `SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN ${IN_LIST} ORDER BY id`,
    [listParam(userIds)],
  );
  const devices = new Map<string, typeof subs>();
  for (const s of subs) devices.set(s.endpoint, [...(devices.get(s.endpoint) ?? []), s]);
  let delivered = 0;
  const { vapid: v } = await vapid();
  for (const [endpoint, rows] of devices) {
    try {
      const audience = new URL(endpoint).origin;
      const accounts = [...new Set(rows.map((r) => r.user_id))];
      // An endpoint's keys never change, so any of its rows will do.
      const payload = await encryptPayload(new TextEncoder().encode(JSON.stringify({ accounts })), rows[0].p256dh, rows[0].auth).catch(() => null);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${await vapidJwt(audience)}, k=${v.publicKey}`,
          TTL: '86400',
          Urgency: 'normal',
          ...(payload ? { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm' } : { 'Content-Length': '0' }),
        },
        body: (payload ?? undefined) as BodyInit | undefined,
      });
      if (res.status === 404 || res.status === 410) {
        run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]); // the browser unsubscribed
      } else if (res.ok) {
        delivered++;
        run(`UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ? AND user_id IN ${IN_LIST}`, [now(), endpoint, listParam(accounts)]);
      } else {
        log.warn(`Push to ${audience} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      log.warn('Push failed', err);
    }
  }
  return delivered;
}

const lastPush = new Map<number, number>();
const THROTTLE_MS = 15_000;

/**
 * New mail arrived in a mailbox: wake the devices of whoever reads it (the
 * person, or every member of a shared mailbox). Throttled so a burst of mail
 * produces one notification.
 */
export function notifyNewMail(mailboxUserId: number) {
  const ts = now();
  if (ts - (lastPush.get(mailboxUserId) ?? 0) < THROTTLE_MS) return;
  lastPush.set(mailboxUserId, ts);
  const box = get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', [mailboxUserId]);
  const users = box?.kind === 'shared' ? all<{ user_id: number }>('SELECT user_id FROM mailbox_members WHERE mailbox_id = ?', [mailboxUserId]).map((r) => r.user_id) : [mailboxUserId];
  if (!get(`SELECT 1 FROM push_subscriptions WHERE user_id IN ${IN_LIST} LIMIT 1`, [listParam(users)])) return;
  const p = pushToUsers(users).catch((err) => log.warn('Push failed', err));
  const defer = platform().defer;
  if (defer) defer(p);
}

export { fromB64url };
