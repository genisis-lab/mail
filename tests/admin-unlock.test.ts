import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/server/db/index';
import { encrypt, totpCode } from '../src/server/lib/crypto';
import { harness, outbox } from './harness';

/**
 * Unlocking the admin panel from a native app (services/admin-unlock.ts): the account password and
 * one second step, then a short-lived admin token that works only with the same app password and
 * only for what the app's admin panel does.
 */
const h = harness();
const PW = 'a very long password';
const SECRET = 'JBSWY3DPEHPK3PXP';
const ids: Record<string, number> = {};
const keys: Record<string, string> = {};

const totp = () => totpCode(SECRET, Math.floor(Date.now() / 30_000));
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** A request from the app (no cookies): its app password, and the admin token if it has one. */
async function app(method: string, path: string, key: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const res = await h.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Wren': '1', ...bearer(key), ...(token ? { 'X-Wren-Admin': token } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const start = (key: string, password = PW, extra: Record<string, string> = {}) => app('POST', '/jmap/admin/unlock', key, { password, device: 'Wren for Mac on Test Mac' }, undefined, extra);
const verify = (key: string, challenge: string, step: string, code?: string) => app('POST', '/jmap/admin/unlock/verify', key, { challenge, step, code });

/** A full unlock with the authenticator code. */
async function unlock(key: string) {
  const s = await start(key);
  expect(s.status).toBe(200);
  const v = await verify(key, s.body.challenge, 'totp', totp());
  expect(v.status).toBe(200);
  return v.body.token as string;
}

async function appPassword(jar: string) {
  h.as(jar);
  const r = await h.call('POST', '/api/account/api-keys', { name: 'Mac', scope: 'mail' });
  expect(r.status).toBe(200);
  return r.body.key as string;
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW, 'admin');
  ids.admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  expect((await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': true })).status).toBe(200);
  for (const [key, role] of [
    ['helen', 'helpdesk'],
    ['sam', 'user'],
    ['dora', 'admin'],
  ] as const) {
    const r = await h.call('POST', '/api/admin/users', { email: `${key}@wren.test`, name: key, password: PW, role });
    expect(r.status).toBe(200);
    ids[key] = r.body.id;
  }
  for (const who of ['helen', 'sam', 'dora']) await h.login(`${who}@wren.test`, PW, who);
  keys.admin = await appPassword('admin');
  keys.admin2 = await appPassword('admin');
  for (const who of ['helen', 'sam', 'dora']) keys[who] = await appPassword(who);
});

describe('who may unlock', () => {
  it('says in the JMAP session who can open the admin panel', async () => {
    const session = async (key: string) => (await (await h.app.request('/jmap/session', { headers: bearer(key) })).json()) as any;
    const wren = 'https://github.com/genisis-lab/mail/jmap';
    expect((await session(keys.admin)).accounts[`u${ids.admin}`].accountCapabilities[wren]).toMatchObject({ adminRole: 'owner', preferences: true });
    expect((await session(keys.helen)).accounts[`u${ids.helen}`].accountCapabilities[wren].adminRole).toBe('helpdesk');
    expect((await session(keys.sam)).accounts[`u${ids.sam}`].accountCapabilities[wren].adminRole).toBeNull();
  });

  it('refuses people who aren’t administrators or helpdesk staff', async () => {
    const r = await start(keys.sam);
    expect(r.status).toBe(403);
    expect(get('SELECT 1 FROM admin_unlocks WHERE user_id = ?', [ids.sam])).toBeUndefined();
  });

  it('needs the account password, not the app password', async () => {
    const before = all('SELECT 1 FROM sign_ins WHERE user_id = ? AND method = ? AND ok = 0', [ids.dora, 'app-admin']).length;
    expect((await start(keys.dora, keys.dora)).status).toBe(401);
    expect((await start(keys.dora, 'wrong password')).status).toBe(401);
    expect(all('SELECT 1 FROM sign_ins WHERE user_id = ? AND method = ? AND ok = 0', [ids.dora, 'app-admin']).length).toBe(before + 2);
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ? AND action = 'auth.admin_unlock_failed'`, [ids.dora])!.c).toBe(2);
    // No app password at all: JMAP's own sign-in refuses it first.
    expect((await h.app.request('/jmap/admin/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })).status).toBe(401);
  });

  it('needs a second step the person can use', async () => {
    const r = await start(keys.dora);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('unlock_needs_second_step');
  });

  it('answers only from the admin IP allowlist, when there is one', async () => {
    h.as('admin');
    expect((await h.call('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '198.51.100.0/24' }, { 'cf-connecting-ip': '198.51.100.7' })).status).toBe(200);
    run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt(SECRET), ids.admin]);
    const blocked = await start(keys.admin, PW, { 'cf-connecting-ip': '203.0.113.5' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('admin_ip_blocked');
    // An unlock made from an allowed address doesn't carry over to another one.
    const s = await start(keys.admin, PW, { 'cf-connecting-ip': '198.51.100.7' });
    const v = await verify(keys.admin, s.body.challenge, 'totp', totp());
    expect(v.status).toBe(200);
    expect((await app('GET', '/api/admin/users', keys.admin, undefined, v.body.token, { 'cf-connecting-ip': '198.51.100.7' })).status).toBe(200);
    expect((await app('GET', '/api/admin/users', keys.admin, undefined, v.body.token, { 'cf-connecting-ip': '203.0.113.5' })).status).toBe(403);
    expect((await h.call('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '' }, { 'cf-connecting-ip': '198.51.100.7' })).status).toBe(200);
  });
});

describe('the second step', () => {
  it('takes an authenticator code', async () => {
    const s = await start(keys.admin);
    expect(s.body).toMatchObject({ role: 'owner', steps: { totp: true, web: true, email: null } });
    expect((await verify(keys.admin, s.body.challenge, 'totp', '000000')).status).toBe(401);
    // Another app password can't finish this app's unlock.
    expect((await verify(keys.admin2, s.body.challenge, 'totp', totp())).status).toBe(401);
    const v = await verify(keys.admin, s.body.challenge, 'totp', totp());
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ role: 'owner', idleSeconds: 900 });
    expect(v.body.token).toMatch(/^[\w-]{40,}$/);
    // A challenge works once.
    expect((await verify(keys.admin, s.body.challenge, 'totp', totp())).status).toBe(401);
    const row = get<{ method: string; token_hash: string }>('SELECT method, token_hash FROM admin_unlocks WHERE user_id = ? AND token_hash IS NOT NULL', [ids.admin])!;
    expect(row.method).toBe('totp');
    expect(row.token_hash).not.toContain(v.body.token);
    expect(get('SELECT 1 FROM sign_ins WHERE user_id = ? AND method = ? AND ok = 1', [ids.admin, 'app-admin+2fa'])).toBeTruthy();
  });

  it('takes a code sent to the confirmed recovery address, never the Wren mailbox', async () => {
    run(`UPDATE users SET recovery_email = 'dora@example.com', recovery_verified_at = NULL WHERE id = ?`, [ids.dora]);
    // An unconfirmed recovery address isn't a second step.
    expect((await start(keys.dora)).status).toBe(403);
    run('UPDATE users SET recovery_verified_at = 1 WHERE id = ?', [ids.dora]);
    const s = await start(keys.dora);
    expect(s.status).toBe(200);
    expect(s.body.steps).toEqual({ totp: false, web: false, email: 'd…@example.com' });
    expect((await verify(keys.dora, s.body.challenge, 'email', '123456')).status).toBe(401);
    const sent = await app('POST', '/jmap/admin/unlock/email', keys.dora, { challenge: s.body.challenge });
    expect(sent.body.sentTo).toBe('d…@example.com');
    const mail = (await outbox()).filter((m) => m.subject === 'Your code to unlock the admin panel');
    expect(mail.map((m) => m.to)).toEqual([['dora@example.com']]);
    const code = /<b>(\d{6})<\/b>/.exec(mail[0].text)![1];
    expect(mail[0].text).toContain('Wren for Mac on Test Mac');
    const v = await verify(keys.dora, s.body.challenge, 'email', code);
    expect(v.status).toBe(200);
    expect(v.body.role).toBe('admin');
  });

  it('stops taking an emailed code after five wrong ones', async () => {
    const s = await start(keys.dora);
    await app('POST', '/jmap/admin/unlock/email', keys.dora, { challenge: s.body.challenge });
    const mail = (await outbox()).filter((m) => m.subject === 'Your code to unlock the admin panel');
    const code = /<b>(\d{6})<\/b>/.exec(mail[mail.length - 1].text)![1];
    run('DELETE FROM login_attempts WHERE key = ?', [`mfa:${ids.dora}`]);
    for (let i = 0; i < 5; i++) expect((await verify(keys.dora, s.body.challenge, 'email', code === '000000' ? '111111' : '000000')).status).toBe(401);
    expect((await verify(keys.dora, s.body.challenge, 'email', code)).status).toBeGreaterThanOrEqual(400);
    run('DELETE FROM login_attempts WHERE key = ?', [`mfa:${ids.dora}`]);
  });

  it('takes an approval from a browser signed in with two factors, by the number the app shows', async () => {
    // The admin's browser signed in before 2-step sign-in was on: password only, so it can't approve.
    h.as('admin');
    const s = await start(keys.admin);
    const asked = await app('POST', '/jmap/admin/unlock/web', keys.admin, { challenge: s.body.challenge });
    expect(asked.body.number).toBeGreaterThanOrEqual(10);
    expect(asked.body.number).toBeLessThanOrEqual(99);
    expect(asked.body.url).toMatch(/\/approve$/);
    const waiting = await verify(keys.admin, s.body.challenge, 'web');
    expect(waiting.status).toBe(202);
    expect(waiting.body).toEqual({ waiting: true });

    const weak = (await h.call('GET', '/api/auth/admin-unlocks')).body.requests;
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ account: 'admin@wren.test', device: 'Wren for Mac on Test Mac', canApprove: false });
    expect(JSON.stringify(weak)).not.toContain(`"number"`);
    expect((await h.call('POST', `/api/auth/admin-unlocks/${weak[0].id}`, { number: asked.body.number })).status).toBe(403);

    // Signed in again with the code: now it can.
    h.forget('admin-2fa');
    await h.login('admin@wren.test', PW, 'admin-2fa');
    expect((await h.call('POST', '/api/auth/mfa', { code: totp() })).status).toBe(200);
    const strong = (await h.call('GET', '/api/auth/admin-unlocks')).body.requests;
    expect(strong[0].canApprove).toBe(true);
    // Another person's browser sees nothing and can't answer it.
    h.as('sam');
    expect((await h.call('GET', '/api/auth/admin-unlocks')).body.requests).toEqual([]);
    expect((await h.call('POST', `/api/auth/admin-unlocks/${strong[0].id}`, { number: asked.body.number })).status).toBe(404);

    h.as('admin-2fa');
    expect((await h.call('POST', `/api/auth/admin-unlocks/${strong[0].id}`, { number: asked.body.number })).body).toEqual({ approved: true });
    const v = await verify(keys.admin, s.body.challenge, 'web');
    expect(v.status).toBe(200);
    expect(v.body.token).toBeTruthy();
    expect(get('SELECT 1 FROM sign_ins WHERE user_id = ? AND method = ? AND ok = 1', [ids.admin, 'app-admin+web'])).toBeTruthy();
  });

  it('denies a request when the wrong number is typed, or when it’s denied', async () => {
    h.as('admin-2fa');
    for (const answer of ['wrong', 'deny'] as const) {
      const s = await start(keys.admin);
      const { number } = (await app('POST', '/jmap/admin/unlock/web', keys.admin, { challenge: s.body.challenge })).body;
      const [req] = (await h.call('GET', '/api/auth/admin-unlocks')).body.requests;
      const r = await h.call('POST', `/api/auth/admin-unlocks/${req.id}`, { number: answer === 'wrong' ? (number === 99 ? 98 : number + 1) : null });
      expect(r.status).toBe(answer === 'wrong' ? 400 : 200);
      const v = await verify(keys.admin, s.body.challenge, 'web');
      expect(v.status).toBe(401);
      expect(v.body.error).toMatch(/denied/);
      // It's gone: the app starts again.
      expect((await verify(keys.admin, s.body.challenge, 'web')).status).toBe(401);
    }
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'auth.admin_unlock_denied'`)!.c).toBe(2);
  });
});

