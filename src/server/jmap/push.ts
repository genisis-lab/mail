/**
 * Telling mail apps that something changed (RFC 8620 section 7).
 *
 *  - PushSubscription: Wren POSTs a small StateChange to a URL the app gave
 *    it (usually its push service), encrypted with RFC 8291 when the app sent
 *    keys. Nothing stays connected, which suits a Durable Object best.
 *  - EventSource: the app keeps a stream open; Wren writes a "state" event
 *    when something changes and a "ping" now and then. Streams are closed
 *    after a while and the app reconnects.
 *
 * flushPush() runs after requests, incoming mail and background work. It
 * looks for mailboxes whose change counter moved since the last push.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { randomToken } from '../lib/crypto.js';
import { logger } from '../lib/log.js';
import { platform } from '../platform.js';
import { getSettings } from '../settings.js';
import { currentState } from './changes.js';
import { MethodError, SetError, asSetError } from './errors.js';
import { accountId } from './ids.js';
import { CAP, getIds, getProperties, isObject, method, pick } from './request.js';

const log = logger('jmap-push');

const TYPES = ['Email', 'Mailbox', 'Thread', 'EmailDelivery'];
const MAX_SUBSCRIPTION_MS = 7 * 86_400_000;

// ── Payload encryption (RFC 8291, aes128gcm) ────────────────────────────────

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Encrypt a push message for a user agent's P-256 key and auth secret. */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as EcdhKeyDeriveParams, local.privateKey, 256));
  const enc = new TextEncoder();
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // One record: the message, then the 0x02 delimiter of the last record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, concat(plaintext, new Uint8Array([2])) as BufferSource));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// ── Sending ─────────────────────────────────────────────────────────────────

/** Push URLs must be public HTTPS addresses (not this network's own hosts). */
export function validPushUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return false;
    // IP literals (v4 and v6) are refused: a push service has a name.
    if (/^[\d.]+$/.test(host) || host.startsWith('[')) return false;
    return true;
  } catch {
    return false;
  }
}

interface PushRow {
  id: number;
  user_id: number;
  url: string;
  p256dh: string | null;
  auth: string | null;
  verification_code: string;
  verified: number;
  types: string | null;
  expires_at: number;
}

async function post(sub: PushRow, payload: unknown): Promise<boolean> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = sub.p256dh && sub.auth;
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: { 'Content-Type': encrypted ? 'application/octet-stream' : 'application/json', TTL: '86400', Urgency: 'normal', ...(encrypted ? { 'Content-Encoding': 'aes128gcm' } : {}) },
      body: (encrypted ? await encryptPayload(body, sub.p256dh!, sub.auth!) : body) as BodyInit,
      redirect: 'manual',
    });
    if (res.status === 404 || res.status === 410) {
      run('DELETE FROM jmap_push WHERE id = ?', [sub.id]);
      return false;
    }
    if (!res.ok) log.warn(`Push to ${new URL(sub.url).host} failed: ${res.status}`);
    return res.ok;
  } catch (err) {
    log.warn('Push failed', err);
    return false;
  }
}

/** Open EventSource streams, by user. The Durable Object is one process, so memory reaches them all. */
const streams = new Map<number, Set<{ types: Set<string>; send(event: string, data: unknown): void; closeAfterState: boolean; close(): void }>>();

/** Mailboxes that just had mail delivered (for the EmailDelivery type, which apps use to notify). */
const delivered = new Set<number>();

export function noteDelivery(userId: number) {
  delivered.add(userId);
}

function stateChange(userId: number, types: Set<string> | null, delivery: boolean) {
  const state = currentState(userId);
  const changed: Record<string, string> = {};
  for (const t of TYPES) if ((!types || types.has(t)) && (t !== 'EmailDelivery' || delivery)) changed[t] = state;
  return { '@type': 'StateChange', changed: { [accountId(userId)]: changed } };
}

let flushing: Promise<void> | null = null;

