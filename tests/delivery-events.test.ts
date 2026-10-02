import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, insert, now, run } from '../src/server/db/index';
import { encryptJson } from '../src/server/lib/crypto';
import { processQueue } from '../src/server/mail/outbound';
import { saveDraft, sendDraft } from '../src/server/mail/send';
import { getProviderDef } from '../src/server/providers/registry';
import { harness } from './harness';

const h = harness();
let alice = 0;
const TOKEN = 'tok-delivery-events-0123456789';

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  alice = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  insert('INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)', [
    'Resend',
    'resend',
    encryptJson({ apiKey: 're_test' }),
    TOKEN,
    now(),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

/** Send through the (stubbed) Resend API; returns the message id and the Resend email id. */
async function send(to: string, subject: string, resendId: string) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return Response.json({ id: resendId });
  });
  const id = await saveDraft(alice, { to, subject, html: '<p>Hello</p>' });
  await sendDraft(alice, id, { undoSeconds: 0 });
  run('UPDATE outbox SET next_attempt_at = 0 WHERE message_id = ?', [id]);
  await processQueue();
  vi.unstubAllGlobals();
  return { id, calls };
}

const webhook = (body: unknown) => h.call('POST', `/api/inbound/${TOKEN}`, body);
const log = (messageId: number) => all<{ event: string; recipients: string; detail: string }>('SELECT event, recipients, detail FROM delivery_log WHERE message_id = ? ORDER BY id', [messageId]);

