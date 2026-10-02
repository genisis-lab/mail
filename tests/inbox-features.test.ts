import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { parseMail } from '../src/server/mail/parse';
import { categorize } from '../src/server/mail/categorize';
import { isPublicHttpsUrl } from '../src/server/services/unsubscribe';
import { harness, outbox } from './harness';

const h = harness();
let admin = 0;
let bob = 0;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  bob = (await h.call('POST', '/api/admin/users', { email: 'bob@wren.test', name: 'Bob', password: 'bob password 123' })).body.id;
  await h.call('POST', '/api/admin/addresses', { address: 'hello@wren.test', kind: 'alias', userId: admin, name: '', canSend: true, enabled: true, description: '', members: [] });
  h.as('admin');
});

afterEach(() => vi.unstubAllGlobals());

async function receive(opts: { from: string; to: string; subject: string; text?: string; headers?: Record<string, string>; rcpt?: string; name?: string }) {
  const { raw, messageId } = await buildMime({
    from: { address: opts.from, name: opts.name ?? '' },
    to: [{ address: opts.to }],
    subject: opts.subject,
    text: opts.text ?? 'Hello there',
    headers: opts.headers,
  });
  const result = await ingest(raw, { rcptTo: [opts.rcpt ?? opts.to], source: 'resend' });
  const msg = get<any>('SELECT * FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1', [messageId]);
  return { result, msg };
}

const threads = async (q: string) => (await h.call('GET', `/api/mail/threads?${q}`)).body.threads as any[];

describe('which address mail came through', () => {
  it('records the alias, shows it on the conversation and finds it with deliveredto:', async () => {
    const { msg } = await receive({ from: 'pat@example.org', to: 'hello@wren.test', subject: 'Via the alias' });
    expect(msg.delivered_to).toBe('hello@wren.test');
    const direct = await receive({ from: 'pat@example.org', to: 'admin@wren.test', subject: 'Straight to me' });
    expect(direct.msg.delivered_to).toBe('admin@wren.test');

    const list = await threads('view=inbox');
    expect(list.find((t) => t.subject === 'Via the alias').via).toBe('hello@wren.test');
    expect(list.find((t) => t.subject === 'Straight to me').via).toBeNull();
    expect((await threads(`view=inbox&q=${encodeURIComponent('deliveredto:hello@wren.test')}`)).map((t) => t.subject)).toEqual(['Via the alias']);
    const thread = (await h.call('GET', `/api/mail/threads/${msg.thread_id}`)).body;
    expect(thread.messages[0].deliveredTo).toBe('hello@wren.test');
  });

  it('lets people turn an alias off and on, and make throwaway sign-up addresses', async () => {
    const mine = (await h.call('GET', '/api/me/aliases')).body;
    const hello = mine.aliases.find((a: any) => a.address === 'hello@wren.test');
    expect(hello).toMatchObject({ kind: 'alias', enabled: true, received: 1 });
    expect(mine.policy.throwaway).toMatchObject({ enabled: true }); // admins always can

    expect((await h.call('PUT', `/api/me/aliases/${hello.id}`, { enabled: false })).status).toBe(200);
    const off = await receive({ from: 'spammer@example.org', to: 'hello@wren.test', subject: 'Buy now' });
    expect(off.result.rejected).toEqual([{ rcpt: 'hello@wren.test', reason: 'address disabled' }]);
    await h.call('PUT', `/api/me/aliases/${hello.id}`, { enabled: true });

    const made = (await h.call('POST', '/api/me/aliases/throwaway', { label: 'Shoe Shop!', description: 'Signed up for shoes' })).body.alias;
    expect(made.address).toMatch(/^shoe-shop\.[a-z2-9]{4}@wren\.test$/);
    const back = await receive({ from: 'orders@shoes.example', to: made.address, subject: 'Welcome' });
    expect(back.result.delivered).toBe(1);
    const listed = (await h.call('GET', '/api/me/aliases')).body.aliases.find((a: any) => a.address === made.address);
    expect(listed).toMatchObject({ throwaway: true, own: true, description: 'Signed up for shoes', received: 1 });
    expect((await h.call('DELETE', `/api/me/aliases/${made.id}`)).status).toBe(200);

    // Other people need the admin to allow it; and can't touch someone else's alias.
    await h.login('bob@wren.test', 'bob password 123', 'bob');
    expect((await h.call('POST', '/api/me/aliases/throwaway', { label: 'x' })).status).toBe(403);
    expect((await h.call('PUT', `/api/me/aliases/${hello.id}`, { enabled: false })).status).toBe(404);
    h.as('admin');
    await h.call('PUT', '/api/admin/settings', { 'aliases.throwaway': true });
    h.as('bob');
    expect((await h.call('POST', '/api/me/aliases/throwaway', { label: '' })).body.alias.address).toMatch(/^signup\.[a-z2-9]{4}@wren\.test$/);
    h.as('admin');
  });
});

