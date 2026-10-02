import crypto from 'node:crypto';
import { ProviderError, type ProviderDefinition } from '../types.js';
import { addrString, b64, envelopeLists, request, requireFields, threadingHeaders } from '../http.js';

interface ResendConfig {
  apiKey: string;
  webhookSecret?: string;
}

const API = 'https://api.resend.com';

/** Verify a Standard Webhooks / Svix signature. */
export function verifyStandardWebhook(secret: string, headers: Headers, body: Buffer, toleranceSec = 300): boolean {
  const id = headers.get('svix-id') ?? headers.get('webhook-id');
  const ts = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp');
  const sigHeader = headers.get('svix-signature') ?? headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64');
  return sigHeader.split(' ').some((part) => {
    const [, sig] = part.split(',');
    return !!sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
}

const RESEND_EVENTS: Record<string, 'delivered' | 'bounced' | 'complained' | 'delayed'> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
};

export const resend: ProviderDefinition<ResendConfig> = {
  type: 'resend',
  name: 'Resend',
  description: 'Developer-first email API. Supports sending and inbound (email.received webhooks).',
  website: 'https://resend.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: false,
  spfInclude: 'amazonses.com',
  dkimSelectors: ['resend'],
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 're_…' },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      type: 'password',
      placeholder: 'whsec_…',
      help: 'Optional but recommended: verifies inbound webhooks.',
      inbound: true,
    },
  ],
  outboundSetup: 'Verify your domain in the Resend dashboard (Domains), then paste a sending API key.',
  inboundSetup:
    'In Resend, enable receiving on your domain and add the MX record it shows. Then go to Webhooks → Add endpoint, paste {{url}} and select the email.received event. Also select email.delivered, email.bounced, email.complained and email.delivery_delayed to see delivery status in Wren’s logs. Copy the signing secret into this provider. The API key needs permission to read received emails.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const { to, cc, bcc } = envelopeLists(email);
    const { data } = await request<{ id: string }>(ctx, `${API}/emails`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Idempotency-Key': email.messageId.slice(0, 256) },
      json: {
        from: addrString(email.from),
        to: to.map(addrString),
        cc: cc.length ? cc.map(addrString) : undefined,
        bcc: bcc.length ? bcc.map(addrString) : undefined,
        reply_to: email.replyTo.length ? email.replyTo.map(addrString) : undefined,
        subject: email.subject,
        html: email.html ?? undefined,
        text: email.text ?? undefined,
        headers: threadingHeaders(email),
        attachments: email.attachments.length
          ? email.attachments.map((a) => ({
              filename: a.filename,
              content: b64(a.content),
              content_type: a.contentType,
              content_id: a.inline ? a.contentId ?? undefined : undefined,
            }))
          : undefined,
      },
    });
    return { providerMessageId: data?.id ?? null };
  },

  async sendingDomains(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const { data } = await request<{ data: { name: string; status: string }[] }>(ctx, `${API}/domains`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    return (data?.data ?? []).map((d) => ({ name: d.name.toLowerCase(), verified: d.status === 'verified' }));
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const { data } = await request<{ data: { name: string; status: string }[] }>(ctx, `${API}/domains`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    const list = (data?.data ?? []).map((d) => `${d.name} (${d.status})`).join(', ');
    return list ? `API key valid. Domains: ${list}` : 'API key valid. No domains configured yet.';
  },

  async receive(cfg, req, ctx) {
    if (cfg.webhookSecret && !verifyStandardWebhook(cfg.webhookSecret, req.headers, req.body)) {
      throw new ProviderError('Invalid webhook signature', true, 401);
    }
    const event = req.json<{ type: string; data: { email_id: string; to?: string[]; from?: string; bounce?: { message?: string; type?: string; subType?: string } } }>();
    // Delivery status for mail Wren sent (add these events to the same Resend webhook).
    const status = RESEND_EVENTS[event?.type ?? ''];
    if (status) {
      const bounce = event.data?.bounce;
      return {
        events: [
          {
            providerMessageId: event.data?.email_id,
            type: status,
            recipients: event.data?.to ?? [],
            // Resend reports SES-style bounce types; only "Permanent" means the address can't receive mail.
            permanent: status === 'bounced' ? (bounce?.type ?? 'Permanent').toLowerCase() === 'permanent' : undefined,
            detail: [bounce?.subType, bounce?.message].filter(Boolean).join(': '),
          },
        ],
        response: { status: 200, body: { ok: true } },
      };
    }
    if (event?.type !== 'email.received') return { response: { status: 200, body: { ignored: event?.type ?? 'unknown' } } };
    requireFields(cfg, ['apiKey']);
    const auth = { Authorization: `Bearer ${cfg.apiKey}` };
    const { data: email } = await request<any>(ctx, `${API}/emails/receiving/${encodeURIComponent(event.data.email_id)}`, { headers: auth });
    const rawUrl: string | undefined = email?.raw?.download_url;
    if (!rawUrl) throw new ProviderError('Resend did not return a raw download URL for this email');
    const res = await ctx.fetch(rawUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ProviderError(`Failed to download raw email (HTTP ${res.status})`);
    const raw = Buffer.from(await res.arrayBuffer());
    const rcptTo: string[] = email.received_for?.length ? email.received_for : event.data.to ?? email.to ?? [];
    return { items: [{ raw, rcptTo, mailFrom: email.from }] };
  },
};
