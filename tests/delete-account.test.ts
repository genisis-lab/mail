import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/server/db/index';
import { encrypt, totpCode } from '../src/server/lib/crypto';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { harness } from './harness';

const h = harness();
const ids: Record<string, number> = {};
const del = (password: string, code?: string, headers?: Record<string, string>) => h.call('POST', '/api/account/delete', { password, code }, headers);
const exists = (id: number) => !!get('SELECT 1 FROM users WHERE id = ?', [id]);

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  for (const name of ['ivy', 'jo', 'kim', 'lou']) {
    ids[name] = (await h.call('POST', '/api/admin/users', { email: `${name}@wren.test`, name, password: `${name} password 123` })).body.id;
  }
  ids.admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
});

describe('deleting your own account', () => {
  it('follows the admin policy (on by default)', async () => {
    await h.login('ivy@wren.test', 'ivy password 123', 'ivy');
    expect((await h.call('GET', '/api/account/delete')).body).toEqual({ blocked: null });
    h.as('admin');
    await h.call('PUT', '/api/admin/settings', { 'users.selfDelete': false });
    h.as('ivy');
    expect((await h.call('GET', '/api/account/delete')).body.blocked).toMatch(/Ask an administrator/);
    const r = await del('ivy password 123');
    expect(r.status).toBe(403);
    expect(exists(ids.ivy)).toBe(true);
    h.as('admin');
    await h.call('PUT', '/api/admin/settings', { 'users.selfDelete': true });
  });

  it('needs the right password', async () => {
    h.as('ivy');
    expect((await del('not my password')).status).toBe(401);
    expect(exists(ids.ivy)).toBe(true);
  });

  it('needs a current 2-step code when that is on', async () => {
    run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt('JBSWY3DPEHPK3PXP'), ids.jo]);
    await h.login('jo@wren.test', 'jo password 123', 'jo');
    await h.call('POST', '/api/auth/mfa', { code: totpCode('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30_000)) });
    expect((await del('jo password 123')).status).toBe(400);
    expect((await del('jo password 123', '000000')).status).toBe(401);
    expect(exists(ids.jo)).toBe(true);
    const ok = await del('jo password 123', totpCode('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30_000)));
    expect(ok.status).toBe(200);
    expect(exists(ids.jo)).toBe(false);
  });

  it('refuses the last owner or administrator', async () => {
    h.as('admin');
    const r = await del('a very long password');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/only owner/);
    // Another admin isn't enough: someone else must own the server.
    await h.call('PUT', `/api/admin/users/${ids.kim}`, { role: 'admin' });
    expect((await del('a very long password')).status).toBe(403);
    expect(exists(ids.admin)).toBe(true);

    // An admin with no other active admin (the owner is suspended).
    await h.login('kim@wren.test', 'kim password 123', 'kim');
    run(`UPDATE users SET status = 'suspended' WHERE id = ?`, [ids.admin]);
    const k = await del('kim password 123');
    run(`UPDATE users SET status = 'active' WHERE id = ?`, [ids.admin]);
    expect(k.status).toBe(403);
    expect(k.body.error).toMatch(/only administrator/);
    expect(exists(ids.kim)).toBe(true);
  });

  it('deletes everything, frees the addresses, signs out and writes an audit entry', async () => {
    h.as('admin');
    await h.call('POST', '/api/admin/addresses', { address: 'ivy.shop@wren.test', kind: 'alias', userId: ids.ivy });
    const { raw } = await buildMime({ from: { address: 'pat@example.org' }, to: [{ address: 'ivy@wren.test' }], subject: 'A secret plan', text: 'Shh' });
    await ingest(raw, { rcptTo: ['ivy@wren.test'], source: 'cloudflare-routing' });
    await h.login('ivy@wren.test', 'ivy password 123', 'ivy-phone');
    h.as('ivy');
    await h.call('POST', '/api/contacts', { email: 'pat@example.org', name: 'Pat' });
    await h.call('POST', '/api/labels', { name: 'Plans' });
    await h.call('POST', '/api/filters', { criteria: { from: 'pat@example.org' }, actions: { star: true } });
    await h.call('POST', '/api/account/api-keys', { name: 'Script' });
    expect(all('SELECT 1 FROM sessions WHERE user_id = ?', [ids.ivy])).toHaveLength(2);
    // A logged arrival at an alias, in other letter case.
    run(`INSERT INTO inbound_log (source, mail_from, rcpt_to, subject, status, created_at) VALUES ('smtp', 'pat@example.org', 'Ivy.Shop@wren.test', 'Another secret', 'accepted', ?)`, [Date.now()]);
    expect(all(`SELECT 1 FROM inbound_log WHERE subject LIKE '%secret%' AND mail_from = 'pat@example.org'`)).toHaveLength(2);

    const r = await del('ivy password 123');
    expect(r.body).toEqual({ ok: true, remaining: 0 });
    expect(exists(ids.ivy)).toBe(false);
    for (const table of ['messages', 'threads', 'contacts', 'labels', 'filters', 'api_keys', 'sessions', 'addresses', 'passkeys']) {
      expect(all(`SELECT 1 FROM ${table} WHERE user_id = ?`, [ids.ivy]), table).toEqual([]);
    }
    // Signed out here and on the other device.
    expect((await h.call('GET', '/api/auth/me')).body.user).toBeNull();
    h.as('ivy-phone');
    expect((await h.call('GET', '/api/mail/counters')).status).toBe(401);

    // The addresses are free again.
    h.as('admin');
    expect((await h.call('POST', '/api/admin/addresses', { address: 'ivy.shop@wren.test', kind: 'alias', userId: ids.admin })).status).toBe(200);
    expect((await h.call('POST', '/api/admin/users', { email: 'ivy@wren.test', name: 'New Ivy', password: 'new ivy password 1' })).status).toBe(200);

    const entry = get<any>(`SELECT * FROM audit_log WHERE action = 'account.deleted' AND target = 'ivy@wren.test'`);
    expect(entry).toMatchObject({ user_id: null, details: null });
    expect(JSON.stringify(all(`SELECT * FROM audit_log WHERE target LIKE '%ivy%'`))).not.toContain('secret plan');
    // The inbound log keeps that mail arrived, but not what it was about or who sent it.
    expect(all(`SELECT subject, mail_from FROM inbound_log WHERE rcpt_to LIKE 'ivy%'`)).toEqual([
      { subject: '', mail_from: '' },
      { subject: '', mail_from: '' },
    ]);
  });

  it('carries on with the next account signed in on this browser', async () => {
    // One browser: lou first, then admin next to it.
    await h.login('lou@wren.test', 'lou password 123', 'shared-laptop');
    await h.call('POST', '/api/auth/login', { email: 'admin@wren.test', password: 'a very long password' });
    expect((await h.call('GET', '/api/auth/accounts')).body.accounts.map((a: any) => a.id)).toEqual([ids.lou, ids.admin]);
    const r = await del('lou password 123', undefined, { 'X-Wren-Account': String(ids.lou) });
    expect(r.body).toEqual({ ok: true, remaining: 1 });
    expect(exists(ids.lou)).toBe(false);
    // Admin takes the first place, so links that name no account open it.
    expect((await h.call('GET', '/api/auth/me')).body).toMatchObject({ user: { email: 'admin@wren.test' }, accounts: 1 });
    expect((await h.call('GET', '/api/auth/accounts')).body.accounts).toMatchObject([{ id: ids.admin, default: true }]);
  });
});
