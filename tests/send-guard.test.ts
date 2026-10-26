import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, insert, now, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { checkSendGuard } from '../src/server/services/send-guard';
import { harness, processQueue } from './harness';

const h = harness();
const PW = 'a very long password';
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
let sam = 0;
let bob = 0;
let owner = 0;

const paused = (id: number) => get<{ send_paused_at: number | null; send_paused_reason: string | null }>('SELECT send_paused_at, send_paused_reason FROM users WHERE id = ?', [id])!;
const send = (subject: string, jar: string) => {
  h.as(jar);
  return h.call('POST', '/api/compose/send', { to: 'cole@wren.test', subject, html: '<p>Hi</p>' });
};
const lastAudit = (action: string) => get<{ target: string; details: string | null; user_id: number | null }>('SELECT target, details, user_id FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', [action]);
const openAlert = (id: number) => get<{ severity: string; title: string }>(`SELECT severity, title FROM alerts WHERE kind = 'sending' AND key = ? AND resolved_at IS NULL`, [String(id)]);
const settings = (values: Record<string, unknown>) => {
  h.as('admin');
  return h.call('PUT', '/api/admin/settings', values);
};

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW, 'admin');
  owner = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  sam = (await h.call('POST', '/api/admin/users', { email: 'sam@wren.test', name: 'Sam Lee', password: PW })).body.id;
  bob = (await h.call('POST', '/api/admin/users', { email: 'bob@wren.test', name: 'Bob Ray', password: PW })).body.id;
  await h.call('POST', '/api/admin/users', { email: 'cole@wren.test', name: 'Cole Park', password: PW });
  expect((await settings({ 'guard.maxPerHour': 3, 'jmap.enabled': true })).status).toBe(200);
  await h.login('sam@wren.test', PW, 'sam');
});

