import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { harness, processQueue } from './harness';

const h = harness();
const ids: Record<string, number> = {};

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  for (const [name, email] of [
    ['bea', 'bea@wren.test'],
    ['cal', 'cal@wren.test'],
    ['dee', 'dee@wren.test'],
  ]) {
    ids[name] = (await h.call('POST', '/api/admin/users', { email, name, password: `${name} password 123` })).body.id;
  }
  ids.admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
});

describe('user detail', () => {
  it('shows storage, addresses, sessions and sign-ins, and revokes one session', async () => {
    await h.login('bea@wren.test', 'bea password 123', 'bea');
    h.as('admin');
    const d = (await h.call('GET', `/api/admin/users/${ids.bea}/detail`)).body;
    expect(d.user).toMatchObject({ email: 'bea@wren.test', totpEnabled: false, recoveryEmail: null });
    expect(d.addresses.map((a: any) => a.address)).toEqual(['bea@wren.test']);
    expect(d.sessions).toHaveLength(1);
    expect(d.signIns[0]).toMatchObject({ action: 'auth.login' });
    expect(d.storage.folders.some((f: any) => f.folder === 'inbox')).toBe(true); // welcome message
    await h.call('DELETE', `/api/admin/users/${ids.bea}/sessions/${d.sessions[0].id}`);
    h.as('bea');
    expect((await h.call('GET', '/api/mail/counters')).status).toBe(401);
  });
});

describe('bulk actions', () => {
  it('applies to many users, skipping ones it must not touch', async () => {
    h.as('admin');
    const r = (await h.call('POST', '/api/admin/users/bulk', { ids: [ids.cal, ids.dee, ids.admin], action: 'suspend' })).body.results;
    expect(r.filter((x: any) => x.ok).map((x: any) => x.email)).toEqual(['cal@wren.test', 'dee@wren.test']);
    expect(r.find((x: any) => x.id === ids.admin).error).toMatch(/own account/);
    h.as('cal');
    expect((await h.call('POST', '/api/auth/login', { email: 'cal@wren.test', password: 'cal password 123' })).status).toBe(403);

    h.as('admin');
    await h.call('POST', '/api/admin/users/bulk', { ids: [ids.cal, ids.dee], action: 'activate' });
    await h.call('POST', '/api/admin/users/bulk', { ids: [ids.cal, ids.dee], action: 'quota', value: 2048 });
    expect(get<{ quota_bytes: number }>('SELECT quota_bytes FROM users WHERE id = ?', [ids.dee])!.quota_bytes).toBe(2048 * 1024 * 1024);
    await h.call('POST', '/api/admin/users/bulk', { ids: [ids.dee], action: 'quota', value: null });
    expect(get<{ quota_bytes: number | null }>('SELECT quota_bytes FROM users WHERE id = ?', [ids.dee])!.quota_bytes).toBeNull();
    await h.call('POST', '/api/admin/users/bulk', { ids: [ids.dee], action: 'delete' });
    expect(get('SELECT 1 FROM users WHERE id = ?', [ids.dee])).toBeUndefined();
  });
});

describe('CSV import', () => {
  it('validates rows in a dry run, then imports the valid ones', async () => {
    h.as('admin');
    const rows = [
      { email: 'eve@wren.test', name: 'Eve', password: 'eve password 123' },
      { email: 'Fay@Wren.test', name: 'Fay', setupEmail: 'fay@home.example' },
      { email: 'bea@wren.test', name: 'Bea again', password: 'whatever password' },
      { email: 'gus@elsewhere.example', name: 'Gus', password: 'gus password 123' },
      { email: 'hal@wren.test', name: 'Hal' },
      { email: 'eve@wren.test', name: 'Eve twice', password: 'eve password 123' },
    ];
    const dry = (await h.call('POST', '/api/admin/users/import', { rows, dryRun: true })).body.results;
    expect(dry.map((r: any) => r.ok)).toEqual([true, true, false, false, false, false]);
    expect(dry.map((r: any) => r.error ?? '')).toEqual(['', '', 'address already exists', 'domain elsewhere.example isn’t hosted here', 'needs a password or a setup email', 'duplicate row']);
    expect(get('SELECT 1 FROM users WHERE email = ?', ['eve@wren.test'])).toBeUndefined();

    const real = (await h.call('POST', '/api/admin/users/import', { rows })).body.results;
    expect(real.filter((r: any) => r.ok).map((r: any) => r.email)).toEqual(['eve@wren.test', 'fay@wren.test']);
    expect(real[1].setupUrl).toMatch(/\/reset\?token=/);
    expect((await h.login('eve@wren.test', 'eve password 123', 'eve')).status).toBe(200);
  });
});

