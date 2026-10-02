import { beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/server/db/index';
import { harness, processQueue } from './harness';

const h = harness();
/** Past the undo-send delay, then deliver. */
const deliverNow = async () => {
  run(`UPDATE outbox SET next_attempt_at = 0 WHERE status = 'queued'`);
  await processQueue();
};
const PW = 'a very long password';
let sam = 0;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  sam = (await h.call('POST', '/api/admin/users', { email: 'sam@wren.test', name: 'Sam Lee', password: PW })).body.id;
});

describe('replying to your own messages', () => {
  it('a note to yourself replies to you, a sent message replies to its recipients', async () => {
    await h.call('POST', '/api/compose/send', { to: [{ address: 'admin@wren.test' }], subject: 'Note to self', html: '<p>milk</p>' });
    await deliverNow();
    const copy = get<{ id: number }>(`SELECT id FROM messages WHERE subject = 'Note to self' AND direction = 'in'`)!;
    const sent = get<{ id: number }>(`SELECT id FROM messages WHERE subject = 'Note to self' AND direction = 'out'`)!;
    for (const id of [copy.id, sent.id]) {
      const t = (await h.call('GET', `/api/compose/template?messageId=${id}&mode=reply`)).body;
      expect(t.to.map((a: any) => a.address)).toEqual(['admin@wren.test']);
    }

    await h.call('POST', '/api/compose/send', { to: [{ address: 'sam@wren.test' }], cc: [{ address: 'kim@example.org' }], subject: 'Plans', html: '<p>Friday?</p>' });
    await deliverNow();
    const out = get<{ id: number }>(`SELECT id FROM messages WHERE subject = 'Plans' AND direction = 'out' AND user_id = (SELECT id FROM users WHERE email = 'admin@wren.test')`)!;
    const all = (await h.call('GET', `/api/compose/template?messageId=${out.id}&mode=replyAll`)).body;
    expect(all.to.map((a: any) => a.address)).toEqual(['sam@wren.test']);
    expect(all.cc.map((a: any) => a.address)).toEqual(['kim@example.org']);
  });
});

describe('requiring a new password', () => {
  it('a temporary password only leads to “choose a new password”', async () => {
    expect((await h.call('POST', `/api/admin/users/${sam}/password`, { password: 'temporary password 1', mustChange: true })).status).toBe(200);
    expect((await h.call('GET', '/api/admin/users')).body.users.find((u: any) => u.id === sam).mustChangePassword).toBe(true);

    await h.login('sam@wren.test', 'temporary password 1', 'sam');
    expect((await h.call('GET', '/api/auth/me')).body.user.mustChangePassword).toBe(true);
    const blocked = await h.call('GET', '/api/mail/threads?folder=inbox');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('password_change_required');

    expect((await h.call('POST', '/api/account/password/required', { next: 'temporary password 1' })).body.error).toMatch(/haven’t used/);
    expect((await h.call('POST', '/api/account/password/required', { next: 'short' })).status).toBe(400);
    const done = await h.call('POST', '/api/account/password/required', { next: 'sam chose this one' });
    expect(done.status).toBe(200);
    expect(done.body.user.mustChangePassword).toBe(false);
    expect((await h.call('GET', '/api/mail/threads?folder=inbox')).status).toBe(200);
    // Only while it's required.
    expect((await h.call('POST', '/api/account/password/required', { next: 'another new one' })).status).toBe(400);
    expect((await h.login('sam@wren.test', 'sam chose this one', 'sam2')).status).toBe(200);
  });

  it('can be required without setting a password, takes effect at once, and clears however the password changes', async () => {
    h.as('admin@wren.test');
    expect((await h.call('PUT', `/api/admin/users/${sam}`, { requirePasswordChange: true })).status).toBe(200);
    h.as('sam2');
    expect((await h.call('GET', '/api/mail/threads?folder=inbox')).body.code).toBe('password_change_required');
    // Changing it the normal way (Settings → Security) counts.
    expect((await h.call('POST', '/api/account/password', { current: 'sam chose this one', next: 'changed in settings' })).status).toBe(200);
    expect((await h.call('GET', '/api/auth/me')).body.user.mustChangePassword).toBe(false);

    // So does a reset link.
    h.as('admin@wren.test');
    await h.call('PUT', `/api/admin/users/${sam}`, { requirePasswordChange: true });
    const { url } = (await h.call('POST', `/api/admin/users/${sam}/setup-link`, {})).body;
    h.as('link'); // the link signs that browser in as Sam
    expect((await h.call('POST', '/api/auth/reset', { token: new URL(url).searchParams.get('token'), password: 'set from the link' })).status).toBe(200);
    expect(get<{ c: number }>('SELECT password_change_required_at AS c FROM users WHERE id = ?', [sam])!.c).toBeTruthy();
    h.as('admin@wren.test');
    expect((await h.call('GET', `/api/admin/users/${sam}/detail`)).body.user.mustChangePassword).toBe(false);

    // Cancel, bulk, and not for yourself.
    await h.call('PUT', `/api/admin/users/${sam}`, { requirePasswordChange: true });
    await h.call('PUT', `/api/admin/users/${sam}`, { requirePasswordChange: false });
    expect((await h.call('GET', `/api/admin/users/${sam}/detail`)).body.user.mustChangePassword).toBe(false);
    const me = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
    expect((await h.call('PUT', `/api/admin/users/${me}`, { requirePasswordChange: true })).status).toBe(400);
    const bulk = (await h.call('POST', '/api/admin/users/bulk', { ids: [sam, me], action: 'requirePasswordChange' })).body.results;
    expect(bulk.map((r: any) => r.ok)).toEqual([true, false]);
    expect((await h.call('GET', `/api/admin/users/${sam}/detail`)).body.user.mustChangePassword).toBe(true);
    run('UPDATE users SET password_change_required_at = NULL WHERE id = ?', [sam]);
  });
});
