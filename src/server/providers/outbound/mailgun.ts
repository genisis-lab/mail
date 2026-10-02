import crypto from 'node:crypto';
import { ProviderError, type ProviderDefinition } from '../types.js';
import { basicAuth, request, requireFields } from '../http.js';
import { rebuildMime } from '../inbound/rebuild.js';

interface MailgunConfig {
  apiKey: string;
  domain: string;
  region?: 'us' | 'eu';
  webhookSigningKey?: string;
}

export const mailgun: ProviderDefinition<MailgunConfig> = {
  type: 'mailgun',
  name: 'Mailgun',
  description: 'Mailgun Messages API (raw MIME) and inbound Routes.',
  website: 'https://www.mailgun.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: true,
  spfInclude: 'mailgun.org',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true },
    { key: 'domain', label: 'Sending domain', type: 'text', required: true, placeholder: 'mg.example.com', help: 'The domain as configured in Mailgun.' },
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      default: 'us',
      options: [
        { value: 'us', label: 'US (api.mailgun.net)' },
        { value: 'eu', label: 'EU (api.eu.mailgun.net)' },
      ],
    },
    {
      key: 'webhookSigningKey',
      label: 'HTTP webhook signing key',
      type: 'password',
      inbound: true,
      help: 'Verifies that inbound route posts really come from Mailgun.',
    },
  ],
  outboundSetup: 'Add and verify your domain in Mailgun (SPF, DKIM, MX for tracking), then copy a sending/private API key.',
  inboundSetup:
    'In Mailgun go to Send → Receiving → Create route. Match recipient (e.g. .*@example.com) and add the action forward("{{url}}/mime") so Mailgun posts the full MIME. Point your MX to mxa.mailgun.org / mxb.mailgun.org (EU: mxa.eu.mailgun.org).',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey', 'domain']);
    const base = cfg.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    const form = new FormData();
    for (const r of email.envelope.to) form.append('to', r);
    form.append('message', new Blob([new Uint8Array(email.raw)], { type: 'message/rfc822' }), 'message.mime');
    const { data } = await request<{ id: string; message: string }>(ctx, `${base}/v3/${encodeURIComponent(cfg.domain)}/messages.mime`, {
      headers: { Authorization: basicAuth('api', cfg.apiKey) },
      body: form,
      timeoutMs: 60_000,
    });
    return { providerMessageId: data?.id ? String(data.id).replace(/[<>]/g, '') : null, detail: data?.message };
  },

  async sendingDomains(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    const { data } = await request<{ items: { name: string; state: string }[] }>(ctx, `${base}/v4/domains?limit=100`, { headers: { Authorization: basicAuth('api', cfg.apiKey) } });
    return (data?.items ?? []).map((d) => ({ name: d.name.toLowerCase(), verified: d.state === 'active' }));
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey', 'domain']);
    const base = cfg.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    const { data } = await request<any>(ctx, `${base}/v4/domains/${encodeURIComponent(cfg.domain)}`, {
      headers: { Authorization: basicAuth('api', cfg.apiKey) },
    });
    return `Domain ${data?.domain?.name ?? cfg.domain} is ${data?.domain?.state ?? 'reachable'}.`;
  },

  async receive(cfg, req) {
    const form = await req.form();
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : '';
    };
    if (cfg.webhookSigningKey) {
      const ts = str('timestamp');
      const token = str('token');
      const sig = str('signature');
      const expected = crypto.createHmac('sha256', cfg.webhookSigningKey).update(ts + token).digest('hex');
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 15 * 60;
      if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw new ProviderError('Invalid Mailgun signature', true, 401);
      }
    }
    const rcptTo = str('recipient').split(',').map((s) => s.trim()).filter(Boolean);
    const mailFrom = str('sender');
    const bodyMime = form.get('body-mime');
    let raw: Buffer;
    if (bodyMime != null) {
      raw = typeof bodyMime === 'string' ? Buffer.from(bodyMime, 'utf8') : Buffer.from(await bodyMime.arrayBuffer());
    } else {
      let headerPairs: [string, string][] = [];
      try {
        headerPairs = JSON.parse(str('message-headers') || '[]');
      } catch {
        /* ignore */
      }
      const headers = Object.fromEntries(headerPairs);
      const count = Number(str('attachment-count') || 0);
      const attachments = [];
      for (let i = 1; i <= count; i++) {
        const f = form.get(`attachment-${i}`);
        if (f && typeof f !== 'string') {
          attachments.push({ filename: (f as File).name, contentType: (f as File).type || 'application/octet-stream', content: Buffer.from(await (f as File).arrayBuffer()) });
        }
      }
      raw = await rebuildMime({
        from: str('from'),
        to: headers['To'] ?? str('To'),
        cc: headers['Cc'],
        subject: str('subject'),
        text: str('body-plain') || null,
        html: str('body-html') || null,
        headers,
        attachments,
      });
    }
    return { items: [{ raw, rcptTo, mailFrom, spamScore: str('X-Mailgun-Sscore') ? Number(str('X-Mailgun-Sscore')) : undefined }] };
  },
};
