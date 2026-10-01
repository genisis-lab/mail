import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getProviderDef, listProviderTypes } from '../src/server/providers/registry';
import { buildMime } from '../src/server/mail/compose';
import { toOutboundEmail } from '../src/server/mail/outbound';
import { ProviderError, type InboundRequest, type ProviderContext } from '../src/server/providers/types';

interface Captured {
  url: string;
  init: RequestInit;
  json?: any;
}

function fakeFetch(response: unknown = {}, status = 200, headers: Record<string, string> = {}) {
  const calls: Captured[] = [];
  const ctx: ProviderContext = {
    fetch: (async (url: any, init: any = {}) => {
      const c: Captured = { url: String(url), init };
      if (typeof init.body === 'string') {
        try {
          c.json = JSON.parse(init.body);
        } catch {
          /* not json */
        }
      }
      calls.push(c);
      const body = typeof response === 'function' ? (response as any)(c) : response;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    }) as typeof fetch,
  };
  return { ctx, calls };
}

async function sampleEmail() {
  const { raw } = await buildMime({
    from: { address: 'alice@acme.test', name: 'Alice' },
    to: [{ address: 'bob@example.com', name: 'Bob' }],
    cc: [{ address: 'carol@example.com' }],
    bcc: [{ address: 'secret@example.com' }],
    subject: 'Hello there',
    html: '<p>Hi <b>Bob</b></p>',
    inReplyTo: 'parent@x',
    references: ['root@x', 'parent@x'],
    attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('file') }],
  });
  return toOutboundEmail(raw, { from: 'alice@acme.test', to: ['bob@example.com', 'carol@example.com', 'secret@example.com'] });
}