describe('compromised-account guard', () => {
  it('has sensible defaults and validates its settings', async () => {
    h.as('admin');
    const { defaults } = (await h.call('GET', '/api/admin/settings')).body;
    expect(defaults).toMatchObject({ 'guard.enabled': true, 'guard.maxPerHour': 100, 'guard.bounceRatePercent': 20 });
    expect((await settings({ 'guard.maxPerHour': 0 })).status).toBe(400);
    expect((await settings({ 'guard.bounceRatePercent': 101 })).status).toBe(400);
  });

  it('pauses on an hourly burst, alerts admins and holds queued mail', async () => {
    for (let i = 1; i <= 3; i++) expect((await send(`Burst ${i}`, 'sam')).status).toBe(200);
    const refused = await send('Burst 4', 'sam');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Sending is paused.*administrator/);
    expect(paused(sam).send_paused_reason).toMatch(/3 messages in the last hour/);
    expect(lastAudit('guard.sending_paused')).toMatchObject({ target: 'sam@wren.test', user_id: null });
    expect(openAlert(sam)).toMatchObject({ severity: 'critical', title: 'Sending paused for sam@wren.test' });
    // Admins hear about it in their inbox.
    expect(get(`SELECT 1 FROM messages WHERE user_id = ? AND subject = '[Alert] Sending paused for sam@wren.test'`, [owner])).toBeTruthy();

    // What was already queued stays held, even once it's due.
    run(`UPDATE outbox SET next_attempt_at = 0 WHERE user_id = ?`, [sam]);
    await processQueue();
    expect(all<{ status: string }>(`SELECT status FROM outbox WHERE user_id = ? AND kind = 'user'`, [sam]).map((r) => r.status)).toEqual(['queued', 'queued', 'queued']);
    // Held mail isn't a stuck queue.
    h.as('admin');
    await h.call('POST', '/api/admin/alerts/check');
    expect(get(`SELECT 1 FROM alerts WHERE kind = 'queue' AND resolved_at IS NULL`)).toBeFalsy();
  });

  it('keeps reading and receiving working, and tells the person', async () => {
    h.as('sam');
    expect((await h.call('GET', '/api/auth/me')).body.user.sendPaused).toBe(true);
    expect((await h.call('GET', '/api/mail/counters')).status).toBe(200);
    const { raw } = await buildMime({ from: { address: 'friend@example.org' }, to: [{ address: 'sam@wren.test' }], subject: 'Still arrives', text: 'hi' });
    await ingest(raw, { rcptTo: ['sam@wren.test'], source: 'cloudflare-routing' });
    expect(get(`SELECT 1 FROM messages WHERE user_id = ? AND subject = 'Still arrives'`, [sam])).toBeTruthy();
    // Drafts can still be saved; sending one can't.
    const draft = await h.call('POST', '/api/compose/drafts', { to: 'cole@wren.test', subject: 'Later', html: '<p>Hi</p>' });
    expect(draft.status).toBe(200);
    expect((await h.call('POST', `/api/compose/drafts/${draft.body.id}/send`, {})).status).toBe(403);
  });

  it('refuses mail apps (JMAP) and sending keys while paused', async () => {
    h.as('sam');
    const appPassword = (await h.call('POST', '/api/account/api-keys', { name: 'Phone', scope: 'mail' })).body.key;
    const sendKey = (await h.call('POST', '/api/account/api-keys', { name: 'Website' })).body.key;
    const headers = { Authorization: `Basic ${Buffer.from(`sam@wren.test:${appPassword}`).toString('base64')}`, 'Content-Type': 'application/json' };
    const jmap = async (methodCalls: unknown[]) => ((await (await h.app.request('/jmap/api', { method: 'POST', headers, body: JSON.stringify({ using: USING, methodCalls }) })).json()) as any).methodResponses;
    const [[, ids]] = await jmap([['Identity/get', { accountId: `u${sam}` }, 'i']]);
    const res = await jmap([
      [
        'Email/set',
        {
          accountId: `u${sam}`,
          create: { d: { mailboxIds: { drafts: true }, keywords: { $draft: true }, from: [{ email: 'sam@wren.test' }], to: [{ email: 'cole@wren.test' }], subject: 'Via app', textBody: [{ partId: 'b', type: 'text/plain' }], bodyValues: { b: { value: 'hi' } } } },
        },
        'd',
      ],
      ['EmailSubmission/set', { accountId: `u${sam}`, create: { s: { identityId: ids.list[0].id, emailId: '#d' } } }, 's'],
    ]);
    expect(res[1][1].notCreated.s).toMatchObject({ type: 'forbiddenToSend', description: expect.stringMatching(/Sending is paused/) });

    h.as('nobody');
    const api = await h.call('POST', '/api/v1/send', { to: 'cole@wren.test', subject: 'Via API', text: 'hi' }, { authorization: `Bearer ${sendKey}` });
    expect(api.status).toBe(403);
    expect(api.body.code).toBe('send_paused');
  });

  it('shows the pause to admins and resumes it, releasing held mail', async () => {
    h.as('admin');
    const detail = (await h.call('GET', `/api/admin/users/${sam}/detail`)).body.user;
    expect(detail.sendPausedAt).toBeGreaterThan(0);
    expect(detail.sendPausedReason).toMatch(/last hour/);

    expect((await h.call('POST', `/api/admin/users/${sam}/resume-sending`)).status).toBe(200);
    expect(paused(sam).send_paused_at).toBeNull();
    expect(lastAudit('admin.user_sending_resumed')).toMatchObject({ target: 'sam@wren.test', user_id: owner });
    expect(openAlert(sam)).toBeFalsy();
    expect((await h.call('POST', `/api/admin/users/${sam}/resume-sending`)).status).toBe(400);
    await vi.waitFor(async () => {
      await processQueue();
      expect(all<{ status: string }>(`SELECT status FROM outbox WHERE user_id = ? AND kind = 'user'`, [sam]).map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    });
  });

  it('counts afresh after a resume, so the next send isn’t paused again', async () => {
    expect((await send('Right after resume', 'sam')).status).toBe(200);
    expect(paused(sam).send_paused_at).toBeNull();
  });

  it('lets an admin pause someone by hand (audited)', async () => {
    h.as('admin');
    expect((await h.call('POST', `/api/admin/users/${sam}/pause-sending`, { reason: 'Reported phishing' })).status).toBe(200);
    expect(paused(sam).send_paused_reason).toBe('Reported phishing');
    expect(lastAudit('admin.user_sending_paused')).toMatchObject({ target: 'sam@wren.test', user_id: owner });
    expect((await h.call('POST', `/api/admin/users/${sam}/pause-sending`, {})).status).toBe(400);
    expect((await send('After manual pause', 'sam')).status).toBe(403);
    h.as('admin');
    await h.call('POST', `/api/admin/users/${sam}/resume-sending`);
    expect((await send('After resume', 'sam')).status).toBe(200);
  });

  it('pauses when too much of the last day’s mail hard-bounced', async () => {
    const ts = now();
    const job = (status: string) =>
      insert(`INSERT INTO outbox (kind, user_id, mail_from, recipients, raw_blob, subject, status, next_attempt_at, created_at, updated_at) VALUES ('user', ?, 'bob@wren.test', '["x@example.org"]', 'none', 'x', ?, ?, ?, ?)`, [
        bob,
        status,
        ts,
        ts - 2 * 3600_000,
        ts,
      ]);
    const bounce = (outboxId: number) =>
      insert(`INSERT INTO delivery_log (user_id, outbox_id, event, recipients, detail, created_at) VALUES (?, ?, 'bounced', 'x@example.org', 'Bounced: no such user', ?)`, [bob, outboxId, ts]);
    // 5 of 10 bounced: too few messages to judge yet.
    for (let i = 0; i < 10; i++) {
      const id = job('sent');
      if (i < 5) bounce(id);
    }
    await checkSendGuard();
    expect(paused(bob).send_paused_at).toBeNull();
    // 5 of 20 (25%) is over the 20% default.
    for (let i = 0; i < 10; i++) job('sent');
    await checkSendGuard();
    expect(paused(bob).send_paused_reason).toMatch(/5 of 20 messages .* bounced \(25%/);
    expect(openAlert(bob)).toBeTruthy();
  });

  it('guards the owner too, without locking them out of the admin panel', async () => {
    h.as('admin');
    for (let i = 1; i <= 3; i++) expect((await send(`Owner ${i}`, 'admin')).status).toBe(200);
    expect((await send('Owner 4', 'admin')).status).toBe(403);
    expect(paused(owner).send_paused_at).toBeGreaterThan(0);
    expect((await h.call('GET', '/api/admin/users')).status).toBe(200);
    expect((await h.call('POST', `/api/admin/users/${owner}/resume-sending`)).status).toBe(200);
  });

  it('does nothing when turned off', async () => {
    run(`DELETE FROM outbox`);
    expect((await settings({ 'guard.enabled': false })).status).toBe(200);
    for (let i = 1; i <= 5; i++) expect((await send(`Free ${i}`, 'sam')).status).toBe(200);
    expect(paused(sam).send_paused_at).toBeNull();
    // A pause an admin set still holds.
    h.as('admin');
    await h.call('POST', `/api/admin/users/${sam}/pause-sending`, {});
    expect((await send('Still paused', 'sam')).status).toBe(403);
  });
});
