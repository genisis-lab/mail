import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, now, run } from '../src/server/db/index';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';
const ids: Record<string, number> = {};

const userRow = (id: number) => get<{ role: string; helpdesk: number; status: string; totp_enabled: number }>('SELECT role, helpdesk, status, totp_enabled FROM users WHERE id = ?', [id])!;
const lastAudit = () => get<{ user_id: number; action: string; target: string }>('SELECT user_id, action, target FROM audit_log ORDER BY id DESC LIMIT 1')!;

/** What helpdesk staff may call (route templates as registered). Everything else under /api/admin is refused. */
const ALLOWED = [
  'GET /api/admin/users',
  'GET /api/admin/users/:id',
  'GET /api/admin/users/:id/detail',
  'PUT /api/admin/users/:id',
  'POST /api/admin/users/:id/unlock',
  'POST /api/admin/users/:id/signout',
  'POST /api/admin/users/:id/reset-2fa',
  'POST /api/admin/users/:id/reset-link',
  'POST /api/admin/users/:id/setup-link',
  'POST /api/admin/users/:id/password',
  'DELETE /api/admin/users/:id/passkeys',
  'DELETE /api/admin/users/:id/sessions/:sid',
  'GET /api/admin/invites',
  'POST /api/admin/invites',
  'POST /api/admin/invites/:id/resend',
  'DELETE /api/admin/invites/:id',
];

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  ids.owner = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  for (const [key, email, role] of [
    ['helen', 'helen@wren.test', 'helpdesk'],
    ['hank', 'hank@wren.test', 'helpdesk'],
    ['sam', 'sam@wren.test', 'user'],
    ['deputy', 'deputy@wren.test', 'admin'],
  ] as const) {
    const r = await h.call('POST', '/api/admin/users', { email, name: key, password: PW, role });
    expect(r.status).toBe(200);
    ids[key] = r.body.id;
  }
  ids.shared = (await h.call('POST', '/api/admin/shared-mailboxes', { address: 'team@wren.test', name: 'Team' })).body.mailbox.id;
  await h.login('helen@wren.test', PW, 'helen');
});

describe('assigning the helpdesk role', () => {
  it('is stored as a flag on an ordinary user and shown as its own role', async () => {
    expect(userRow(ids.helen)).toMatchObject({ role: 'user', helpdesk: 1 });
    h.as('helen');
    expect((await h.call('GET', '/api/auth/me')).body.user.role).toBe('helpdesk');
    h.as('admin@wren.test');
    const list = (await h.call('GET', '/api/admin/users')).body.users;
    expect(list.find((u: any) => u.id === ids.helen).role).toBe('helpdesk');
    expect(list.find((u: any) => u.id === ids.sam).role).toBe('user');
  });

  it('can be granted and taken away by admins, and never sticks to an admin', async () => {
    expect((await h.call('PUT', `/api/admin/users/${ids.hank}`, { role: 'admin' })).status).toBe(200);
    expect(userRow(ids.hank)).toMatchObject({ role: 'admin', helpdesk: 0 });
    expect((await h.call('PUT', `/api/admin/users/${ids.hank}`, { role: 'helpdesk' })).status).toBe(200);
    expect(userRow(ids.hank)).toMatchObject({ role: 'user', helpdesk: 1 });
    expect(lastAudit()).toMatchObject({ user_id: ids.owner, action: 'admin.user_updated', target: 'hank@wren.test' });
    // Shared mailboxes are not people.
    expect((await h.call('PUT', `/api/admin/users/${ids.shared}`, { role: 'helpdesk' })).status).toBe(400);
    // The database refuses an admin with the flag, whatever the code path.
    expect(() => run('UPDATE users SET helpdesk = 1 WHERE id = ?', [ids.deputy])).toThrow(/CHECK/);
    expect(() => run(`UPDATE users SET role = 'admin' WHERE id = ?`, [ids.hank])).toThrow(/CHECK/);
  });
});