describe('using an unlock', () => {
  it('reaches the admin panel only with the token and the same app password', async () => {
    const token = await unlock(keys.admin);
    expect((await app('GET', '/api/admin/users', keys.admin, undefined, token)).status).toBe(200);
    // No token, someone else's token, another app password, or no app password: locked.
    expect((await app('GET', '/api/admin/users', keys.admin)).status).toBe(401);
    for (const r of [
      await app('GET', '/api/admin/users', keys.admin, undefined, 'x'.repeat(43)),
      await app('GET', '/api/admin/users', keys.admin2, undefined, token),
      await app('GET', '/api/admin/users', keys.dora, undefined, token),
    ]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('admin_locked');
    }
    const noKey = await h.app.request('/api/admin/users', { headers: { 'X-Wren-Admin': token } });
    expect(noKey.status).toBe(401);
  });

  it('reaches only what the app’s admin panel does', async () => {
    const token = await unlock(keys.admin);
    for (const [method, path] of [
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings'],
      ['GET', '/api/admin/export'],
      ['POST', '/api/admin/encryption-key'],
      ['GET', '/api/admin/providers'],
      ['POST', `/api/admin/users/${ids.sam}/password`],
      ['POST', `/api/admin/users/${ids.sam}/export`],
    ]) {
      const r = await app(method, path, keys.admin, method === 'GET' ? undefined : {}, token);
      expect([method, path, r.status, r.body.code]).toEqual([method, path, 403, 'admin_web_only']);
    }
    for (const path of ['/api/admin/overview', '/api/admin/outbox', '/api/admin/invites', '/api/admin/audit', `/api/admin/users/${ids.sam}/detail`]) {
      expect([path, (await app('GET', path, keys.admin, undefined, token)).status]).toEqual([path, 200]);
    }
  });

  it('marks what it does in the audit log', async () => {
    const token = await unlock(keys.admin);
    expect((await app('PUT', `/api/admin/users/${ids.sam}`, keys.admin, { mailApps: false }, token)).status).toBe(200);
    const entry = get<{ details: string; user_id: number }>(`SELECT details, user_id FROM audit_log WHERE action = 'admin.user_updated' ORDER BY id DESC LIMIT 1`)!;
    expect(entry.user_id).toBe(ids.admin);
    expect(JSON.parse(entry.details)).toEqual({ mailApps: false, via: 'app' });
    expect((await app('PUT', `/api/admin/users/${ids.sam}`, keys.admin, { mailApps: true }, token)).status).toBe(200);
  });

  it('keeps the usual checks: helpdesk staff get account support only', async () => {
    run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt(SECRET), ids.helen]);
    const token = await unlock(keys.helen);
    expect((await app('GET', '/api/admin/users', keys.helen, undefined, token)).status).toBe(200);
    expect((await app('POST', `/api/admin/users/${ids.sam}/signout`, keys.helen, {}, token)).status).toBe(200);
    expect((await app('GET', '/api/admin/overview', keys.helen, undefined, token)).status).toBe(403);
    expect((await app('PUT', `/api/admin/users/${ids.sam}`, keys.helen, { role: 'admin' }, token)).status).toBe(403);
    expect((await app('POST', `/api/admin/users/${ids.dora}/signout`, keys.helen, {}, token)).status).toBe(403);
  });

  it('ends after 15 minutes unused, after an hour, when locked, and when it stops being allowed', async () => {
    const ended = async (token: string) => {
      const r = await app('GET', '/api/admin/users', keys.admin, undefined, token);
      return r.status === 401 && r.body.code === 'admin_locked';
    };
    let token = await unlock(keys.admin);
    run('UPDATE admin_unlocks SET last_used_at = last_used_at - 15 * 60000 - 1 WHERE user_id = ? AND token_hash IS NOT NULL', [ids.admin]);
    expect(await ended(token)).toBe(true);

    token = await unlock(keys.admin);
    run('UPDATE admin_unlocks SET expires_at = ? WHERE user_id = ? AND token_hash IS NOT NULL', [Date.now() - 1, ids.admin]);
    expect(await ended(token)).toBe(true);

    token = await unlock(keys.admin);
    expect((await app('POST', '/jmap/admin/lock', keys.admin, {})).body).toEqual({ locked: true });
    expect(await ended(token)).toBe(true);

    // Revoking the app password ends it at once.
    token = await unlock(keys.admin2);
    expect((await app('GET', '/api/admin/users', keys.admin2, undefined, token)).status).toBe(200);
    h.as('admin');
    const key = (await h.call('GET', '/api/account/api-keys')).body.keys.find((k: any) => keys.admin2.startsWith(k.prefix));
    expect((await h.call('DELETE', `/api/account/api-keys/${key.id}`)).status).toBe(200);
    expect((await app('GET', '/api/admin/users', keys.admin2, undefined, token)).status).toBe(401);
    expect(get('SELECT 1 FROM admin_unlocks WHERE api_key_id = ?', [key.id])).toBeUndefined();

    // Turning off this person's mail apps, or losing the role, ends it too.
    run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt(SECRET), ids.dora]);
    token = await unlock(keys.dora);
    h.as('admin');
    expect((await h.call('PUT', `/api/admin/users/${ids.dora}`, { role: 'user' })).status).toBe(200);
    expect((await app('GET', '/api/admin/users', keys.dora, undefined, token)).status).toBe(403);
    expect((await h.call('PUT', `/api/admin/users/${ids.dora}`, { role: 'admin' })).status).toBe(200);
    expect((await h.call('PUT', `/api/admin/users/${ids.dora}`, { mailApps: false })).status).toBe(200);
    expect((await app('GET', '/api/admin/users', keys.dora, undefined, token)).status).toBe(401);
    expect((await h.call('PUT', `/api/admin/users/${ids.dora}`, { mailApps: true })).status).toBe(200);
  });

  it('leaves browser sessions working as before', async () => {
    h.as('admin');
    expect((await h.call('GET', '/api/admin/settings')).status).toBe(200);
    // (Helen signed Sam out above.)
    await h.login('sam@wren.test', PW, 'sam');
    expect((await h.call('GET', '/api/admin/users')).status).toBe(403);
  });
});
