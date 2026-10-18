import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, run } from '../src/server/db/index';
import { encrypt, sha256, totpCode } from '../src/server/lib/crypto';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { pushToUsers } from '../src/server/services/push';
import { harness } from './harness';
import { browserPushKeys } from './webpush';

const h = harness();
const FCM = 'https://fcm.googleapis.com/fcm/send/shared-laptop';
let admin = 0;
let bob = 0;
let cat = 0;

/** One browser (one cookie jar) signed in to several accounts. */
const as = (id: number) => ({ 'X-Wren-Account': String(id) });
const accounts = async () => (await h.call('GET', '/api/auth/accounts')).body.accounts as { id: number; email: string; default: boolean; unread: number; latestId: number }[];
const signIn = (email: string, password: string) => h.call('POST', '/api/auth/login', { email, password });

async function deliver(to: string, subject: string) {
  const { raw } = await buildMime({ from: { address: 'kim@example.org', name: 'Kim' }, to: [{ address: to }], subject, text: 'Hello' });
  await ingest(raw, { rcptTo: [to], source: 'cloudflare-routing' });
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'laptop');
  for (const [email, name] of [
    ['bob@wren.test', 'Bob'],
    ['cat@wren.test', 'Cat'],
  ]) {
    expect((await h.call('POST', '/api/admin/users', { email, name, password: `${name} password 123` })).status).toBe(200);
  }
  const id = (email: string) => get<{ id: number }>('SELECT id FROM users WHERE email = ?', [email])!.id;
  [admin, bob, cat] = [id('admin@wren.test'), id('bob@wren.test'), id('cat@wren.test')];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('several accounts in one browser', () => {
  it('adds an account next to the one signed in, and each request names its account', async () => {
    const r = await signIn('bob@wren.test', 'Bob password 123');
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join('\n')).toMatch(new RegExp(`wren_sid_${bob}=`));
    expect(await accounts()).toMatchObject([
      { id: admin, email: 'admin@wren.test', default: true },
      { id: bob, email: 'bob@wren.test', default: false },
    ]);

    // No account named: the first one, as before.
    expect((await h.call('GET', '/api/auth/me')).body).toMatchObject({ user: { email: 'admin@wren.test' }, accounts: 2 });
    expect((await h.call('GET', '/api/auth/me', undefined, as(bob))).body.user.email).toBe('bob@wren.test');
    expect((await h.call('GET', '/api/auth/me', undefined, as(admin))).body.user.email).toBe('admin@wren.test');
    // An account this browser isn't signed in to is never swapped for another one.
    // (It tells the app that other accounts are signed in here, to offer them.)
    expect((await h.call('GET', '/api/auth/me', undefined, as(cat))).body).toMatchObject({ user: null, accounts: 2 });
    expect((await h.call('GET', '/api/auth/me', undefined, { 'X-Wren-Account': 'nope' })).body.user).toBeNull();
    expect((await h.call('GET', '/api/mail/threads', undefined, as(cat))).status).toBe(401);

    await deliver('bob@wren.test', 'For Bob only');
    const bobs = (await h.call('GET', '/api/mail/threads?view=inbox', undefined, as(bob))).body.threads.map((t: any) => t.subject);
    const admins = (await h.call('GET', '/api/mail/threads?view=inbox')).body.threads.map((t: any) => t.subject);
    expect(bobs).toContain('For Bob only');
    expect(admins).not.toContain('For Bob only');
    // Links the browser opens itself carry ?account=.
    expect((await h.call('GET', `/api/mail/threads?view=inbox&account=${bob}`)).body.threads.map((t: any) => t.subject)).toContain('For Bob only');

    const list = await accounts();
    expect(list.find((a) => a.id === bob)!.unread).toBeGreaterThanOrEqual(1);
    expect(list.find((a) => a.id === bob)!.latestId).toBeGreaterThan(0);

    // Each account still sees only its own sessions.
    const sessions = (await h.call('GET', '/api/account/sessions', undefined, as(bob))).body.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
  });

  it('signing in again to an account already here replaces its session', async () => {
    const before = all('SELECT id FROM sessions WHERE user_id = ?', [bob]).length;
    expect((await signIn('bob@wren.test', 'Bob password 123')).status).toBe(200);
    expect(all('SELECT id FROM sessions WHERE user_id = ?', [bob]).length).toBe(before);
    expect((await accounts()).map((a) => a.id)).toEqual([admin, bob]);
  });

  it('a 2-step sign-in waits on its own, without signing anyone out', async () => {
    run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt('JBSWY3DPEHPK3PXP'), cat]);
    expect((await signIn('cat@wren.test', 'Cat password 123')).body).toEqual({ mfaRequired: true });
    expect((await h.call('GET', '/api/auth/me', undefined, as(bob))).body).toMatchObject({ user: { email: 'bob@wren.test' }, mfaPending: true });
    expect((await accounts()).map((a) => a.id)).toEqual([admin, bob]);

    // Giving up on it leaves both accounts signed in.
    expect((await h.call('POST', '/api/auth/cancel')).status).toBe(200);
    expect((await h.call('GET', '/api/auth/me')).body).toMatchObject({ user: { email: 'admin@wren.test' }, mfaPending: false });
    expect((await h.call('POST', '/api/auth/mfa', { code: '000000' })).status).toBe(401);

    expect((await signIn('cat@wren.test', 'Cat password 123')).body).toEqual({ mfaRequired: true });
    const ok = await h.call('POST', '/api/auth/mfa', { code: totpCode('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30_000)) });
    expect(ok.body.user.email).toBe('cat@wren.test');
    expect((await accounts()).map((a) => a.id)).toEqual([admin, bob, cat]);
    expect(get('SELECT 1 FROM sessions WHERE user_id = ? AND mfa_pending > 0', [cat])).toBeUndefined();
  });

  it('shares one push subscription between the accounts, and a push says whose mail is new', async () => {
    const browser = await browserPushKeys();
    for (const id of [admin, bob]) expect((await h.call('POST', '/api/me/push/subscribe', { endpoint: FCM, keys: browser.keys }, as(id))).status).toBe(200);
    expect(all('SELECT user_id FROM push_subscriptions WHERE endpoint = ? ORDER BY user_id', [FCM]).map((r: any) => r.user_id)).toEqual([admin, bob]);
    // Cat doesn't get them here yet, while two other accounts here do (so signing in to Cat can turn them on too).
    expect((await h.call('POST', '/api/me/push/status', { endpoint: FCM }, as(cat))).body).toEqual({ subscribed: false, others: 2 });
    expect((await h.call('POST', '/api/me/push/status', { endpoint: FCM }, as(bob))).body).toEqual({ subscribed: true, others: 1 });

    const seen: { url: string; body: Uint8Array }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, body: init.body as Uint8Array });
      return new Response(null, { status: 201 });
    });
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] }); // past the push throttle from Bob's earlier mail
    await deliver('bob@wren.test', 'Pushed to Bob');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((s) => s.url)).toEqual([FCM]);
    expect(await browser.read(seen[0].body)).toEqual({ accounts: [bob] });
    // Several accounts with news on one device: one push names them all.
    seen.length = 0;
    expect(await pushToUsers([admin, bob])).toBe(1);
    expect(await browser.read(seen[0].body)).toEqual({ accounts: [admin, bob] });

    // What the service worker asks next, over that account's session.
    const n = (await h.call('GET', '/api/me/notifications', undefined, as(bob))).body;
    expect(n.account).toEqual({ id: bob, address: 'bob@wren.test', name: 'Bob', path: `/u/${bob}` });
    expect(n.accounts).toBe(3);
    expect(n.items.map((i: any) => i.subject)).toContain('Pushed to Bob');
    expect((await h.call('GET', '/api/me/notifications', undefined, as(admin))).body.account.path).toBe('');

    // Turning it off for one account keeps the browser's subscription for the other.
    expect((await h.call('POST', '/api/me/push/unsubscribe', { endpoint: FCM }, as(admin))).body).toEqual({ ok: true, shared: 1 });
    expect((await h.call('POST', '/api/me/push/subscribe', { endpoint: FCM, keys: browser.keys }, as(admin))).status).toBe(200);
  });

  it('opens pictures in an email from any account signed in here, unless the link names one', async () => {
    const { raw } = await buildMime({
      from: { address: 'kim@example.org', name: 'Kim' },
      to: [{ address: 'bob@wren.test' }],
      subject: 'Photo',
      text: 'See attached',
      attachments: [{ filename: 'dot.png', contentType: 'image/png', content: Buffer.from('iVBORw0KGgo=', 'base64') }],
    });
    await ingest(raw, { rcptTo: ['bob@wren.test'], source: 'cloudflare-routing' });
    const att = get<{ id: number }>('SELECT id FROM attachments WHERE user_id = ? ORDER BY id DESC', [bob])!;
    expect((await h.request(`/api/attachments/${att.id}?inline=1`)).status).toBe(200);
    expect((await h.request(`/api/attachments/${att.id}?inline=1&account=${bob}`)).status).toBe(200);
    expect((await h.request(`/api/attachments/${att.id}?inline=1&account=${admin}`)).status).toBe(404);
  });

  it('signs out of one account: the others stay, and this device stops getting its notifications', async () => {
    const r = await h.call('POST', '/api/auth/logout', { endpoint: FCM }, as(bob));
    expect(r.body).toEqual({ ok: true, remaining: 2 });
    expect((await accounts()).map((a) => a.id)).toEqual([admin, cat]);
    expect((await h.call('GET', '/api/auth/me', undefined, as(bob))).body.user).toBeNull();
    expect((await h.call('GET', '/api/auth/me')).body.user.email).toBe('admin@wren.test');
    expect(all('SELECT user_id FROM push_subscriptions WHERE endpoint = ?', [FCM]).map((r: any) => r.user_id)).toEqual([admin]);
  });

  it('when the first account signs out, the next one takes its place', async () => {
    expect((await signIn('bob@wren.test', 'Bob password 123')).status).toBe(200);
    expect((await accounts()).map((a) => a.id)).toEqual([admin, cat, bob]);
    const r = await h.call('POST', '/api/auth/logout', {}, as(admin));
    expect(r.body.remaining).toBe(2);
    // Cat (added first) now has the first cookie, so links that name no account act as Cat.
    expect(r.headers.getSetCookie().join('\n')).toMatch(/wren_sid=[^;]+/);
    expect((await accounts()).map((a) => ({ id: a.id, default: a.default }))).toEqual([
      { id: cat, default: true },
      { id: bob, default: false },
    ]);
    expect((await h.call('GET', '/api/auth/me')).body.user.email).toBe('cat@wren.test');
    expect((await h.call('GET', '/api/auth/me', undefined, as(cat))).body.user.email).toBe('cat@wren.test');
    expect((await h.call('GET', '/api/auth/me', undefined, as(bob))).body.user.email).toBe('bob@wren.test');
    // Admin signs back in next to them.
    expect((await signIn('admin@wren.test', 'a very long password')).status).toBe(200);
    expect((await accounts()).map((a) => a.id)).toEqual([cat, bob, admin]);
  });

  it('forgets an account whose session ended elsewhere', async () => {
    run('DELETE FROM sessions WHERE user_id = ?', [bob]); // "Sign out everywhere" from another device
    const r = await h.call('GET', '/api/auth/accounts');
    expect(r.body.accounts.map((a: any) => a.id)).toEqual([cat, admin]);
    expect(r.headers.getSetCookie().join('\n')).toMatch(new RegExp(`wren_sid_${bob}=;`));
    expect((await h.call('GET', '/api/mail/threads', undefined, as(bob))).status).toBe(401);
  });

  it('signs out of every account at once', async () => {
    const count = () => get<{ c: number }>('SELECT COUNT(*) AS c FROM sessions WHERE user_id IN (?, ?)', [admin, cat])!.c;
    const before = count();
    const r = await h.call('POST', '/api/auth/logout?all=1');
    expect(r.body).toEqual({ ok: true, remaining: 0 });
    expect(await accounts()).toEqual([]);
    expect((await h.call('GET', '/api/auth/me')).body).toMatchObject({ user: null, accounts: 0 });
    // This browser's two sessions end; the admin's session from setup (another browser) stays.
    expect(count()).toBe(before - 2);
  });

  it(`stops at ten accounts on one browser`, async () => {
    run('UPDATE users SET totp_enabled = 0 WHERE id = ?', [cat]);
    const people = ['admin@wren.test', 'bob@wren.test', 'cat@wren.test'];
    await signIn('admin@wren.test', 'a very long password');
    for (let i = 0; i < 8; i++) {
      const email = `p${i}@wren.test`;
      expect((await h.call('POST', '/api/admin/users', { email, name: `P${i}`, password: 'person password 1' }, as(admin))).status).toBe(200);
      people.push(email);
    }
    for (const email of people.slice(1, 10)) {
      const password = email === 'bob@wren.test' ? 'Bob password 123' : email === 'cat@wren.test' ? 'Cat password 123' : 'person password 1';
      expect((await signIn(email, password)).status).toBe(200);
    }
    expect(await accounts()).toHaveLength(10);
    const eleventh = await signIn(people[10], 'person password 1');
    expect(eleventh.status).toBe(400);
    expect(eleventh.body.code).toBe('too_many_accounts');
    expect(await accounts()).toHaveLength(10);
    // Signing in again to one already here is still fine.
    expect((await signIn('bob@wren.test', 'Bob password 123')).status).toBe(200);
  });

  it('keeps sessions apart from the browser that made them', async () => {
    // Another browser only ever sees its own accounts.
    await h.login('bob@wren.test', 'Bob password 123', 'phone');
    expect((await accounts()).map((a) => a.email)).toEqual(['bob@wren.test']);
    expect((await h.call('GET', '/api/auth/me', undefined, as(admin))).body.user).toBeNull();
    const tokens = all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', [bob]).map((s) => s.id);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t !== sha256(''))).toBe(true);
  });
});