function inboundReq(body: Buffer | string, contentType: string, headers: Record<string, string> = {}, url = 'https://wren.test/api/inbound/tok'): InboundRequest {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': contentType, ...headers }),
    url: new URL(url),
    body: buf,
    contentType,
    form: () => new Response(new Uint8Array(buf), { headers: { 'content-type': contentType } }).formData(),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

describe('provider registry', () => {
  it('exposes many providers with consistent metadata', () => {
    const types = listProviderTypes();
    expect(types.length).toBeGreaterThanOrEqual(20);
    for (const t of types) {
      expect(t.name).toBeTruthy();
      expect(t.outbound || t.inbound).toBe(true);
      const def = getProviderDef(t.type)!;
      expect(!!def.send).toBe(t.outbound);
      expect(!!def.receive).toBe(t.inbound);
    }
    expect(types.filter((t) => t.outbound).length).toBeGreaterThanOrEqual(17);
  });
});

describe('outbound adapters', () => {
  it('toOutboundEmail keeps threading headers and splits bcc from the envelope', async () => {
    const e = await sampleEmail();
    expect(e.headers['In-Reply-To']).toBe('<parent@x>');
    expect(e.headers['References']).toBe('<root@x> <parent@x>');
    expect(e.raw.toString()).not.toMatch(/^Bcc:/im);
    expect(e.attachments[0].filename).toBe('a.txt');
  });

  it('Resend', async () => {
    const { ctx, calls } = fakeFetch({ id: 're_123' });
    const r = await getProviderDef('resend')!.send!({ apiKey: 'k' }, await sampleEmail(), ctx);
    expect(r.providerMessageId).toBe('re_123');
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer k');
    expect(calls[0].json.to).toEqual(['Bob <bob@example.com>']);
    expect(calls[0].json.bcc).toEqual(['secret@example.com']);
    expect(calls[0].json.headers['In-Reply-To']).toBe('<parent@x>');
    expect(calls[0].json.headers['Message-ID']).toBeUndefined();
    expect(calls[0].json.attachments[0]).toMatchObject({ filename: 'a.txt', content: Buffer.from('file').toString('base64') });
  });

  it('Cloudflare Email Service uses send_raw with the envelope', async () => {
    const { ctx, calls } = fakeFetch({ success: true, result: { message_id: 'cf1', delivered: ['bob@example.com'], queued: [], permanent_bounces: [] } });
    const e = await sampleEmail();
    const r = await getProviderDef('cloudflare')!.send!({ accountId: 'acc', apiToken: 't' }, e, ctx);
    expect(r.providerMessageId).toBe('cf1');
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send_raw');
    expect(calls[0].json.recipients).toEqual(e.envelope.to);
    expect(calls[0].json.mime_message).toContain('Subject: Hello there');
  });

  it('Cloudflare permanent bounce becomes a permanent error', async () => {
    const { ctx } = fakeFetch({ success: true, result: { message_id: 'x', delivered: [], queued: [], permanent_bounces: ['bob@example.com'] } });
    await expect(getProviderDef('cloudflare')!.send!({ accountId: 'a', apiToken: 't' }, await sampleEmail(), ctx)).rejects.toMatchObject({ permanent: true });
  });

  it('Amazon SES signs the request and sends raw MIME', async () => {
    const { ctx, calls } = fakeFetch({ MessageId: 'ses-1' });
    const r = await getProviderDef('ses')!.send!({ region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: 'SK' }, await sampleEmail(), ctx);
    expect(r.providerMessageId).toBe('ses-1');
    expect(calls[0].url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    expect((calls[0].init.headers as any).Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/eu-west-1\/ses\/aws4_request/);
    const body = JSON.parse(calls[0].init.body as string);
    expect(Buffer.from(body.Content.Raw.Data, 'base64').toString()).toContain('Hello there');
  });

  it('Postmark maps fields and surfaces API errors', async () => {
    const ok = fakeFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    const r = await getProviderDef('postmark')!.send!({ serverToken: 't' }, await sampleEmail(), ok.ctx);
    expect(r.providerMessageId).toBe('pm-1');
    expect(ok.calls[0].json).toMatchObject({ To: 'Bob <bob@example.com>', Cc: 'carol@example.com', Bcc: 'secret@example.com', MessageStream: 'outbound' });
    const bad = fakeFetch({ ErrorCode: 300, Message: 'Invalid email' });
    await expect(getProviderDef('postmark')!.send!({ serverToken: 't' }, await sampleEmail(), bad.ctx)).rejects.toBeInstanceOf(ProviderError);
  });

  it('SendGrid uses personalizations and returns X-Message-Id', async () => {
    const { ctx, calls } = fakeFetch('', 202, { 'x-message-id': 'sg-1' });
    const r = await getProviderDef('sendgrid')!.send!({ apiKey: 'SG.x' }, await sampleEmail(), ctx);
    expect(r.providerMessageId).toBe('sg-1');
    expect(calls[0].json.personalizations[0].to).toEqual([{ email: 'bob@example.com', name: 'Bob' }]);
    expect(calls[0].json.content.map((c: any) => c.type)).toEqual(['text/plain', 'text/html']);
  });

  it('Mailgun posts raw MIME as multipart', async () => {
    const { ctx, calls } = fakeFetch({ id: '<mg-1@mailgun>', message: 'Queued' });
    const r = await getProviderDef('mailgun')!.send!({ apiKey: 'k', domain: 'mg.acme.test', region: 'eu' }, await sampleEmail(), ctx);
    expect(r.providerMessageId).toBe('mg-1@mailgun');
    expect(calls[0].url).toBe('https://api.eu.mailgun.net/v3/mg.acme.test/messages.mime');
    const form = calls[0].init.body as FormData;
    expect(form.getAll('to')).toHaveLength(3);
  });

  it('Postal treats status:error bodies as failures', async () => {
    const { ctx } = fakeFetch({ status: 'error', data: { code: 'UnauthenticatedFromAddress', message: 'nope' } });
    await expect(getProviderDef('postal')!.send!({ baseUrl: 'https://p.test', apiKey: 'k' }, await sampleEmail(), ctx)).rejects.toThrow(/Postal/);
  });

  it.each([
    ['brevo', { apiKey: 'k' }, { messageId: '<b1>' }, 'https://api.brevo.com/v3/smtp/email'],
    ['mailjet', { apiKey: 'k', secretKey: 's' }, { Messages: [{ Status: 'success', To: [{ MessageID: 9 }] }] }, 'https://api.mailjet.com/v3.1/send'],
    ['sparkpost', { apiKey: 'k' }, { results: { id: 'sp1', total_accepted_recipients: 3 } }, 'https://api.sparkpost.com/api/v1/transmissions'],
    ['smtp2go', { apiKey: 'k' }, { data: { succeeded: 3, failed: 0, email_id: 's2g' } }, 'https://api.smtp2go.com/v3/email/send'],
    ['zeptomail', { token: 'k' }, { request_id: 'z1' }, 'https://api.zeptomail.com/v1.1/email'],
    ['elasticemail', { apiKey: 'k' }, { MessageID: 'e1' }, 'https://api.elasticemail.com/v4/emails/transactional'],
    ['mailtrap', { apiToken: 'k' }, { success: true, message_ids: ['mt1'] }, 'https://send.api.mailtrap.io/api/send'],
    ['mailchannels', { apiKey: 'k' }, {}, 'https://api.mailchannels.net/tx/v1/send'],
    ['mailersend', { apiToken: 'k' }, {}, 'https://api.mailersend.com/v1/email'],
    ['scaleway', { secretKey: 'k', projectId: 'p' }, { emails: [{ id: 'sc1' }] }, 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'],
    ['webhook', { url: 'https://hooks.test/out', secret: 's' }, { id: 'w1' }, 'https://hooks.test/out'],
  ])('%s sends to the right endpoint', async (type, cfg, response, url) => {
    const { ctx, calls } = fakeFetch(response);
    await getProviderDef(type as string)!.send!(cfg as any, await sampleEmail(), ctx);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method).toBe('POST');
  });

  it('webhook provider signs the body', async () => {
    const { ctx, calls } = fakeFetch({ id: 'w1' });
    await getProviderDef('webhook')!.send!({ url: 'https://hooks.test/out', secret: 'shh' }, await sampleEmail(), ctx);
    const body = calls[0].init.body as string;
    const expected = `sha256=${crypto.createHmac('sha256', 'shh').update(body).digest('hex')}`;
    expect((calls[0].init.headers as any)['X-Wren-Signature']).toBe(expected);
  });

  it('maps HTTP 4xx to permanent and 5xx to temporary errors', async () => {
    const a = fakeFetch({ message: 'bad key' }, 401);
    await expect(getProviderDef('resend')!.send!({ apiKey: 'k' }, await sampleEmail(), a.ctx)).rejects.toMatchObject({ permanent: true, status: 401 });
    const b = fakeFetch({ message: 'oops' }, 503);
    await expect(getProviderDef('resend')!.send!({ apiKey: 'k' }, await sampleEmail(), b.ctx)).rejects.toMatchObject({ permanent: false, status: 503 });
  });
});

describe('inbound adapters', () => {
  const raw = 'From: Carol <carol@example.org>\r\nTo: bob@acme.test\r\nSubject: Hi\r\nMessage-ID: <m1@example.org>\r\n\r\nHello\r\n';

  it('raw MIME with envelope headers', async () => {
    const r = await getProviderDef('raw')!.receive!({}, inboundReq(raw, 'message/rfc822', { 'x-rcpt-to': 'bob@acme.test, ann@acme.test', 'x-mail-from': 'carol@example.org' }), fakeFetch().ctx);
    expect(r.items![0].rcptTo).toEqual(['bob@acme.test', 'ann@acme.test']);
    expect(r.items![0].mailFrom).toBe('carol@example.org');
    expect(r.items![0].raw.toString()).toContain('Subject: Hi');
  });

  it('Resend verifies the Svix signature and downloads the raw message', async () => {
    const secretBytes = crypto.randomBytes(24);
    const secret = `whsec_${secretBytes.toString('base64')}`;
    const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', to: ['bob@acme.test'] } });
    const id = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', secretBytes).update(`${id}.${ts}.${payload}`).digest('base64');
    const { ctx, calls } = fakeFetch((c: Captured) =>
      c.url.includes('/emails/receiving/') ? { id: 'em_1', from: 'carol@example.org', to: ['bob@acme.test'], raw: { download_url: 'https://dl.test/raw' } } : raw,
    );
    const r = await getProviderDef('resend')!.receive!(
      { apiKey: 'k', webhookSecret: secret },
      inboundReq(payload, 'application/json', { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }),
      ctx,
    );
    expect(calls.map((c) => c.url)).toEqual(['https://api.resend.com/emails/receiving/em_1', 'https://dl.test/raw']);
    expect(r.items![0].raw.toString()).toContain('Subject: Hi');
    await expect(
      getProviderDef('resend')!.receive!({ apiKey: 'k', webhookSecret: secret }, inboundReq(payload, 'application/json', { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,bad' }), ctx),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('Postmark JSON is rebuilt into MIME', async () => {
    const payload = {
      FromFull: { Email: 'carol@example.org', Name: 'Carol' },
      ToFull: [{ Email: 'bob@acme.test', Name: '' }],
      OriginalRecipient: 'bob@acme.test',
      Subject: 'From Postmark',
      MessageID: 'pm-in-1',
      TextBody: 'plain',
      HtmlBody: '<p>html</p>',
      Headers: [{ Name: 'Message-ID', Value: '<orig@example.org>' }, { Name: 'X-Spam-Status', Value: 'No' }],
      Attachments: [{ Name: 'x.txt', Content: Buffer.from('att').toString('base64'), ContentType: 'text/plain' }],
    };
    const r = await getProviderDef('postmark')!.receive!({}, inboundReq(JSON.stringify(payload), 'application/json'), fakeFetch().ctx);
    const text = r.items![0].raw.toString();
    expect(text).toContain('Subject: From Postmark');
    expect(text).toContain('x.txt');
    expect(r.items![0].rcptTo).toEqual(['bob@acme.test']);
    expect(r.items![0].verdicts?.spam).toBe('pass');
  });

  it('SendGrid Inbound Parse with raw MIME', async () => {
    const fd = new FormData();
    fd.set('email', raw);
    fd.set('envelope', JSON.stringify({ to: ['bob@acme.test'], from: 'carol@example.org' }));
    fd.set('SPF', 'pass');
    fd.set('spam_score', '1.2');
    const res = new Response(fd);
    const body = Buffer.from(await res.arrayBuffer());
    const r = await getProviderDef('sendgrid')!.receive!({}, inboundReq(body, res.headers.get('content-type')!), fakeFetch().ctx);
    expect(r.items![0].rcptTo).toEqual(['bob@acme.test']);
    expect(r.items![0].spamScore).toBe(1.2);
    expect(r.items![0].verdicts?.spf).toBe('pass');
  });

  it('Mailgun checks the signing key', async () => {
    const key = 'mg-signing';
    const ts = String(Math.floor(Date.now() / 1000));
    const token = 'tok';
    const fd = new FormData();
    fd.set('body-mime', raw);
    fd.set('recipient', 'bob@acme.test');
    fd.set('sender', 'carol@example.org');
    fd.set('timestamp', ts);
    fd.set('token', token);
    fd.set('signature', crypto.createHmac('sha256', key).update(ts + token).digest('hex'));
    const res = new Response(fd);
    const body = Buffer.from(await res.arrayBuffer());
    const r = await getProviderDef('mailgun')!.receive!({ webhookSigningKey: key }, inboundReq(body, res.headers.get('content-type')!), fakeFetch().ctx);
    expect(r.items![0].rcptTo).toEqual(['bob@acme.test']);
    await expect(getProviderDef('mailgun')!.receive!({ webhookSigningKey: 'other' }, inboundReq(body, res.headers.get('content-type')!), fakeFetch().ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('SES confirms SNS subscriptions and unpacks notifications', async () => {
    const { ctx, calls } = fakeFetch('ok');
    const sub = await getProviderDef('ses')!.receive!(
      {},
      inboundReq(JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x' }), 'text/plain'),
      ctx,
    );
    expect(sub.response?.status).toBe(200);
    expect(calls[0].url).toContain('sns.us-east-1.amazonaws.com');
    await expect(
      getProviderDef('ses')!.receive!({}, inboundReq(JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.test/' }), 'text/plain'), ctx),
    ).rejects.toThrow();
    const message = {
      notificationType: 'Received',
      mail: { source: 'carol@example.org', destination: ['bob@acme.test'] },
      receipt: { recipients: ['bob@acme.test'], spamVerdict: { status: 'PASS' }, spfVerdict: { status: 'PASS' }, action: { type: 'SNS', encoding: 'BASE64' } },
      content: Buffer.from(raw).toString('base64'),
    };
    const n = await getProviderDef('ses')!.receive!({}, inboundReq(JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) }), 'text/plain'), ctx);
    expect(n.items![0].raw.toString()).toContain('Subject: Hi');
    expect(n.items![0].verdicts).toMatchObject({ spf: 'pass', spam: 'pass' });
  });

  it('SparkPost relay webhooks', async () => {
    const payload = [{ msys: { relay_message: { rcpt_to: 'bob@acme.test', msg_from: 'carol@example.org', content: { email_rfc822: raw, email_rfc822_is_base64: false } } } }];
    const r = await getProviderDef('sparkpost')!.receive!({ relayToken: 't' }, inboundReq(JSON.stringify(payload), 'application/json', { 'x-messagesystems-webhook-token': 't' }), fakeFetch().ctx);
    expect(r.items).toHaveLength(1);
  });
});
