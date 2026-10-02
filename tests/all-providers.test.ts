/**
 * Delivery status, the suppression list and meeting replies must work
 * whichever provider sends the mail, not just Resend: every provider with a
 * delivery webhook is fed a real-shaped bounce, providers without one are
 * covered by bounce emails, and every outbound adapter is checked to put a
 * calendar reply on the wire.
 */
import { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { all, get, insert, now, run } from '../src/server/db/index';
import { encryptJson } from '../src/server/lib/crypto';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { processQueue, toOutboundEmail } from '../src/server/mail/outbound';
import { saveDraft, sendDraft } from '../src/server/mail/send';
import { platform, setPlatform } from '../src/server/platform';
import { EVENT_PARSERS, EVENTS_SETUP } from '../src/server/providers/events';
import { getProviderDef, listProviderTypes } from '../src/server/providers/registry';
import type { ProviderContext } from '../src/server/providers/types';
import { buildReply, parseIcs } from '../src/shared/ics';
import { harness } from './harness';

const h = harness();
let admin = 0;
let bob = 0;
const restore: (() => void)[] = [];

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  bob = (await h.call('POST', '/api/admin/users', { email: 'bob@wren.test', name: 'Bob', password: 'bob password 123' })).body.id;
  h.as('admin');
});

afterEach(() => {
  while (restore.length) restore.pop()!();
});