describe('delivery status from Resend', () => {
  it('records delivered, then a hard bounce: logged once, suppressed, the sender told', async () => {
    const { id } = await send('bob@example.org', 'Quarterly report', 're_1');
    expect(get<any>('SELECT provider_message_id FROM outbox WHERE message_id = ?', [id]).provider_message_id).toBe('re_1');

    expect((await webhook({ type: 'email.delivered', data: { email_id: 're_1', to: ['bob@example.org'] } })).status).toBe(200);
    expect(log(id).map((l) => l.event)).toEqual(['sent', 'delivered']);

    const bounce = { type: 'email.bounced', data: { email_id: 're_1', to: ['bob@example.org'], bounce: { type: 'Permanent', subType: 'General', message: '550 5.1.1 user unknown' } } };
    await webhook(bounce);
    await webhook(bounce); // providers retry webhooks
    expect(log(id).map((l) => l.event)).toEqual(['sent', 'delivered', 'bounced']);
    expect(log(id)[2].detail).toMatch(/Bounced: General: 550 5\.1\.1 user unknown/);
    expect(get<any>('SELECT status, last_error FROM messages WHERE id = ?', [id])).toMatchObject({ status: 'failed' });
    expect(get<any>('SELECT reason FROM suppressions WHERE address = ?', ['bob@example.org'])).toEqual({ reason: 'bounce' });
    // A "delivery failed" notice in the sender's inbox.
    const notice = get<any>(`SELECT text_body, thread_id FROM messages WHERE user_id = ? AND subject = 'Delivery Status Notification (Failure)' ORDER BY id DESC LIMIT 1`, [alice]);
    expect(notice.text_body).toMatch(/"Quarterly report" couldn't be delivered to:\n  bob@example.org: General: 550 5\.1\.1 user unknown/);
    expect(notice.thread_id).toBe(get<any>('SELECT thread_id FROM messages WHERE id = ?', [id]).thread_id);
  });

  it('does not mail a suppressed address again until an admin removes it', async () => {
    const blocked = await send('bob@example.org', 'Second try', 're_2');
    expect(blocked.calls).toEqual([]); // never reached Resend
    expect(get<any>('SELECT status, last_error FROM outbox WHERE message_id = ?', [blocked.id])).toMatchObject({ status: 'failed' });
    expect(log(blocked.id).map((l) => l.event)).toEqual(['suppressed', 'failed']);
    expect(log(blocked.id)[0].detail).toMatch(/this address bounced on .* An administrator can remove it/);

    const list = (await h.call('GET', '/api/admin/suppressions')).body.items;
    expect(list).toMatchObject([{ address: 'bob@example.org', reason: 'bounce' }]);
    expect((await h.call('DELETE', `/api/admin/suppressions/${encodeURIComponent('bob@example.org')}`)).status).toBe(200);
    const again = await send('bob@example.org', 'Third try', 're_3');
    expect(again.calls).toHaveLength(1);
    expect(get<any>('SELECT status FROM messages WHERE id = ?', [again.id]).status).toBe('sent');
  });

  it('suppresses on complaints, treats soft bounces as deferred, and ignores mail Wren did not send', async () => {
    const { id } = await send('carol@example.org', 'Newsletter', 're_4');
    await webhook({ type: 'email.bounced', data: { email_id: 're_4', to: ['carol@example.org'], bounce: { type: 'Transient', subType: 'MailboxFull', message: 'mailbox full' } } });
    expect(log(id).at(-1)).toMatchObject({ event: 'deferred' });
    expect(get('SELECT 1 FROM suppressions WHERE address = ?', ['carol@example.org'])).toBeUndefined();
    await webhook({ type: 'email.complained', data: { email_id: 're_4', to: ['carol@example.org'] } });
    expect(get<any>('SELECT reason FROM suppressions WHERE address = ?', ['carol@example.org'])).toEqual({ reason: 'complaint' });

    const before = get<{ c: number }>('SELECT COUNT(*) AS c FROM delivery_log')!.c;
    await webhook({ type: 'email.bounced', data: { email_id: 're_from_another_app', to: ['dave@example.org'], bounce: { type: 'Permanent' } } });
    expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM delivery_log')!.c).toBe(before);
    expect(get('SELECT 1 FROM suppressions WHERE address = ?', ['dave@example.org'])).toBeUndefined();

    // Manual add, and the problems filter in the delivery log.
    expect((await h.call('POST', '/api/admin/suppressions', { address: 'Eve@Example.org' })).status).toBe(200);
    expect((await h.call('GET', '/api/admin/suppressions?q=eve')).body.items[0]).toMatchObject({ address: 'eve@example.org', reason: 'manual' });
    const problems = (await h.call('GET', '/api/admin/delivery-log?event=problems')).body.items.map((i: any) => i.event);
    expect(problems).toEqual(expect.arrayContaining(['complained', 'deferred', 'bounced', 'suppressed']));
  });
});

describe('delivery status from other providers', () => {
  const req = (json: unknown) => ({ json: () => json }) as any;

  it('reads SES bounce, complaint and delivery notifications', async () => {
    const ses = getProviderDef('ses')!;
    const note = (message: unknown) => req({ Type: 'Notification', Message: JSON.stringify(message) });
    const b = await ses.receive!({}, note({ notificationType: 'Bounce', mail: { messageId: 'ses-1' }, bounce: { bounceType: 'Permanent', bounceSubType: 'NoEmail', bouncedRecipients: [{ emailAddress: 'x@example.org', diagnosticCode: 'smtp; 550' }] } }), {} as any);
    expect(b.events).toEqual([{ providerMessageId: 'ses-1', type: 'bounced', recipients: ['x@example.org'], permanent: true, detail: 'NoEmail: smtp; 550' }]);
    const c = await ses.receive!({}, note({ notificationType: 'Complaint', mail: { messageId: 'ses-2' }, complaint: { complainedRecipients: [{ emailAddress: 'y@example.org' }] } }), {} as any);
    expect(c.events?.[0]).toMatchObject({ type: 'complained', recipients: ['y@example.org'] });
    const d = await ses.receive!({}, note({ eventType: 'Delivery', mail: { messageId: 'ses-3' }, delivery: { recipients: ['z@example.org'], smtpResponse: '250 OK' } }), {} as any);
    expect(d.events?.[0]).toMatchObject({ type: 'delivered', recipients: ['z@example.org'], detail: '250 OK' });
  });

  it('reads Postmark bounce, delivery and spam complaint webhooks', async () => {
    const pm = getProviderDef('postmark')!;
    const hard = await pm.receive!({}, req({ RecordType: 'Bounce', MessageID: 'pm-1', Email: 'a@example.org', Type: 'HardBounce', Description: 'The server was unable to deliver' }), {} as any);
    expect(hard.events?.[0]).toEqual({ providerMessageId: 'pm-1', type: 'bounced', recipients: ['a@example.org'], permanent: true, detail: 'HardBounce: The server was unable to deliver' });
    const soft = await pm.receive!({}, req({ RecordType: 'Bounce', MessageID: 'pm-2', Email: 'b@example.org', Type: 'SoftBounce' }), {} as any);
    expect(soft.events?.[0].permanent).toBe(false);
    const spam = await pm.receive!({}, req({ RecordType: 'SpamComplaint', MessageID: 'pm-3', Email: 'c@example.org' }), {} as any);
    expect(spam.events?.[0].type).toBe('complained');
  });
});
