import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, now, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { runJobs } from '../src/server/services/jobs';
import { getPrefs, savePrefs } from '../src/server/services/users';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';
let sam = 0;
let cole = 0;

const userId = (email: string) => get<{ id: number }>('SELECT id FROM users WHERE email = ?', [email])?.id;
const addressOf = (address: string) => get<{ kind: string; user_id: number | null }>('SELECT kind, user_id FROM addresses WHERE address = ?', [address]);
const deliver = async (to: string, subject: string) => {
  const { raw } = await buildMime({ from: { address: 'friend@example.org' }, to: [{ address: to }], subject, text: 'hi' });
  await ingest(raw, { rcptTo: [to], source: 'cloudflare-routing' });
};
const inboxOf = (id: number, subject: string) => get('SELECT 1 FROM messages WHERE user_id = ? AND subject = ?', [id, subject]);

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  await h.call('POST', '/api/admin/domains', { name: 'other.test' });
  sam = (await h.call('POST', '/api/admin/users', { email: 'sam@wren.test', name: 'Sam Lee', password: PW })).body.id;
  cole = (await h.call('POST', '/api/admin/users', { email: 'cole@wren.test', name: 'Cole Park', password: PW })).body.id;
});

describe('changing a user’s address', () => {
  it('moves the mailbox, keeps the old address as an alias, and tells them', async () => {
    const prefs = getPrefs(sam);
    savePrefs(sam, { ...prefs, signatures: { 'sam@wren.test': '<p>Sam</p>' }, defaultFrom: 'sam@wren.test' });

    const r = await h.call('POST', `/api/admin/users/${sam}/rename`, { email: ' Samuel@Other.test ', keepOldAsAlias: true });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe('samuel@other.test');
    expect(userId('samuel@other.test')).toBe(sam);
    expect(addressOf('samuel@other.test')).toEqual({ kind: 'mailbox', user_id: sam });
    expect(addressOf('sam@wren.test')).toEqual({ kind: 'alias', user_id: sam });
    const after = getPrefs(sam);
    expect(after.signatures['samuel@other.test']).toBe('<p>Sam</p>');
    expect(after.defaultFrom).toBe('');
    expect(inboxOf(sam, 'Your email address changed')).toBeTruthy();
    expect(get<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'admin.user_renamed' ORDER BY id DESC LIMIT 1`)).toBeTruthy();

    // They sign in with the new address; mail to the old one still arrives.
    expect((await h.login('samuel@other.test', PW, 'sam')).status).toBe(200);
    expect((await h.call('GET', '/api/auth/me')).body.user.email).toBe('samuel@other.test');
    expect((await h.login('sam@wren.test', PW, 'old')).status).toBe(401);
    h.as('admin@wren.test');
    await deliver('sam@wren.test', 'To the old address');
    expect(inboxOf(sam, 'To the old address')).toBeTruthy();
  });

  it('refuses a taken address, can promote their own alias, and can free the old one', async () => {
    expect((await h.call('POST', `/api/admin/users/${sam}/rename`, { email: 'cole@wren.test' })).status).toBe(409);
    expect((await h.call('POST', `/api/admin/users/${sam}/rename`, { email: 'sam@nowhere.example' })).body.error).toMatch(/not hosted/);
    expect((await h.call('POST', `/api/admin/users/${sam}/rename`, { email: 'bad name@wren.test' })).status).toBe(400);

    // sam@wren.test is their alias: it becomes the mailbox again.
    const back = await h.call('POST', `/api/admin/users/${sam}/rename`, { email: 'sam@wren.test', keepOldAsAlias: false });
    expect(back.status).toBe(200);
    expect(addressOf('sam@wren.test')).toEqual({ kind: 'mailbox', user_id: sam });
    expect(addressOf('samuel@other.test')).toBeUndefined();
    expect(all('SELECT 1 FROM addresses WHERE user_id = ?', [sam])).toHaveLength(1);
  });
});

describe('owner protection', () => {
  it('stops other admins renaming or signing out the owner', async () => {
    await h.call('POST', '/api/admin/users', { email: 'deputy@wren.test', name: 'Deputy', password: PW, role: 'admin' });
    const owner = userId('admin@wren.test')!;
    await h.login('deputy@wren.test', PW);
    expect((await h.call('POST', `/api/admin/users/${owner}/rename`, { email: 'boss@wren.test' })).status).toBe(403);
    expect((await h.call('POST', `/api/admin/users/${owner}/signout`)).status).toBe(403);
    expect((await h.call('PUT', `/api/admin/users/${owner}/mail-handling`, { forwarding: { enabled: true, to: 'deputy@wren.test' } })).status).toBe(403);
    expect((await h.call('POST', `/api/admin/users/${owner}/export`)).status).toBe(403);
    // Other people are fine.
    expect((await h.call('POST', `/api/admin/users/${cole}/signout`)).status).toBe(200);
    h.as('admin@wren.test');
  });
});

describe('lockouts', () => {
  it('shows a locked-out user and unlocks them', async () => {
    run(`INSERT OR REPLACE INTO login_attempts (key, count, reset_at) VALUES ('login:user:cole@wren.test', 99, ?)`, [now() + 600_000]);
    expect((await h.call('GET', `/api/admin/users/${cole}/detail`)).body.user.lockedUntil).toBeGreaterThan(now());
    expect((await h.call('GET', '/api/admin/users')).body.users.find((u: any) => u.id === cole).locked).toBe(true);
    expect((await h.login('cole@wren.test', PW, 'cole')).status).toBe(429);

    h.as('admin@wren.test');
    expect((await h.call('POST', `/api/admin/users/${cole}/unlock`)).status).toBe(200);
    expect((await h.call('GET', `/api/admin/users/${cole}/detail`)).body.user.lockedUntil).toBeNull();
    expect((await h.login('cole@wren.test', PW, 'cole')).status).toBe(200);
    h.as('admin@wren.test');
  });
});

describe('out of office and forwarding for someone', () => {
  it('sets an automatic reply and forwarding, within the forwarding policy', async () => {
    expect((await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, { vacation: { enabled: true, message: '  ' } })).body.error).toMatch(/Write the automatic reply/);
    const r = await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, {
      vacation: { enabled: true, subject: 'Cole has left', message: 'Please write to sam@wren.test.', endAt: null },
      forwarding: { enabled: true, to: 'Sam@wren.test', keep: 'archive' },
    });
    expect(r.status).toBe(200);
    const prefs = getPrefs(cole);
    expect(prefs.vacation).toMatchObject({ enabled: true, subject: 'Cole has left' });
    expect(prefs.forwarding).toEqual({ enabled: true, to: 'sam@wren.test', keep: 'archive' });
    expect((await h.call('GET', `/api/admin/users/${cole}/detail`)).body.mailHandling.forwarding.to).toBe('sam@wren.test');

    // External forwarding follows the server policy; hosted addresses are always allowed.
    await h.call('PUT', '/api/admin/settings', { 'mail.allowExternalForwarding': false });
    expect((await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, { forwarding: { enabled: true, to: 'cole@gmail.example' } })).body.error).toMatch(/turned off/);
    expect((await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, { forwarding: { enabled: true, to: 'sam@wren.test' } })).status).toBe(200);
    expect((await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, { forwarding: { enabled: true, to: 'cole@wren.test' } })).body.error).toMatch(/same mailbox/);
    await h.call('PUT', '/api/admin/settings', { 'mail.allowExternalForwarding': true });
    await h.call('PUT', `/api/admin/users/${cole}/mail-handling`, { vacation: { enabled: false }, forwarding: { enabled: false } });
    expect(getPrefs(cole).forwarding.enabled).toBe(false);
  });
});

describe('mail export for someone', () => {
  it('exports their mail as mbox for the admin to download', async () => {
    await deliver('cole@wren.test', 'Handover notes');
    const start = await h.call('POST', `/api/admin/users/${cole}/export`);
    expect(start.status).toBe(200);
    const jobId = start.body.job.id;
    expect((await h.call('GET', `/api/admin/users/${cole}/export/${jobId}/download`)).status).toBe(400);
    for (let i = 0; i < 50 && ['queued', 'running'].includes(get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [jobId])!.status); i++) {
      run('UPDATE jobs SET next_run_at = 0 WHERE id = ?', [jobId]);
      await runJobs();
    }
    const detail = (await h.call('GET', `/api/admin/users/${cole}/detail`)).body;
    expect(detail.exports[0]).toMatchObject({ id: jobId, status: 'done' });
    const res = await h.request(`/api/admin/users/${cole}/export/${jobId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="cole@wren\.test-\d{4}-\d{2}-\d{2}\.mbox"/);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('Subject: Handover notes');
    // Another user's job id doesn't work through this user.
    expect((await h.call('GET', `/api/admin/users/${sam}/export/${jobId}/download`)).status).toBe(404);
    expect((await h.call('DELETE', `/api/admin/users/${cole}/export/${jobId}`)).status).toBe(200);
    expect(get('SELECT 1 FROM jobs WHERE id = ?', [jobId])).toBeUndefined();
  });
});

describe('deleting a user and handing over their addresses', () => {
  it('turns their addresses and catch-all into someone else’s', async () => {
    await h.call('POST', '/api/admin/addresses', { address: 'cole.park@wren.test', kind: 'alias', userId: cole });
    run(`UPDATE domains SET catch_all_user_id = ? WHERE name = 'wren.test'`, [cole]);
    expect((await h.call('DELETE', `/api/admin/users/${cole}?transferTo=${cole}`)).status).toBe(400);
    const r = await h.call('DELETE', `/api/admin/users/${cole}?transferTo=${sam}`);
    expect(r.body).toEqual({ ok: true, moved: 2 });
    expect(userId('cole@wren.test')).toBeUndefined();
    expect(addressOf('cole@wren.test')).toEqual({ kind: 'alias', user_id: sam });
    expect(addressOf('cole.park@wren.test')).toEqual({ kind: 'alias', user_id: sam });
    expect(get<{ catch_all_user_id: number }>(`SELECT catch_all_user_id FROM domains WHERE name = 'wren.test'`)!.catch_all_user_id).toBe(sam);
    await deliver('cole@wren.test', 'For Cole after he left');
    expect(inboxOf(sam, 'For Cole after he left')).toBeTruthy();
    run(`UPDATE domains SET catch_all_user_id = NULL WHERE name = 'wren.test'`);
  });
});
