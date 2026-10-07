import { beforeAll, describe, expect, it } from 'vitest';
import { get, now, run } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { findOneTimeCode } from '../src/server/mail/otp';
import { dueFollowUps } from '../src/server/mail/threads';
import { harness, processQueue } from './harness';

const h = harness();
const PW = 'a very long password';
const deliverNow = async () => {
  run(`UPDATE outbox SET next_attempt_at = 0 WHERE status = 'queued'`);
  await processQueue();
};
let n = 0;
const receive = (opts: { from: string; subject: string; body?: string; inReplyTo?: string; headers?: string[] }) => {
  const id = `<t${++n}.${Date.now()}@ext.example>`;
  const raw = [
    `From: ${opts.from}`, 'To: Ada Admin <admin@wren.test>', `Subject: ${opts.subject}`, `Message-ID: ${id}`,
    ...(opts.inReplyTo ? [`In-Reply-To: <${opts.inReplyTo}>`, `References: <${opts.inReplyTo}>`] : []),
    ...(opts.headers ?? []), `Date: ${new Date(Date.now() + n * 1000).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', opts.body ?? 'Hello', '',
  ].join('\r\n');
  return ingest(Buffer.from(raw), { rcptTo: ['admin@wren.test'], source: 'resend' }).then(() => id.slice(1, -1));
};
const msg = (messageId: string) => get<any>('SELECT * FROM messages WHERE message_id = ?', [messageId])!;
const inbox = async () => (await h.call('GET', '/api/mail/threads?view=inbox')).body.threads as any[];

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
});

describe('one-time codes', () => {
  it('finds sign-in codes and leaves other numbers alone', () => {
    expect(findOneTimeCode('980708 is your Whop sign-in code', 'Use this code to sign in')).toBe('980708');
    expect(findOneTimeCode('Your verification code', 'Enter 4821 to continue.')).toBe('4821');
    expect(findOneTimeCode('Sign in to Example', 'Your one-time passcode is 123 456. It expires in 10 minutes.')).toBe('123456');
    expect(findOneTimeCode('Security alert', 'Your login code: 73-1904')).toBeNull(); // not a code shape we offer
    expect(findOneTimeCode('Your receipt', 'Order 48213 total $59.00, thanks!')).toBeNull();
    expect(findOneTimeCode('Lunch?', 'Call me at 5551234 tomorrow')).toBeNull();
    expect(findOneTimeCode('Welcome to the 2026 conference', 'See you in 2026! Use code SAVE20 at checkout.')).toBeNull();
  });

  it('offers the code in the list, the message and the notification', async () => {
    const id = await receive({ from: 'Whop <no-reply@whop.example>', subject: '980708 is your Whop sign-in code', body: 'Use this code to sign in to your Whop account.' });
    expect(msg(id).otp).toBe('980708');
    expect((await inbox()).find((t) => t.subject.includes('Whop')).code).toBe('980708');
    expect((await h.call('GET', `/api/mail/messages/${msg(id).id}`)).body.code).toBe('980708');
    expect((await h.call('GET', '/api/me/notifications')).body.items.find((i: any) => i.subject.includes('Whop')).code).toBe('980708');
  });
});

describe('mute', () => {
  it('keeps new replies out of the inbox until unmuted', async () => {
    const first = await receive({ from: 'List <chatter@ext.example>', subject: 'Big group thread' });
    const thread = msg(first).thread_id;
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [thread], action: { type: 'mute' } })).status).toBe(200);
    expect((await inbox()).some((t) => t.id === thread)).toBe(false);
    const reply = await receive({ from: 'List <chatter@ext.example>', subject: 'Re: Big group thread', inReplyTo: first });
    expect(msg(reply)).toMatchObject({ thread_id: thread, folder: 'archive' });
    expect((await h.call('GET', `/api/mail/threads/${thread}`)).body.muted).toBe(true);
    await h.call('POST', '/api/mail/threads/actions', { threadIds: [thread], action: { type: 'unmute' } });
    const later = await receive({ from: 'List <chatter@ext.example>', subject: 'Re: Big group thread', inReplyTo: reply });
    expect(msg(later).folder).toBe('inbox');
  });
});

describe('remind me if no reply', () => {
  const sendNew = async (subject: string) => {
    const r = await h.call('POST', '/api/compose/send', { to: [{ address: 'kim@ext.example' }], subject, html: '<p>Any news?</p>' });
    await deliverNow();
    return msg(get<{ message_id: string }>('SELECT message_id FROM messages WHERE id = ?', [r.body.id])!.message_id);
  };

  it('brings the conversation back to the inbox when nobody replied', async () => {
    const sent = await sendNew('Contract signed?');
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [sent.thread_id], action: { type: 'followUp', at: now() + 3 * 86_400_000 } })).body.changed).toBe(1);
    expect((await h.call('GET', `/api/mail/threads/${sent.thread_id}`)).body.followUpAt).toBeGreaterThan(now());
    run('UPDATE threads SET follow_up_at = ? WHERE id = ?', [now() - 1, sent.thread_id]);
    const before = (await h.call('GET', '/api/mail/counters')).body.inbox;
    expect(dueFollowUps()).toBe(1);
    const row = (await inbox()).find((t) => t.id === sent.thread_id);
    expect(row.nudge.sentAt).toBe(sent.date);
    expect(row.unread).toBe(true);
    expect((await h.call('GET', '/api/mail/counters')).body.inbox).toBe(before + 1);
    // Archiving it puts it away again.
    await h.call('POST', '/api/mail/threads/actions', { threadIds: [sent.thread_id], action: { type: 'archive' } });
    expect((await inbox()).some((t) => t.id === sent.thread_id)).toBe(false);
  });

  it('does nothing when they replied in time', async () => {
    const sent = await sendNew('Dinner Saturday?');
    await h.call('POST', '/api/mail/threads/actions', { threadIds: [sent.thread_id], action: { type: 'followUp', at: now() + 86_400_000 } });
    await receive({ from: 'Kim <kim@ext.example>', subject: 'Re: Dinner Saturday?', inReplyTo: sent.message_id });
    expect(get<{ follow_up_at: number | null }>('SELECT follow_up_at FROM threads WHERE id = ?', [sent.thread_id])!.follow_up_at).toBeNull();
    expect(dueFollowUps()).toBe(0);
  });

  it('needs a message you sent', async () => {
    const id = await receive({ from: 'Kim <kim@ext.example>', subject: 'Just a hello' });
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [msg(id).thread_id], action: { type: 'followUp', at: now() + 1000 } })).body.changed).toBe(0);
  });
});

describe('merge conversations', () => {
  it('puts the messages of the selected conversations into the oldest one', async () => {
    const a = await receive({ from: 'Kim <kim@ext.example>', subject: 'Where are you?' });
    const b = await receive({ from: 'Kim <kim@ext.example>', subject: 'Re: Where are you?? (split)' });
    const [ta, tb] = [msg(a).thread_id, msg(b).thread_id];
    expect(ta).not.toBe(tb);
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [tb, ta], action: { type: 'merge' } })).body.changed).toBe(1);
    expect(msg(b).thread_id).toBe(ta);
    expect(get('SELECT 1 FROM threads WHERE id = ?', [tb])).toBeUndefined();
    expect((await h.call('GET', `/api/mail/threads/${ta}`)).body.messages).toHaveLength(2);
  });
});

describe('phishing', () => {
  it('reporting moves the sender’s mail to Spam and alerts admins', async () => {
    const id = await receive({ from: 'IT Support <it@wren-test-support.example>', subject: 'Your mailbox is full, verify now' });
    expect((await h.call('POST', `/api/mail/messages/${msg(id).id}/phishing`)).status).toBe(200);
    expect(msg(id).folder).toBe('spam');
    const alerts = (await h.call('GET', '/api/admin/alerts')).body.open;
    expect(alerts.find((a: any) => a.kind === 'phishing').title).toMatch(/Phishing reported by admin@wren.test/);
  });

  it('warns about mail that pretends to be from your own domain', async () => {
    const fake = await receive({ from: 'Ada Admin <admin@wren.test>', subject: 'Urgent wire transfer', headers: ['Authentication-Results: mx.example; spf=fail smtp.mailfrom=wren.test; dkim=none; dmarc=fail header.from=wren.test'] });
    expect((await h.call('GET', `/api/mail/messages/${msg(fake).id}`)).body.spoofWarning).toBe(true);
    const real = await receive({ from: 'Ada Admin <admin@wren.test>', subject: 'Round trip', headers: ['Authentication-Results: mx.example; spf=pass; dkim=pass header.d=wren.test; dmarc=pass'] });
    expect((await h.call('GET', `/api/mail/messages/${msg(real).id}`)).body.spoofWarning).toBe(false);
    const unknown = await receive({ from: 'Ada Admin <admin@wren.test>', subject: 'No auth headers' });
    expect((await h.call('GET', `/api/mail/messages/${msg(unknown).id}`)).body.spoofWarning).toBe(false);
    const outsider = await receive({ from: 'Kim <kim@ext.example>', subject: 'Failing outsider', headers: ['Authentication-Results: mx.example; spf=fail; dmarc=fail'] });
    expect((await h.call('GET', `/api/mail/messages/${msg(outsider).id}`)).body.spoofWarning).toBe(false);
  });
});

describe('contact groups', () => {
  it('can be created, found by autocomplete, edited and removed', async () => {
    const created = await h.call('POST', '/api/contacts/groups', { name: 'Design team', members: [{ address: 'Kim@ext.example', name: 'Kim' }, { address: 'lee@ext.example' }] });
    expect(created.status).toBe(200);
    expect((await h.call('POST', '/api/contacts/groups', { name: 'design TEAM', members: [{ address: 'x@ext.example' }] })).status).toBe(400);
    const found = (await h.call('GET', '/api/contacts?q=design')).body.groups;
    expect(found).toEqual([{ id: created.body.id, name: 'Design team', members: [{ address: 'kim@ext.example', name: 'Kim' }, { address: 'lee@ext.example', name: '' }] }]);
    await h.call('PUT', `/api/contacts/groups/${created.body.id}`, { name: 'Design', members: [{ address: 'kim@ext.example' }] });
    expect((await h.call('GET', '/api/contacts/groups')).body.groups[0]).toMatchObject({ name: 'Design', members: [{ address: 'kim@ext.example' }] });
    expect((await h.call('POST', '/api/contacts/groups', { name: 'Empty', members: [] })).status).toBe(400);
    expect((await h.call('DELETE', `/api/contacts/groups/${created.body.id}`)).status).toBe(200);
    expect((await h.call('GET', '/api/contacts/groups')).body.groups).toEqual([]);
  });
});