describe('shared mailboxes', () => {
  it('lets members read and reply as the mailbox, with shared state, and keeps others out', async () => {
    h.as('admin');
    const created = await h.call('POST', '/api/admin/shared-mailboxes', {
      address: 'support@wren.test',
      name: 'Support',
      members: [
        { userId: ids.bea, canSend: true },
        { userId: ids.cal, canSend: false },
      ],
    });
    expect(created.status).toBe(200);
    const box = created.body.mailbox.id;
    expect((await h.call('GET', '/api/admin/users')).body.users.map((u: any) => u.email)).not.toContain('support@wren.test');
    // It can't be signed into.
    h.as('nobody');
    expect((await h.call('POST', '/api/auth/login', { email: 'support@wren.test', password: 'anything at all' })).status).toBe(401);

    const { raw } = await buildMime({ from: { address: 'client@example.org', name: 'Client' }, to: [{ address: 'support@wren.test' }], subject: 'Help with my order', text: 'It never arrived.' });
    await ingest(raw, { rcptTo: ['support@wren.test'], source: 'cloudflare-routing' });

    await h.login('bea@wren.test', 'bea password 123', 'bea');
    const mine = (await h.call('GET', '/api/account/mailboxes')).body.mailboxes;
    expect(mine).toEqual([{ id: box, address: 'support@wren.test', name: 'Support', canSend: true, unread: 1 }]);
    const as = { 'X-Wren-Mailbox': String(box) };
    const list = (await h.call('GET', '/api/mail/threads?view=inbox', undefined, as)).body.threads;
    expect(list.map((t: any) => t.subject)).toEqual(['Help with my order']);
    // Bea's own inbox is separate.
    expect((await h.call('GET', '/api/mail/threads?view=inbox')).body.threads.map((t: any) => t.subject)).not.toContain('Help with my order');
    // Opening it marks it read for everyone.
    const thread = (await h.call('GET', `/api/mail/threads/${list[0].id}`, undefined, as)).body;
    await h.login('cal@wren.test', 'cal password 123', 'cal');
    expect((await h.call('GET', '/api/account/mailboxes')).body.mailboxes[0].unread).toBe(0);
    // Cal may read but not send.
    const calSend = await h.call('POST', '/api/compose/send', { to: 'client@example.org', subject: 'Re: Help with my order', html: '<p>Hi</p>', replyToId: thread.messages[0].id }, as);
    expect(calSend.status).toBe(403);

    h.as('bea');
    const tpl = (await h.call('GET', `/api/compose/template?messageId=${thread.messages[0].id}&mode=reply`, undefined, as)).body;
    expect(tpl.from).toBe('support@wren.test');
    const sent = await h.call('POST', '/api/compose/send', { from: tpl.from, to: tpl.to, subject: tpl.subject, html: '<p>Sorry! Resending today.</p>', replyToId: tpl.replyToId }, as);
    expect(sent.status).toBe(200);
    await processQueue();
    const after = (await h.call('GET', `/api/mail/threads/${list[0].id}`, undefined, as)).body;
    const reply = after.messages.find((m: any) => m.direction === 'out');
    expect(reply.from.address).toBe('support@wren.test');
    expect(reply.sentBy).toEqual({ name: 'bea', email: 'bea@wren.test' });

    // Not a member: no access, even with the header.
    await h.login('eve@wren.test', 'eve password 123', 'eve');
    expect((await h.call('GET', '/api/mail/threads?view=inbox', undefined, as)).status).toBe(403);
    expect((await h.call('GET', `/api/mail/threads/${list[0].id}`)).status).toBe(404);

    // Removing a member revokes access.
    h.as('admin');
    await h.call('PUT', `/api/admin/shared-mailboxes/${box}`, { members: [{ userId: ids.bea, canSend: true }] });
    h.as('cal');
    expect((await h.call('GET', '/api/mail/threads?view=inbox', undefined, as)).status).toBe(403);
  });
});