describe('what helpdesk staff can do for an ordinary user', () => {
  it('lists and opens users', async () => {
    h.as('helen');
    expect((await h.call('GET', '/api/admin/users')).status).toBe(200);
    expect((await h.call('GET', `/api/admin/users/${ids.sam}`)).status).toBe(200);
    const detail = (await h.call('GET', `/api/admin/users/${ids.sam}/detail`)).body;
    expect(detail.user.email).toBe('sam@wren.test');
  });

  it('gets no legal hold, mail handling, mail app or export details', async () => {
    run('UPDATE users SET legal_hold_at = 1, legal_hold_note = ? WHERE id = ?', ['case 42', ids.sam]);
    h.as('helen');
    const d = (await h.call('GET', `/api/admin/users/${ids.sam}/detail`)).body;
    expect(d.user.legalHold).toBeNull();
    expect(d.mailHandling).toBeNull();
    expect(d.mailApps.passwords).toEqual([]);
    expect(d.exports).toEqual([]);
    run('UPDATE users SET legal_hold_at = NULL, legal_hold_note = NULL WHERE id = ?', [ids.sam]);
  });

  it('unlocks, signs out, resets 2-step and passkeys, sends links, sets a password, suspends, all audited as them', async () => {
    h.as('helen');
    const expectDone = async (method: string, path: string, body: unknown, action: string) => {
      const r = await h.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(200);
      expect(lastAudit()).toMatchObject({ user_id: ids.helen, action, target: 'sam@wren.test' });
      return r;
    };
    run(`INSERT OR REPLACE INTO login_attempts (key, count, reset_at) VALUES ('login:user:sam@wren.test', 99, ?)`, [now() + 600_000]);
    await expectDone('POST', `/api/admin/users/${ids.sam}/unlock`, undefined, 'admin.user_unlocked');
    expect(get(`SELECT 1 FROM login_attempts WHERE key = 'login:user:sam@wren.test'`)).toBeUndefined();

    await h.login('sam@wren.test', PW, 'sam');
    h.as('helen');
    const sid = (await h.call('GET', `/api/admin/users/${ids.sam}/detail`)).body.sessions[0].id;
    await expectDone('DELETE', `/api/admin/users/${ids.sam}/sessions/${sid}`, undefined, 'admin.user_session_revoked');
    await expectDone('POST', `/api/admin/users/${ids.sam}/signout`, undefined, 'admin.user_signed_out');

    run(`UPDATE users SET totp_enabled = 1, totp_secret = 'x', recovery_email = 'sam@example.org' WHERE id = ?`, [ids.sam]);
    await expectDone('POST', `/api/admin/users/${ids.sam}/reset-2fa`, undefined, 'admin.user_2fa_reset');
    expect(userRow(ids.sam).totp_enabled).toBe(0);

    run(`INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, created_at) VALUES (?, 'cred', 'key', -7, ?)`, [ids.sam, now()]);
    expect((await expectDone('DELETE', `/api/admin/users/${ids.sam}/passkeys`, undefined, 'admin.user_passkeys_removed')).body.removed).toBe(1);

    await expectDone('POST', `/api/admin/users/${ids.sam}/reset-link`, undefined, 'admin.user_reset_link_sent');
    expect((await expectDone('POST', `/api/admin/users/${ids.sam}/setup-link`, {}, 'admin.user_setup_link')).body.url).toMatch(/token=/);
    await expectDone('POST', `/api/admin/users/${ids.sam}/password`, { password: 'another long password', mustChange: true }, 'admin.user_password_reset');

    await expectDone('PUT', `/api/admin/users/${ids.sam}`, { status: 'suspended' }, 'admin.user_updated');
    expect(userRow(ids.sam).status).toBe('suspended');
    await expectDone('PUT', `/api/admin/users/${ids.sam}`, { status: 'active' }, 'admin.user_updated');
    expect(userRow(ids.sam).status).toBe('active');
  });

  it('invites users, but never with a higher role', async () => {
    h.as('helen');
    expect((await h.call('GET', '/api/admin/invites')).status).toBe(200);
    const mine = await h.call('POST', '/api/admin/invites', { sendTo: 'friend@example.org' });
    expect(mine.status).toBe(200);
    expect(lastAudit()).toMatchObject({ user_id: ids.helen, action: 'admin.invite_created' });
    expect((await h.call('POST', `/api/admin/invites/${mine.body.id}/resend`, {})).status).toBe(200);
    expect((await h.call('POST', '/api/admin/invites', { role: 'admin' })).status).toBe(403);

    h.as('admin@wren.test');
    const adminInvite = (await h.call('POST', '/api/admin/invites', { role: 'admin', sendTo: 'boss@example.org' })).body.id;
    h.as('helen');
    expect((await h.call('POST', `/api/admin/invites/${adminInvite}/resend`, {})).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/invites/${adminInvite}`)).status).toBe(403);
    expect(get('SELECT 1 FROM invites WHERE id = ?', [adminInvite])).toBeTruthy();
    expect((await h.call('DELETE', `/api/admin/invites/${mine.body.id}`)).status).toBe(200);
  });
});

describe('what helpdesk staff can’t do', () => {
  it('changes nothing but the status: no role changes, names, quotas or mail apps', async () => {
    h.as('helen');
    for (const change of [{ role: 'admin' }, { role: 'helpdesk' }, { status: 'active', role: 'user' }, { name: 'Sam' }, { quotaMb: 1 }, { mailApps: false }, { requirePasswordChange: true }]) {
      expect((await h.call('PUT', `/api/admin/users/${ids.sam}`, change)).status, JSON.stringify(change)).toBe(403);
    }
    expect(userRow(ids.sam)).toMatchObject({ role: 'user', helpdesk: 0 });
    // Nor their own role.
    expect((await h.call('PUT', `/api/admin/users/${ids.helen}`, { role: 'admin' })).status).toBe(403);
    expect(userRow(ids.helen)).toMatchObject({ role: 'user', helpdesk: 1 });
  });

  it('touches no admin, owner, helpdesk account (their own included) or shared mailbox', async () => {
    h.as('helen');
    const before = all('SELECT id, role, helpdesk, status, password_hash, totp_enabled FROM users ORDER BY id');
    for (const key of ['owner', 'deputy', 'hank', 'helen', 'shared']) {
      const id = ids[key];
      for (const [method, path, body] of [
        ['GET', `/api/admin/users/${id}`],
        ['GET', `/api/admin/users/${id}/detail`],
        ['PUT', `/api/admin/users/${id}`, { status: 'suspended' }],
        ['POST', `/api/admin/users/${id}/unlock`],
        ['POST', `/api/admin/users/${id}/signout`],
        ['POST', `/api/admin/users/${id}/reset-2fa`],
        ['POST', `/api/admin/users/${id}/reset-link`],
        ['POST', `/api/admin/users/${id}/setup-link`, {}],
        ['POST', `/api/admin/users/${id}/password`, { password: 'another long password' }],
        ['DELETE', `/api/admin/users/${id}/passkeys`],
        ['DELETE', `/api/admin/users/${id}/sessions/0123456789abcdef`],
      ] as [string, string, unknown?][]) {
        expect((await h.call(method, path, body)).status, `${key}: ${method} ${path}`).toBe(403);
      }
    }
    expect(all('SELECT id, role, helpdesk, status, password_hash, totp_enabled FROM users ORDER BY id')).toEqual(before);
  });

  it('is refused a representative route of every other area', async () => {
    h.as('helen');
    const sam = ids.sam;
    for (const [method, path, body] of [
      ['POST', '/api/admin/users', { email: 'new@wren.test', name: 'New', password: PW }], // create users
      ['DELETE', `/api/admin/users/${sam}`], // delete users
      ['POST', '/api/admin/users/bulk', { ids: [sam], action: 'delete' }],
      ['POST', `/api/admin/users/${sam}/rename`, { email: 'samuel@wren.test' }],
      ['POST', `/api/admin/users/${sam}/export`], // export mailboxes
      ['PUT', `/api/admin/users/${sam}/mail-handling`, { forwarding: { enabled: true, to: 'helen@wren.test' } }],
      ['GET', '/api/admin/delivery-log/1'], // message headers: reading mail
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings', { 'registration.mode': 'open' }],
      ['POST', '/api/admin/domains', { name: 'evil.test' }],
      ['GET', '/api/admin/domains'],
      ['POST', '/api/admin/addresses', { address: 'x@wren.test', kind: 'alias', userId: ids.helen }],
      ['GET', '/api/admin/providers'],
      ['GET', '/api/admin/backups'],
      ['GET', '/api/admin/export'],
      ['POST', '/api/admin/encryption-key', { password: PW }],
      ['PUT', '/api/admin/cloudflare', { apiToken: 'x'.repeat(40) }],
      ['GET', '/api/admin/delivery-log'],
      ['GET', '/api/admin/inbound-log'],
      ['GET', '/api/admin/outbox'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/shared-mailboxes'],
      ['POST', '/api/admin/announce', { subject: 'Hi', html: '<p>Hi</p>' }],
      ['GET', '/api/admin/overview'],
    ] as [string, string, unknown?][]) {
      const r = await h.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(get(`SELECT 1 FROM users WHERE email = 'new@wren.test'`)).toBeUndefined();
    expect(get(`SELECT 1 FROM domains WHERE name = 'evil.test'`)).toBeUndefined();
    expect(get('SELECT 1 FROM users WHERE id = ?', [sam])).toBeTruthy();
  });

  it('is refused every admin route not on its list', async () => {
    h.as('helen');
    const auditBefore = all('SELECT id FROM audit_log').length;
    const params: Record<string, string> = { id: String(ids.sam), job: '1', sid: '0123456789abcdef', address: 'sam%40wren.test' };
    const routes = h.app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/admin/'));
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    // The list still names real routes (a rename would otherwise pass unnoticed).
    for (const a of ALLOWED) expect(registered.has(a), a).toBe(true);
    const refused = [...registered].filter((r) => !ALLOWED.includes(r));
    expect(refused.length).toBeGreaterThan(50);
    for (const route of refused) {
      const [method, template] = route.split(' ');
      const path = template.replace(/:(\w+)\??/g, (_m, name: string) => params[name] ?? '1');
      expect((await h.call(method, path, method === 'GET' ? undefined : {})).status, route).toBe(403);
    }
    expect(all('SELECT id FROM audit_log').length).toBe(auditBefore);
  });

  it('loses its access as soon as an admin takes the role away', async () => {
    h.as('admin@wren.test');
    expect((await h.call('PUT', `/api/admin/users/${ids.hank}`, { role: 'user' })).status).toBe(200);
    expect(userRow(ids.hank)).toMatchObject({ role: 'user', helpdesk: 0 });
    await h.login('hank@wren.test', PW, 'hank');
    expect((await h.call('GET', '/api/admin/users')).status).toBe(403);
  });
});
