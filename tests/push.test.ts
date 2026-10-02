import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { fromB64url, pushToUsers, validEndpoint, vapidJwt, vapidPublicKey } from '../src/server/services/push';
import { harness } from './harness';

const h = harness();
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
});

afterEach(() => vi.unstubAllGlobals());

describe('web push', () => {
  it('signs VAPID tokens a push service can verify', async () => {
    const pub = fromB64url(await vapidPublicKey());
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(4);
    const jwt = await vapidJwt('https://fcm.googleapis.com', 2_000_000_000);
    const [header, payload, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(header)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(payload)))).toMatchObject({ aud: 'https://fcm.googleapis.com', exp: 2_000_000_000 });
    const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(sig), new TextEncoder().encode(`${header}.${payload}`));
    expect(ok).toBe(true);
  });

  it('only accepts real push services', async () => {
    expect(validEndpoint(FCM)).toBe(true);
    expect(validEndpoint('https://web.push.apple.com/QGuQyavXutnMc')).toBe(true);
    expect(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(validEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(validEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    const bad = await h.call('POST', '/api/me/push/subscribe', { endpoint: 'https://127.0.0.1/x', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
    expect(bad.status).toBe(400);
  });

  it('sends payload-less pushes with VAPID auth and drops expired subscriptions', async () => {
    const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
    expect((await h.call('POST', '/api/me/push/subscribe', { endpoint: FCM, keys })).status).toBe(200);
    expect((await h.call('POST', '/api/me/push/subscribe', { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gone', keys })).status).toBe(200);
    expect((await h.call('GET', '/api/me/push')).body.devices).toBe(2);

    const seen: { url: string; headers: Headers; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: init.body });
      return new Response(null, { status: url.includes('/gone') ? 410 : 201 });
    });
    const userId = all<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)[0].id;
    expect(await pushToUsers([userId])).toBe(1);
    const fcm = seen.find((s) => s.url === FCM)!;
    expect(fcm.headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(fcm.headers.get('ttl')).toBe('86400');
    expect(fcm.body).toBeUndefined();
    expect(all('SELECT endpoint FROM push_subscriptions')).toEqual([{ endpoint: FCM }]);
  });

  it('pushes when inbox mail arrives, and the worker can read what it is', async () => {
    const pushed: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      pushed.push(url);
      return new Response(null, { status: 201 });
    });
    const { raw } = await buildMime({ from: { address: 'kim@example.org', name: 'Kim' }, to: [{ address: 'admin@wren.test' }], subject: 'Contract ready', text: 'Sign here' });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toEqual([FCM]);
    // A second message right away is throttled into the same notification.
    const second = await buildMime({ from: { address: 'kim@example.org', name: 'Kim' }, to: [{ address: 'admin@wren.test' }], subject: 'And the invoice', text: 'x' });
    await ingest(second.raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toHaveLength(1);

    const n = (await h.call('GET', '/api/me/notifications')).body;
    expect(n.total).toBe(3); // the welcome message is unread too
    expect(n.items.map((i: any) => i.subject)).toEqual(expect.arrayContaining(['Contract ready', 'And the invoice']));
    expect(n.items[0]).toMatchObject({ mailbox: null, from: { name: 'Kim' } });
  });
});