/** Push state changes to every app of every mailbox whose counter moved. */
export function flushPush(): Promise<void> {
  if (flushing) return flushing.then(() => flushPush());
  flushing = (async () => {
    const due = all<{ user_id: number; modseq: number }>('SELECT user_id, modseq FROM jmap_modseq WHERE modseq > pushed');
    for (const { user_id, modseq } of due) {
      run('UPDATE jmap_modseq SET pushed = ? WHERE user_id = ?', [modseq, user_id]);
      const delivery = delivered.delete(user_id);
      for (const s of streams.get(user_id) ?? []) {
        const change = stateChange(user_id, s.types, delivery);
        if (Object.keys(change.changed[accountId(user_id)]).length) {
          s.send('state', change);
          if (s.closeAfterState) s.close();
        }
      }
      // Not to people an admin turned mail apps off for, or suspended (their subscriptions wait, unused).
      const subs = all<PushRow>(
        `SELECT p.* FROM jmap_push p JOIN users u ON u.id = p.user_id
          WHERE p.user_id = ? AND p.verified = 1 AND p.expires_at > ? AND u.mail_apps_blocked = 0 AND u.status = 'active'`,
        [user_id, now()],
      );
      for (const sub of subs) {
        const types = sub.types ? new Set<string>(JSON.parse(sub.types)) : null;
        const change = stateChange(user_id, types, delivery);
        if (Object.keys(change.changed[accountId(user_id)]).length) await post(sub, change);
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Run flushPush after the response (or now, when the runtime can't defer). Cheap when nothing changed. */
export function schedulePush() {
  // Nobody listening: nothing to do (a new listener starts from the current state anyway).
  if (!streams.size && !get('SELECT 1 FROM jmap_push WHERE verified = 1 LIMIT 1')) return;
  if (!get('SELECT 1 FROM jmap_modseq WHERE modseq > pushed LIMIT 1')) return;
  const p = flushPush().catch((err) => log.warn('Push failed', err));
  platform().defer?.(p);
}

/** Push whatever changed, when mail apps are allowed at all. Called after requests, incoming mail and background work. */
export function pushChanges() {
  if (getSettings()['jmap.enabled']) schedulePush();
}

// ── EventSource ─────────────────────────────────────────────────────────────

const STREAM_LIFETIME_MS = 15 * 60_000;

export function eventSource(userId: number, query: { types?: string; closeafter?: string; ping?: string }): Response {
  const types = new Set(!query.types || query.types === '*' ? TYPES : query.types.split(',').filter((t) => TYPES.includes(t)));
  const pingSeconds = Math.min(Math.max(Number(query.ping) || 0, 0), 300);
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let entry: { types: Set<string>; send(event: string, data: unknown): void; closeAfterState: boolean; close(): void };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (lifetime) clearTimeout(lifetime);
        const set = streams.get(userId);
        set?.delete(entry);
        // An empty set would make schedulePush think someone is still listening.
        if (set && !set.size) streams.delete(userId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      entry = {
        types,
        closeAfterState: query.closeafter === 'state',
        send(event, data) {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            close();
          }
        },
        close,
      };
      const set = streams.get(userId) ?? new Set();
      set.add(entry);
      streams.set(userId, set);
      // The current state right away, so the app knows where it stands. Long-polling apps
      // (closeafter=state) instead wait for the next change.
      if (!entry.closeAfterState) entry.send('state', stateChange(userId, types, false));
      // At least 30 seconds between pings (RFC 8620 7.3 lets the server raise the interval).
      if (pingSeconds) timer = setInterval(() => entry.send('ping', { interval: Math.max(pingSeconds, 30) }), Math.max(pingSeconds, 30) * 1000);
      lifetime = setTimeout(close, STREAM_LIFETIME_MS);
    },
    cancel() {
      entry?.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

/** Close one person's open streams (mail apps turned off for them, or they were suspended). */
export function closeUserStreams(userId: number) {
  for (const s of [...(streams.get(userId) ?? [])]) s.close();
  streams.delete(userId);
}

/** Close every open stream (mail apps turned off for everyone; tests). */
export function closeStreams() {
  for (const set of streams.values()) for (const s of [...set]) s.close();
  streams.clear();
  delivered.clear();
}

// ── PushSubscription/get and /set (not tied to an account) ──────────────────

const PROPS = ['deviceClientId', 'url', 'keys', 'verificationCode', 'expires', 'types'];

function dto(r: PushRow & { device_client_id: string }) {
  return {
    id: `P${r.id}`,
    deviceClientId: r.device_client_id,
    // The URL and keys are write-only (RFC 8620 7.2.1: the server must not return them).
    url: null,
    keys: null,
    verificationCode: null,
    expires: new Date(r.expires_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    types: r.types ? JSON.parse(r.types) : null,
  };
}

const parseId = (id: unknown) => (typeof id === 'string' ? Number(/^P(\d+)$/.exec(id)?.[1] ?? 0) : 0);

function expiry(value: unknown): number {
  const max = now() + MAX_SUBSCRIPTION_MS;
  if (value === undefined || value === null) return max;
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) throw new SetError('invalidProperties', 'expires must be a UTCDate', { properties: ['expires'] });
  return Math.min(Math.max(t, now() + 60_000), max);
}

function types(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) throw new SetError('invalidProperties', 'types must be a list of type names', { properties: ['types'] });
  return JSON.stringify(value.filter((t: string) => TYPES.includes(t)));
}

method(
  'PushSubscription/get',
  CAP.core,
  (args, ctx) => {
    const wanted = getIds(args, ctx, true);
    const props = getProperties(args, PROPS);
    const rows = all<PushRow & { device_client_id: string }>('SELECT * FROM jmap_push WHERE user_id = ? ORDER BY id', [ctx.user.id]);
    const list = rows.map(dto).filter((s) => !wanted || wanted.includes(s.id));
    const found = new Set(list.map((s) => s.id));
    return { list: list.map((s) => pick(s, props)), notFound: wanted ? wanted.filter((id) => !found.has(id)) : [] };
  },
  { noAccount: true },
);

method(
  'PushSubscription/set',
  CAP.core,
  async (args, ctx) => {
    const userId = ctx.user.id;
    const created: Record<string, unknown> = {};
    const updated: Record<string, null> = {};
    const destroyed: string[] = [];
    const notCreated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const notDestroyed: Record<string, unknown> = {};
    if (args.ifInState !== undefined && args.ifInState !== null) throw new MethodError('invalidArguments', 'PushSubscription has no state');

    for (const [cid, obj] of Object.entries<Record<string, any>>(args.create ?? {})) {
      try {
        if (!isObject(obj)) throw new SetError('invalidProperties', 'Not an object');
        if (typeof obj.deviceClientId !== 'string' || !obj.deviceClientId || obj.deviceClientId.length > 255) throw new SetError('invalidProperties', 'deviceClientId is required', { properties: ['deviceClientId'] });
        if (!validPushUrl(obj.url)) throw new SetError('invalidProperties', 'url must be a public https URL', { properties: ['url'] });
        let keys: { p256dh: string; auth: string } | null = null;
        if (obj.keys !== undefined && obj.keys !== null) {
          const k = obj.keys as { p256dh?: unknown; auth?: unknown };
          if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || fromB64url(k.p256dh).length !== 65 || fromB64url(k.auth).length !== 16) {
            throw new SetError('invalidProperties', 'keys needs a P-256 p256dh and a 16-byte auth', { properties: ['keys'] });
          }
          keys = { p256dh: k.p256dh, auth: k.auth };
        }
        if (obj.verificationCode !== undefined && obj.verificationCode !== null) throw new SetError('invalidProperties', 'verificationCode is set later', { properties: ['verificationCode'] });
        if ((get<{ c: number }>('SELECT COUNT(*) AS c FROM jmap_push WHERE user_id = ?', [userId])?.c ?? 0) >= 20) throw new SetError('forbidden', 'Too many push subscriptions');
        const code = randomToken(16);
        const expires = expiry(obj.expires);
        // A device re-subscribing replaces its old subscription.
        run('DELETE FROM jmap_push WHERE user_id = ? AND device_client_id = ?', [userId, obj.deviceClientId]);
        const id = insert(
          `INSERT INTO jmap_push (user_id, key_id, device_client_id, url, p256dh, auth, verification_code, types, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, ctx.keyId, obj.deviceClientId, obj.url, keys?.p256dh ?? null, keys?.auth ?? null, code, types(obj.types), expires, now()],
        );
        const row = get<PushRow>('SELECT * FROM jmap_push WHERE id = ?', [id])!;
        ctx.createdIds.set(cid, `P${id}`);
        created[cid] = { id: `P${id}`, keys: null, expires: dto({ ...row, device_client_id: obj.deviceClientId }).expires };
        // The app proves it can read pushes at this URL by sending the code back.
        const verify = post(row, { '@type': 'PushVerification', pushSubscriptionId: `P${id}`, verificationCode: code });
        platform().defer ? platform().defer!(verify) : await verify;
      } catch (err) {
        notCreated[cid] = asSetError(err);
      }
    }

    for (const [rawId, patch] of Object.entries<Record<string, unknown>>(args.update ?? {})) {
      const id = parseId(rawId);
      try {
        const row = get<PushRow>('SELECT * FROM jmap_push WHERE id = ? AND user_id = ?', [id, userId]);
        if (!row) throw new SetError('notFound', 'No such push subscription');
        if (!isObject(patch)) throw new SetError('invalidPatch', 'Not an object');
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'verificationCode') {
            if (v !== row.verification_code) throw new SetError('invalidProperties', 'That verification code is wrong', { properties: ['verificationCode'] });
            run('UPDATE jmap_push SET verified = 1 WHERE id = ?', [id]);
          } else if (k === 'expires') run('UPDATE jmap_push SET expires_at = ? WHERE id = ?', [expiry(v), id]);
          else if (k === 'types') run('UPDATE jmap_push SET types = ? WHERE id = ?', [types(v), id]);
          else throw new SetError('invalidProperties', `Can't change ${k}`, { properties: [k] });
        }
        updated[rawId] = null;
      } catch (err) {
        notUpdated[rawId] = asSetError(err);
      }
    }

    for (const rawId of (args.destroy ?? []) as unknown[]) {
      const r = run('DELETE FROM jmap_push WHERE id = ? AND user_id = ?', [parseId(rawId), userId]);
      if (r.changes) destroyed.push(String(rawId));
      else notDestroyed[String(rawId)] = new SetError('notFound', 'No such push subscription');
    }
    return { created, updated, destroyed, notCreated, notUpdated, notDestroyed };
  },
  { noAccount: true },
);

/** Drop expired subscriptions (from maintenance). */
export function pruneSubscriptions() {
  run('DELETE FROM jmap_push WHERE expires_at < ?', [now()]);
}