describe('catch-all control', () => {
  it('lists what the catch-all takes, blocks an address, and turns one into an alias', async () => {
    const d = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!;
    run('UPDATE domains SET catch_all_user_id = ? WHERE id = ?', [admin, d.id]);
    await receive({ from: 'a@example.org', to: 'random1@wren.test', subject: 'One' });
    await receive({ from: 'b@example.org', to: 'random1@wren.test', subject: 'Two' });
    await receive({ from: 'c@example.org', to: 'leaked@wren.test', subject: 'Spam' });
    let info = (await h.call('GET', `/api/admin/domains/${d.id}/catchall`)).body;
    expect(info.hits.map((x: any) => [x.address, x.count])).toEqual([
      ['leaked@wren.test', 1],
      ['random1@wren.test', 2],
    ]);
    expect(info.hits[1]).toMatchObject({ lastFrom: 'b@example.org', lastSubject: 'Two' });
    // Mail to a real address isn't counted.
    expect(info.hits.some((x: any) => x.address === 'hello@wren.test')).toBe(false);

    expect((await h.call('POST', '/api/admin/blocked-recipients', { address: 'Leaked@wren.test' })).status).toBe(200);
    const blocked = await receive({ from: 'c@example.org', to: 'leaked@wren.test', subject: 'Spam again' });
    expect(blocked.result.rejected).toEqual([{ rcpt: 'leaked@wren.test', reason: 'address blocked' }]);
    expect((await h.call('POST', '/api/admin/blocked-recipients', { address: 'x@elsewhere.example' })).status).toBe(400);

    expect((await h.call('POST', '/api/admin/catchall/alias', { address: 'random1@wren.test' })).status).toBe(200);
    expect(get<any>(`SELECT kind, user_id FROM addresses WHERE address = 'random1@wren.test'`)).toEqual({ kind: 'alias', user_id: admin });
    info = (await h.call('GET', `/api/admin/domains/${d.id}/catchall`)).body;
    expect(info.hits.map((x: any) => x.address)).toEqual(['leaked@wren.test']);
    expect(info.hits[0].blocked).toBe(true);
    expect(info.blocked.map((x: any) => x.address)).toEqual(['leaked@wren.test']);
    expect((await h.call('DELETE', `/api/admin/blocked-recipients/${encodeURIComponent('leaked@wren.test')}`)).status).toBe(200);
    expect((await receive({ from: 'c@example.org', to: 'leaked@wren.test', subject: 'Allowed' })).result.delivered).toBe(1);
    run('UPDATE domains SET catch_all_user_id = NULL WHERE id = ?', [d.id]);
  });
});

