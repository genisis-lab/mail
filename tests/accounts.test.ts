import { beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/server/db/index';
import { harness, linkIn, outbox } from './harness';

const h = harness();

beforeAll(async () => {
  expect((await h.setup()).status).toBe(200);
});

describe('admin creates a user with a setup link', () => {
  it('emails a one-time link to the personal address, which sets the password and verifies recovery', async () => {
    h.as('admin');
    await h.login('admin@wren.test', 'a very long password', 'admin');
    const created = await h.call('POST', '/api/admin/users', { email: 'nina@wren.test', name: 'Nina Park', setupEmail: 'Nina.Park@Example.org' });
    expect(created.status).toBe(200);
    expect(created.body.setupUrl).toMatch(/\/reset\?token=.+&setup=1$/);
    const mail = (await outbox()).find((m) => m.to.includes('nina.park@example.org'))!;
    expect(mail.subject).toMatch(/new Fernhill mailbox/);
    const { token } = linkIn(mail.text, '/reset');

    h.as('nina');
    const peek = await h.call('GET', `/api/auth/reset/${token}`);
    expect(peek.body).toMatchObject({ valid: true, kind: 'setup', email: 'nina@wren.test' });
    expect((await h.call('POST', '/api/auth/reset', { token, password: 'short' })).status).toBe(400);
    const done = await h.call('POST', '/api/auth/reset', { token, password: 'ninas new password' });
    expect(done.body).toMatchObject({ ok: true, signedIn: true });
    expect((await h.call('POST', '/api/auth/reset', { token, password: 'ninas new password' })).status).toBe(400); // single use
    expect((await h.call('GET', '/api/account/recovery')).body).toEqual({ email: 'nina.park@example.org', verified: true });
    // The new mailbox has a welcome message.
    const inbox = await h.call('GET', '/api/mail/threads?view=inbox');
    expect(inbox.body.threads.map((t: any) => t.subject)).toContain('Welcome to Fernhill');
  });

  it('requires either a password or a setup address', async () => {
    h.as('admin');
    expect((await h.call('POST', '/api/admin/users', { email: 'x@wren.test', name: 'X' })).status).toBe(400);
  });
});

describe('forgot password', () => {
  it('sends a reset link only to a verified recovery address, and answers the same either way', async () => {
    h.as('anon');
    const before = (await outbox()).length;
    expect((await h.call('POST', '/api/auth/forgot', { email: 'nobody@wren.test' })).body).toEqual({ ok: true });
    expect((await h.call('POST', '/api/auth/forgot', { email: 'admin@wren.test' })).body).toEqual({ ok: true }); // no recovery email
    expect((await outbox()).length).toBe(before);

    expect((await h.call('POST', '/api/auth/forgot', { email: 'NINA@wren.test' })).body).toEqual({ ok: true });
    const mail = (await outbox()).at(-1)!;
    expect(mail.to).toEqual(['nina.park@example.org']);
    const { token } = linkIn(mail.text, '/reset');
    const r = await h.call('POST', '/api/auth/reset', { token, password: 'another fresh password' });
    expect(r.body.signedIn).toBe(true);
    h.as('nina-old');
    expect((await h.call('POST', '/api/auth/login', { email: 'nina@wren.test', password: 'ninas new password' })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { email: 'nina@wren.test', password: 'another fresh password' })).status).toBe(200);
  });

  it('rejects expired links', async () => {
    h.as('anon2');
    await h.call('POST', '/api/auth/forgot', { email: 'nina@wren.test' });
    const { token } = linkIn((await outbox()).at(-1)!.text, '/reset');
    run('UPDATE auth_tokens SET expires_at = 1');
    expect((await h.call('GET', `/api/auth/reset/${token}`)).body).toEqual({ valid: false });
    expect((await h.call('POST', '/api/auth/reset', { token, password: 'yet another password' })).status).toBe(400);
  });
});

describe('recovery email', () => {
  it('needs the password, rejects own addresses, and is verified through the emailed link', async () => {
    h.as('admin');
    expect((await h.call('PUT', '/api/account/recovery', { email: 'ada@example.net', password: 'wrong password' })).status).toBe(401);
    expect((await h.call('PUT', '/api/account/recovery', { email: 'admin@wren.test', password: 'a very long password' })).status).toBe(400);
    const set = await h.call('PUT', '/api/account/recovery', { email: 'ada@example.net', password: 'a very long password' });
    expect(set.body).toEqual({ email: 'ada@example.net', verified: false });
    const { token } = linkIn((await outbox()).at(-1)!.text, '/verify-recovery');
    h.as('anon3');
    expect((await h.call('POST', '/api/auth/verify-recovery', { token })).body).toEqual({ ok: true, email: 'ada@example.net' });
    h.as('admin');
    expect((await h.call('GET', '/api/account/recovery')).body.verified).toBe(true);
  });
});

describe('invitations', () => {
  it('emails the invite, verifies that address on sign-up, and rotates the link on resend', async () => {
    h.as('admin');
    const inv = await h.call('POST', '/api/admin/invites', { email: 'omar@wren.test', sendTo: 'omar@personal.example', days: 3 });
    expect(inv.body.emailed).toBe(true);
    const first = linkIn((await outbox()).at(-1)!.text, '/register');
    const again = await h.call('POST', `/api/admin/invites/${inv.body.id}/resend`, {});
    expect(again.body.sentTo).toBe('omar@personal.example');
    const second = linkIn((await outbox()).at(-1)!.text, '/register');
    expect(second.token).not.toBe(first.token);

    h.as('omar');
    expect((await h.call('GET', `/api/auth/invite/${first.token}`)).body.valid).toBe(false);
    const reg = await h.call('POST', '/api/auth/register', { localPart: 'omar', domain: 'wren.test', name: 'Omar', password: 'omars password 1', invite: second.token });
    expect(reg.status).toBe(200);
    expect((await h.call('GET', '/api/account/recovery')).body).toEqual({ email: 'omar@personal.example', verified: true });
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM messages m JOIN users u ON u.id = m.user_id WHERE u.email = 'omar@wren.test' AND m.subject = 'Welcome to Fernhill'`)!.c).toBe(1);
  });

  it('lets admins send a reset link to the recovery address', async () => {
    h.as('admin');
    const omar = get<{ id: number }>(`SELECT id FROM users WHERE email = 'omar@wren.test'`)!;
    expect((await h.call('POST', `/api/admin/users/${omar.id}/reset-link`)).body).toEqual({ sentTo: 'omar@personal.example' });
    const link = await h.call('POST', `/api/admin/users/${omar.id}/setup-link`, {});
    expect(link.body.url).toMatch(/\/reset\?token=/);
  });
});