function addProvider(type: string, cfg: Record<string, unknown> = {}, isDefault = false) {
  const token = `tok-${type}-${crypto.randomBytes(6).toString('hex')}`;
  const id = insert('INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [type, type, encryptJson(cfg), isDefault ? 1 : 0, token, now()]);
  return { id, token };
}

/** A message the admin sent through a provider, as the outbox records it. */
async function sent(to: string, providerId: number, providerMessageId: string | null) {
  const id = await saveDraft(admin, { to, subject: `To ${to}`, html: '<p>Hi</p>' });
  await sendDraft(admin, id, { undoSeconds: 0 });
  run(`UPDATE outbox SET status = 'sent', provider_id = ?, provider_message_id = ? WHERE message_id = ?`, [providerId, providerMessageId, id]);
  run(`UPDATE messages SET status = 'sent' WHERE id = ?`, [id]);
  const messageId = get<{ message_id: string }>('SELECT message_id FROM messages WHERE id = ?', [id])!.message_id;
  return { id, messageId };
}

const suppressed = (a: string) => get<{ reason: string }>('SELECT reason FROM suppressions WHERE address = ?', [a])?.reason ?? null;
const events = (messageId: number) => all<{ event: string; recipients: string }>(`SELECT event, recipients FROM delivery_log WHERE message_id = ? ORDER BY id`, [messageId]).map((e) => `${e.event}:${e.recipients}`);

/** P1363 (r‖s) → DER, as SendGrid signs. */
function rawToDer(raw: Uint8Array) {
  const int = (x: Uint8Array) => {
    let v = Buffer.from(x);
    while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(raw.slice(0, 32)), int(raw.slice(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

interface Case {
  type: string;
  cfg?: Record<string, unknown>;
  /** What the provider returned when Wren sent it (null: match by Message-ID). */
  pid?: (mid: string) => string | null;
  bounce: (pid: string, mid: string, rcpt: string) => unknown;
  get?: boolean;
}

const CASES: Case[] = [
  { type: 'resend', bounce: (pid, _m, r) => ({ type: 'email.bounced', data: { email_id: pid, to: [r], bounce: { type: 'Permanent', subType: 'General', message: '550 5.1.1' } } }) },
  {
    type: 'ses',
    bounce: (pid, _m, r) => ({
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', mail: { messageId: pid }, bounce: { bounceType: 'Permanent', bounceSubType: 'NoEmail', bouncedRecipients: [{ emailAddress: r, diagnosticCode: 'smtp; 550 5.1.1' }] } }),
    }),
  },
  { type: 'postmark', bounce: (pid, _m, r) => ({ RecordType: 'Bounce', MessageID: pid, Email: r, Type: 'HardBounce', Description: 'Unknown user' }) },
  { type: 'sendgrid', bounce: (pid, mid, r) => [{ email: r, event: 'bounce', type: 'bounce', sg_message_id: `${pid}.filterdrecv-1`, reason: '550 5.1.1 unknown', 'smtp-id': `<${mid}>` }] },
  { type: 'mailgun', pid: () => 'mailgun-queue-id', bounce: (_p, mid, r) => ({ 'event-data': { event: 'failed', severity: 'permanent', reason: 'bounce', recipient: r, message: { headers: { 'message-id': mid } }, 'delivery-status': { description: 'No such user' } } }) },
  { type: 'brevo', bounce: (pid, _m, r) => ({ event: 'hard_bounce', email: r, 'message-id': `<${pid}>`, reason: 'Unknown user' }) },
  { type: 'mailjet', pid: () => '1152921512345678', bounce: (pid, _m, r) => ({ event: 'bounce', email: r, MessageID: Number(pid), hard_bounce: true, error_related_to: 'recipient', error: 'user unknown' }) },
  { type: 'sparkpost', bounce: (pid, _m, r) => [{ msys: { message_event: { type: 'bounce', rcpt_to: r, transmission_id: pid, bounce_class: '10', raw_reason: '550 5.1.1' } } }] },
  { type: 'mailersend', bounce: (pid, _m, r) => ({ type: 'activity.hard_bounced', data: { email: { message: { id: pid }, recipient: { email: r } }, morph: { reason: 'Unknown user' } } }) },
  { type: 'mailchannels', bounce: (pid, _m, r) => [{ event: 'hard-bounced', email: r, message_id: pid, reason: '550 5.1.1' }] },
  { type: 'smtp2go', bounce: (pid, _m, r) => ({ event: 'bounce', email_id: pid, rcpt: r, bounce: 'hard', context: '550 5.1.1' }) },
  {
    type: 'zeptomail',
    bounce: (pid, _m, r) => ({ event_name: ['hardbounce'], event_message: [{ request_id: pid, email_info: { to: [{ email_address: { address: r } }] }, event_data: [{ details: [{ bounced_recipient: r, reason: 'Mailbox not found' }] }] }] }),
  },
  { type: 'elasticemail', get: true, bounce: (pid, _m, r) => `status=Error&category=NoMailbox&messageid=${encodeURIComponent(pid)}&to=${encodeURIComponent(r)}` },
  { type: 'mailtrap', bounce: (pid, _m, r) => ({ events: [{ event: 'bounce', email: r, message_id: pid, bounce_category: 'invalid', response: '550' }] }) },
  { type: 'scaleway', bounce: (pid, _m, r) => ({ Type: 'Notification', Message: JSON.stringify({ type: 'email_mailbox_not_found', email_id: pid, email_to: r }) }) },
  { type: 'postal', pid: (mid) => mid, bounce: (_p, mid, r) => ({ event: 'MessageDeliveryFailed', payload: { status: 'HardFail', details: '550 user unknown', message: { id: 1, message_id: mid, to: r } } }) },
  { type: 'webhook', pid: () => null, bounce: (_p, mid, r) => ({ events: [{ messageId: mid, type: 'bounced', recipients: [r], permanent: true, detail: 'gone' }] }) },
];

describe('delivery status from every provider', () => {
  it('every sending provider explains how bounces reach Wren', () => {
    const outbound = listProviderTypes().filter((t) => t.outbound && t.type !== 'log');
    for (const t of outbound) expect(EVENTS_SETUP[t.type], `${t.type} has no delivery-status setup`).toBeTruthy();
    // And every provider with a delivery webhook is tested below.
    for (const type of Object.keys(EVENT_PARSERS)) expect(CASES.some((c) => c.type === type), `${type} has no test`).toBe(true);
  });

  for (const c of CASES) {
    it(`${c.type}: a hard bounce is logged and the address suppressed`, async () => {
      const { id: providerId, token } = addProvider(c.type, c.cfg);
      const rcpt = `gone-${c.type}@example.org`;
      const pidValue = `pid-${c.type}-${crypto.randomBytes(4).toString('hex')}`;
      const placeholder = await sent(rcpt, providerId, null);
      const pid = c.pid ? c.pid(placeholder.messageId) : pidValue;
      run('UPDATE outbox SET provider_message_id = ? WHERE message_id = ?', [pid, placeholder.id]);
      const payload = c.bounce(pid ?? '', placeholder.messageId, rcpt);
      const r = c.get ? await h.call('GET', `/api/inbound/${token}?${payload}`) : await h.call('POST', `/api/inbound/${token}`, payload);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(events(placeholder.id)).toContain(`bounced:${rcpt}`);
      expect(suppressed(rcpt)).toBe('bounce');
      expect(get<any>('SELECT status FROM messages WHERE id = ?', [placeholder.id]).status).toBe('failed');
    });
  }

  it('a webhook for a message another provider sent, or another recipient, changes nothing', async () => {
    const a = addProvider('mailtrap');
    const b = addProvider('mailtrap');
    const m = await sent('keep@example.org', a.id, 'mt-shared-1');
    await h.call('POST', `/api/inbound/${b.token}`, { events: [{ event: 'bounce', email: 'keep@example.org', message_id: 'mt-shared-1' }] });
    await h.call('POST', `/api/inbound/${a.token}`, { events: [{ event: 'bounce', email: 'someone-else@example.org', message_id: 'mt-shared-1' }] });
    expect(events(m.id).filter((e) => e.startsWith('bounced'))).toEqual([]);
    expect(suppressed('keep@example.org')).toBeNull();
    expect(suppressed('someone-else@example.org')).toBeNull();
  });

  it('checks signatures where the provider signs (SendGrid, Mailgun, MailerSend)', async () => {
    const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    const sg = addProvider('sendgrid', { eventWebhookKey: spki });
    const m = await sent('signed@example.org', sg.id, 'sg-signed');
    const body = JSON.stringify([{ email: 'signed@example.org', event: 'bounce', type: 'bounce', sg_message_id: 'sg-signed.filter1', reason: 'gone' }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = rawToDer(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(ts + body))));
    expect((await h.call('POST', `/api/inbound/${sg.token}`, body, { 'x-twilio-email-event-webhook-signature': 'MEUCIQ' + 'A'.repeat(60), 'x-twilio-email-event-webhook-timestamp': ts })).status).toBe(401);
    expect((await h.call('POST', `/api/inbound/${sg.token}`, body, { 'x-twilio-email-event-webhook-signature': sig.toString('base64'), 'x-twilio-email-event-webhook-timestamp': ts })).status).toBe(200);
    expect(suppressed('signed@example.org')).toBe('bounce');
    expect(events(m.id)).toContain('bounced:signed@example.org');

    const mg = addProvider('mailgun', { webhookSigningKey: 'mg-signing-key' });
    const mm = await sent('mg-signed@example.org', mg.id, 'x');
    const t = String(Math.floor(Date.now() / 1000));
    const event = { event: 'failed', severity: 'permanent', recipient: 'mg-signed@example.org', message: { headers: { 'message-id': mm.messageId } } };
    expect((await h.call('POST', `/api/inbound/${mg.token}`, { signature: { timestamp: t, token: 'tk', signature: 'bad' }, 'event-data': event })).status).toBe(401);
    const good = crypto.createHmac('sha256', 'mg-signing-key').update(t + 'tk').digest('hex');
    expect((await h.call('POST', `/api/inbound/${mg.token}`, { signature: { timestamp: t, token: 'tk', signature: good }, 'event-data': event })).status).toBe(200);
    expect(suppressed('mg-signed@example.org')).toBe('bounce');

    const ms = addProvider('mailersend', { webhookSecret: 'ms-secret' });
    await sent('ms-signed@example.org', ms.id, 'ms-1');
    const msBody = JSON.stringify({ type: 'activity.spam_complaint', data: { email: { message: { id: 'ms-1' }, recipient: { email: 'ms-signed@example.org' } } } });
    expect((await h.call('POST', `/api/inbound/${ms.token}`, msBody, { signature: 'nope' })).status).toBe(401);
    const msSig = crypto.createHmac('sha256', 'ms-secret').update(msBody).digest('hex');
    expect((await h.call('POST', `/api/inbound/${ms.token}`, msBody, { signature: msSig })).status).toBe(200);
    expect(suppressed('ms-signed@example.org')).toBe('complaint');
  });

  it('still takes inbound mail on the same URL', async () => {
    const pm = addProvider('postmark');
    const r = await h.call('POST', `/api/inbound/${pm.token}`, {
      From: 'kim@example.org',
      FromFull: { Email: 'kim@example.org', Name: 'Kim' },
      To: 'admin@wren.test',
      ToFull: [{ Email: 'admin@wren.test' }],
      Subject: 'Inbound still works',
      TextBody: 'Hello',
      Headers: [],
      Attachments: [],
      MessageID: 'pm-inbound-1',
      OriginalRecipient: 'admin@wren.test',
    });
    expect(r.status).toBe(200);
    expect(get('SELECT 1 FROM messages WHERE subject = ?', ['Inbound still works'])).toBeTruthy();
  });
});

function dsn(to: string, original: { messageId: string; to: string }, recipients: { rcpt: string; action: string; status: string; diag: string }[]) {
  return Buffer.from(
    [
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      `To: ${to}`,
      'Subject: Delivery Status Notification (Failure)',
      `Message-ID: <dsn.${crypto.randomBytes(6).toString('hex')}@googlemail.com>`,
      `Date: ${new Date().toUTCString()}`,
      'Auto-Submitted: auto-replied',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="r1"',
      '',
      '--r1',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      "Your message wasn't delivered.",
      '--r1',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; googlemail.com',
      'Arrival-Date: Fri, 2 Oct 2026 08:00:00 +0000',
      '',
      ...recipients.flatMap((r) => [`Final-Recipient: rfc822; ${r.rcpt}`, `Action: ${r.action}`, `Status: ${r.status}`, `Diagnostic-Code: smtp; ${r.diag}`, '']),
      '--r1',
      'Content-Type: text/rfc822-headers',
      '',
      `From: admin@wren.test`,
      `To: ${original.to}`,
      `Message-ID: <${original.messageId}>`,
      'Subject: Hello',
      '',
      '--r1--',
      '',
    ].join('\r\n'),
  );
}

describe('bounces that come back by email (SMTP relays, Cloudflare Email Service)', () => {
  it('reads a bounce: logged, suppressed, failed, with no second notice', async () => {
    const smtp = addProvider('smtp', { host: 'smtp.example.org', port: 587 });
    const m = await sent('nobody@example.org', smtp.id, '4ABC123');
    const notices = () => get<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = 'system'`, [admin])!.c;
    const before = notices();
    await ingest(dsn('admin@wren.test', { messageId: m.messageId, to: 'nobody@example.org' }, [{ rcpt: 'nobody@example.org', action: 'failed', status: '5.1.1', diag: '550 5.1.1 The email account that you tried to reach does not exist.' }]), {
      rcptTo: ['admin@wren.test'],
      source: 'cloudflare-routing',
    });
    expect(events(m.id)).toContain('bounced:nobody@example.org');
    expect(suppressed('nobody@example.org')).toBe('bounce');
    expect(get<any>('SELECT status FROM messages WHERE id = ?', [m.id]).status).toBe('failed');
    expect(notices()).toBe(before); // the bounce itself is in the inbox; no Wren notice on top
    const report = get<any>(`SELECT folder, category FROM messages WHERE subject = 'Delivery Status Notification (Failure)' AND from_addr = 'mailer-daemon@googlemail.com' ORDER BY id DESC LIMIT 1`);
    expect(report).toEqual({ folder: 'inbox', category: 'primary' });
  });

  it('does not suppress for policy rejections, delays, other people’s mail or recipients the message never had', async () => {
    const smtp = addProvider('cloudflare-binding', { binding: 'EMAIL' });
    const m = await sent('policy@example.org, slow@example.org', smtp.id, null);
    await ingest(
      dsn('admin@wren.test', { messageId: m.messageId, to: 'policy@example.org' }, [
        { rcpt: 'policy@example.org', action: 'failed', status: '5.7.1', diag: '550 5.7.1 Message rejected as spam' },
        { rcpt: 'slow@example.org', action: 'delayed', status: '4.4.7', diag: '421 try again later' },
        { rcpt: 'stranger@example.org', action: 'failed', status: '5.1.1', diag: '550 no such user' },
      ]),
      { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' },
    );
    expect(events(m.id)).toEqual(expect.arrayContaining(['bounced:policy@example.org', 'delayed:slow@example.org']));
    expect(suppressed('policy@example.org')).toBeNull();
    expect(suppressed('slow@example.org')).toBeNull();
    expect(suppressed('stranger@example.org')).toBeNull();

    // A report sent to someone else about the admin's message is ignored.
    const other = await sent('target@example.org', smtp.id, null);
    await ingest(dsn('bob@wren.test', { messageId: other.messageId, to: 'target@example.org' }, [{ rcpt: 'target@example.org', action: 'failed', status: '5.1.1', diag: 'no such user' }]), {
      rcptTo: ['bob@wren.test'],
      source: 'cloudflare-routing',
    });
    expect(suppressed('target@example.org')).toBeNull();
    expect(bob).toBeGreaterThan(0);
  });

  it('reads spam complaints (ARF feedback reports)', async () => {
    const smtp = addProvider('smtp', { host: 'smtp.example.org', port: 587 });
    const m = await sent('complainer@example.org', smtp.id, null);
    const raw = Buffer.from(
      [
        'From: abuse@isp.example',
        'To: admin@wren.test',
        'Subject: Complaint about message',
        'MIME-Version: 1.0',
        'Content-Type: multipart/report; report-type=feedback-report; boundary="f1"',
        '',
        '--f1',
        'Content-Type: text/plain',
        '',
        'This is an abuse report.',
        '--f1',
        'Content-Type: message/feedback-report',
        '',
        'Feedback-Type: abuse',
        'User-Agent: ISP-FBL/1.0',
        'Version: 1',
        'Original-Rcpt-To: complainer@example.org',
        '',
        '--f1',
        'Content-Type: message/rfc822',
        '',
        'From: admin@wren.test',
        'To: complainer@example.org',
        `Message-ID: <${m.messageId}>`,
        'Subject: Hello',
        '',
        'Hi',
        '--f1--',
        '',
      ].join('\r\n'),
    );
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' });
    expect(events(m.id)).toContain('complained:complainer@example.org');
    expect(suppressed('complainer@example.org')).toBe('complaint');
  });

  it('SMTP: recipients refused while the rest are accepted bounce now, and a missing mailbox is suppressed', async () => {
    addProvider('smtp', { host: 'smtp.example.org', port: 587 }, true);
    const def = getProviderDef('smtp')!;
    const original = def.send;
    def.send = async () => ({
      providerMessageId: 'q-1',
      detail: '250 queued',
      rejected: [
        { rcpt: 'missing@example.org', reason: '550 5.1.1 <missing@example.org>: Recipient address rejected: User unknown', permanent: true, code: 550 },
        { rcpt: 'blocked@example.org', reason: '554 5.7.1 Relay access denied', permanent: true, code: 554 },
      ],
    });
    restore.push(() => (def.send = original));
    const id = await saveDraft(admin, { to: 'fine@example.org, missing@example.org, blocked@example.org', subject: 'Partial', html: '<p>x</p>' });
    await sendDraft(admin, id, { undoSeconds: 0 });
    run('UPDATE outbox SET next_attempt_at = 0 WHERE message_id = ?', [id]);
    await processQueue();
    expect(events(id)).toEqual(expect.arrayContaining(['sent:fine@example.org', 'bounced:missing@example.org', 'bounced:blocked@example.org']));
    expect(get<any>('SELECT status FROM messages WHERE id = ?', [id]).status).toBe('sent');
    expect(suppressed('missing@example.org')).toBe('bounce');
    expect(suppressed('blocked@example.org')).toBeNull();
    // The sender is told about the two that didn't get it.
    const notice = get<any>(`SELECT text_body FROM messages WHERE user_id = ? AND source = 'system' AND text_body LIKE '%"Partial"%' ORDER BY id DESC LIMIT 1`, [admin]);
    expect(notice.text_body).toMatch(/missing@example\.org/);
    expect(notice.text_body).toMatch(/blocked@example\.org/);
  });
});

/** Plausible settings for any provider's form. */
function configFor(type: string): Record<string, unknown> {
  const def = getProviderDef(type)!;
  const cfg: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.default !== undefined) cfg[f.key] = f.default;
    else if (f.type === 'select') cfg[f.key] = f.options?.[0]?.value;
    else if (f.type === 'boolean') cfg[f.key] = false;
    else if (f.type === 'number') cfg[f.key] = 587;
    else if (f.type === 'url' || /url/i.test(f.key)) cfg[f.key] = 'https://provider.example/api';
    else if (/region/i.test(f.key)) cfg[f.key] = 'us-east-1';
    else if (/host/i.test(f.key)) cfg[f.key] = 'smtp.provider.example';
    else cfg[f.key] = 'test-value-123';
  }
  return cfg;
}

const OK = {
  success: true,
  status: 'success',
  id: 'msg-1',
  MessageID: 'msg-1',
  MessageId: 'msg-1',
  messageId: 'msg-1',
  result: { message_id: 'msg-1', delivered: ['maya@northwind.example'], queued: [], permanent_bounces: [] },
  results: { id: 'msg-1', total_accepted_recipients: 1 },
  Messages: [{ Status: 'success', To: [{ MessageID: 1, MessageUUID: 'u' }] }],
  data: { message_id: 'msg-1', messages: { 'maya@northwind.example': { id: 1 } }, succeeded: 1 },
  emails: [{ id: 'msg-1' }],
};

/** What went over the wire, with base64 decoded: whole raw messages (SES, Postal…) and the MIME parts inside them. */
function decoded(input: string, depth = 0): string {
  if (depth > 2) return input;
  const text = input.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n'); // raw MIME inside a JSON string
  const blobs = [...(text.match(/[A-Za-z0-9+/]{200,}={0,2}/g) ?? []), ...(text.match(/(?:[A-Za-z0-9+/]{40,76}\r?\n)+[A-Za-z0-9+/]*={0,2}/g) ?? []).map((b) => b.replace(/\s+/g, ''))];
  return [text, ...blobs.map((b) => decoded(Buffer.from(b, 'base64').toString('utf8'), depth + 1))].join('\n');
}

/** APIs whose attachments have no content-type field: the reply goes as invite.ics, typed by its name. */
const UNTYPED_ATTACHMENTS = new Set(['brevo', 'mailersend']);

describe('meeting replies through every provider', () => {
  const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:uid-1@example', 'DTSTART:20261016T170000Z', 'DTEND:20261016T180000Z', 'ORGANIZER;CN=Maya:mailto:maya@northwind.example', 'SUMMARY:Planning', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const reply = buildReply(parseIcs(ics)!, { email: 'sam@wren.test', name: 'Sam' }, 'ACCEPTED');

  for (const info of listProviderTypes().filter((t) => t.outbound && getProviderDef(t.type)?.send)) {
    it(`${info.name} sends the reply as a calendar part`, async () => {
      const def = getProviderDef(info.type)!;
      const { raw } = await buildMime({
        from: { address: 'sam@wren.test', name: 'Sam' },
        to: [{ address: 'maya@northwind.example' }],
        subject: 'Accepted: Planning',
        html: '<p>Sam has accepted this invitation.</p>',
        calendar: { method: 'REPLY', content: reply },
      });
      const email = await toOutboundEmail(raw, { from: 'sam@wren.test', to: ['maya@northwind.example'] });
      expect(email.attachments.find((a) => a.contentType === 'text/calendar; method=REPLY')).toBeTruthy();
      const sent: string[] = [];
      const ctx: ProviderContext = {
        fetch: (async (_url: unknown, init: RequestInit = {}) => {
          sent.push(init.body == null ? '' : await new Response(init.body as BodyInit).text());
          return new Response(JSON.stringify(OK), { status: 200, headers: { 'content-type': 'application/json', 'x-message-id': 'msg-1' } });
        }) as typeof fetch,
      };
      const original = platform();
      let bindingRaw: string | null = null;
      setPlatform({
        ...original,
        emailBindings: () => ['EMAIL'],
        sendViaBinding: async (_b: string, _from: string, _to: string, mime: Buffer | Uint8Array | string) => {
          bindingRaw = Buffer.from(mime as Buffer).toString('utf8');
          return 'binding-1';
        },
      } as typeof original);
      try {
        await def.send!(configFor(info.type) as any, email, ctx).catch(() => {});
      } finally {
        setPlatform(original);
      }
      if (!sent.length && bindingRaw === null) {
        // SMTP and log-only hand over the raw message itself.
        expect(raw.toString()).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/);
        return;
      }
      const wire = decoded([...sent, bindingRaw ?? ''].join('\n'));
      expect(wire.includes('METHOD:REPLY'), `${info.type} dropped the calendar reply`).toBe(true);
      if (!UNTYPED_ATTACHMENTS.has(info.type)) expect(/text\/calendar/.test(wire), `${info.type} lost the calendar content type`).toBe(true);
      else expect(wire).toMatch(/invite\.ics/);
    });
  }
});