describe('inbox tabs', () => {
  const ctx = { userId: 0, knownContact: false, internal: false };
  const parsed = async (opts: { from: string; subject: string; headers?: Record<string, string> }) =>
    parseMail((await buildMime({ from: { address: opts.from }, to: [{ address: 'admin@wren.test' }], subject: opts.subject, text: 'x', headers: opts.headers })).raw);

  it('sorts newsletters, receipts and people', async () => {
    const c = { ...ctx, userId: admin };
    const promo = await parsed({ from: 'news@shop.example', subject: '30% off everything this weekend', headers: { 'List-Unsubscribe': '<https://shop.example/u/1>', 'X-Mailchimp-Campaign': 'abc' } });
    expect(categorize(promo, c)).toBe('promotions');
    const receipt = await parsed({ from: 'no-reply@shop.example', subject: 'Your order #1234 has shipped', headers: { 'List-Unsubscribe': '<https://shop.example/u/1>' } });
    expect(categorize(receipt, c)).toBe('updates');
    const alert = await parsed({ from: 'security@bank.example', subject: 'New sign-in to your account' });
    expect(categorize(alert, c)).toBe('updates');
    const github = await parsed({ from: 'notifications@github.com', subject: 'Re: [org/repo] Fix the build (#12)', headers: { 'List-Id': 'org/repo <repo.org.github.com>' } });
    expect(categorize(github, c)).toBe('updates');
    // People always land in Primary, even with an "order" in the subject.
    expect(categorize(await parsed({ from: 'sam@example.org', subject: 'Question about my order' }), c)).toBe('primary');
    expect(categorize(await parsed({ from: 'sam@example.org', subject: '50% off at the bakery, want to go?' }), c)).toBe('primary');
    expect(categorize(promo, { ...c, internal: true })).toBe('primary');
  });

  it('shows one tab at a time, counts unread per tab, and learns when a conversation is moved', async () => {
    const promo = await receive({
      from: 'deals@store.example',
      to: 'admin@wren.test',
      subject: 'Black Friday: 40% off',
      headers: { 'List-Unsubscribe': '<https://store.example/unsub?u=1>, <mailto:unsub@store.example?subject=stop>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-Campaign': '7' },
    });
    expect(promo.msg.category).toBe('promotions');
    const person = await receive({ from: 'friend@example.org', to: 'admin@wren.test', subject: 'Dinner?' });
    expect(person.msg.category).toBe('primary');

    const primary = (await threads('view=inbox&category=primary')).map((t) => t.subject);
    expect(primary).toContain('Dinner?');
    expect(primary).not.toContain('Black Friday: 40% off');
    expect((await threads('view=inbox&category=promotions')).map((t) => t.subject)).toEqual(['Black Friday: 40% off']);
    expect((await threads('view=inbox')).map((t) => t.subject)).toContain('Black Friday: 40% off'); // tabs off: everything
    const counts = (await h.call('GET', '/api/mail/counters')).body;
    expect(counts.categories.promotions).toBe(1);
    expect(counts.categories.primary).toBeGreaterThan(0);
    expect((await threads(`view=inbox&q=${encodeURIComponent('category:promotions')}`)).map((t) => t.subject)).toEqual(['Black Friday: 40% off']);

    // Move it to Primary; the next one from that sender follows.
    await h.call('POST', '/api/mail/threads/actions', { threadIds: [promo.msg.thread_id], action: { type: 'category', category: 'primary' } });
    expect(get<any>('SELECT category FROM messages WHERE id = ?', [promo.msg.id]).category).toBe('primary');
    const next = await receive({ from: 'deals@store.example', to: 'admin@wren.test', subject: 'Cyber Monday: 50% off', headers: { 'X-Campaign': '8' } });
    expect(next.msg.category).toBe('primary');
  });

  it('unsubscribes with one click, by email, or hands over the link', async () => {
    const one = await receive({
      from: 'list@news.example',
      to: 'admin@wren.test',
      subject: 'Weekly digest',
      headers: { 'List-Unsubscribe': '<https://news.example.com/unsub/abc>, <mailto:leave@news.example>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    const detail = (await h.call('GET', `/api/mail/messages/${one.msg.id}`)).body;
    expect(detail).toMatchObject({ canUnsubscribe: true, unsubscribed: false });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 200 });
    });
    expect((await h.call('POST', `/api/mail/messages/${one.msg.id}/unsubscribe`)).body).toEqual({ method: 'one-click', sender: 'list@news.example' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://news.example.com/unsub/abc');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: 'List-Unsubscribe=One-Click', redirect: 'manual' });
    expect((await h.call('GET', `/api/mail/messages/${one.msg.id}`)).body.unsubscribed).toBe(true);

    // The one-click endpoint fails: fall back to the email address, sent from the address the list mails.
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    const two = await receive({
      from: 'list@other.example',
      to: 'hello@wren.test',
      subject: 'Monthly',
      headers: { 'List-Unsubscribe': '<https://other.example.com/u>, <mailto:leave@other.example?subject=remove%20me>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect((await h.call('POST', `/api/mail/messages/${two.msg.id}/unsubscribe`)).body.method).toBe('email');
    const sent = (await outbox('notice')).find((j) => j.recipients.includes('leave@other.example'))!;
    expect(sent.mail_from).toBe('hello@wren.test');
    expect(sent.raw).toMatch(/^Subject: remove me/m);

    // No one-click and no address: the link, for the browser to open.
    const three = await receive({ from: 'x@site.example', to: 'admin@wren.test', subject: 'Updates', headers: { 'List-Unsubscribe': '<https://site.example/prefs>' } });
    expect((await h.call('POST', `/api/mail/messages/${three.msg.id}/unsubscribe`)).body).toMatchObject({ method: 'link', url: 'https://site.example/prefs' });
    const none = await receive({ from: 'y@site.example', to: 'admin@wren.test', subject: 'Plain' });
    expect((await h.call('POST', `/api/mail/messages/${none.msg.id}/unsubscribe`)).status).toBe(400);
  });

  it('never posts to private or odd hosts', () => {
    expect(isPublicHttpsUrl('https://news.example.com/u')).toBe(true);
    for (const bad of ['http://news.example.com/u', 'https://127.0.0.1/u', 'https://[::1]/u', 'https://localhost/u', 'https://printer.local/u', 'https://db.internal/u', 'https://user:pw@news.example.com/', 'javascript:alert(1)']) {
      expect(isPublicHttpsUrl(bad), bad).toBe(false);
    }
  });
});

describe('prefs', () => {
  it('stores the inbox tabs and sign-in alert switches', async () => {
    const r = await h.call('PUT', '/api/account/prefs', { inboxTabs: false, signInAlerts: false });
    expect(r.status).toBe(200);
    expect(r.body.prefs ?? r.body.user?.prefs).toMatchObject({ inboxTabs: false, signInAlerts: false });
    await h.call('PUT', '/api/account/prefs', { inboxTabs: true, signInAlerts: true });
    expect(all('SELECT 1 FROM users').length).toBeGreaterThan(1);
  });
});
