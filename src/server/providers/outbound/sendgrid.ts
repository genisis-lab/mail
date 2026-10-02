import type { ProviderDefinition } from '../types.js';
import { b64, envelopeLists, request, requireFields, threadingHeaders } from '../http.js';
import { rebuildMime } from '../inbound/rebuild.js';
import type { Addr } from '../../../shared/types.js';

interface SendgridConfig {
  apiKey: string;
  region?: 'global' | 'eu';
  eventWebhookKey?: string;
}

const RESERVED = new Set(['x-sg-id', 'x-sg-eid', 'received', 'dkim-signature', 'content-type', 'content-transfer-encoding', 'to', 'from', 'subject', 'reply-to', 'cc', 'bcc']);
const toSg = (a: Addr) => (a.name ? { email: a.address, name: a.name } : { email: a.address });

function parseHeaderBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export const sendgrid: ProviderDefinition<SendgridConfig> = {
  type: 'sendgrid',
  name: 'SendGrid (Twilio)',
  description: 'Twilio SendGrid Mail Send v3 API and Inbound Parse webhooks.',
  website: 'https://sendgrid.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: false,
  spfInclude: 'sendgrid.net',
  dkimSelectors: ['s1', 's2'],
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'SG.…' },
    {
      key: 'region',
      label: 'Data residency',
      type: 'select',
      default: 'global',
      options: [
        { value: 'global', label: 'Global (api.sendgrid.com)' },
        { value: 'eu', label: 'EU (api.eu.sendgrid.com)' },
      ],
    },
    {
      key: 'eventWebhookKey',
      label: 'Event webhook verification key',
      type: 'password',
      help: 'Optional: the public key from Event Webhook → Signature Verification, so Wren checks delivery events really come from SendGrid.',
    },
  ],
  outboundSetup: 'Complete Domain Authentication in SendGrid (Settings → Sender Authentication) and create an API key with Mail Send permission.',
  inboundSetup:
    'In SendGrid go to Settings → Inbound Parse → Add Host & URL. Use your receiving (sub)domain, set the destination URL to {{url}} and tick “POST the raw, full MIME message”. Point the domain’s MX to mx.sendgrid.net.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sendgrid.com' : 'https://api.sendgrid.com';
    const { to, cc, bcc } = envelopeLists(email);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(threadingHeaders(email))) if (!RESERVED.has(k.toLowerCase())) headers[k] = v;
    const content = [] as { type: string; value: string }[];
    if (email.text) content.push({ type: 'text/plain', value: email.text });
    if (email.html) content.push({ type: 'text/html', value: email.html });
    if (!content.length) content.push({ type: 'text/plain', value: ' ' });
    const { res } = await request(ctx, `${base}/v3/mail/send`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      json: {
        personalizations: [
          { to: to.map(toSg), cc: cc.length ? cc.map(toSg) : undefined, bcc: bcc.length ? bcc.map(toSg) : undefined },
        ],
        from: toSg(email.from),
        reply_to_list: email.replyTo.length ? email.replyTo.map(toSg) : undefined,
        subject: email.subject,
        content,
        headers,
        attachments: email.attachments.length
          ? email.attachments.map((a) => ({
              content: b64(a.content),
              filename: a.filename,
              type: a.contentType,
              disposition: a.inline ? 'inline' : 'attachment',
              content_id: a.inline ? a.contentId ?? undefined : undefined,
            }))
          : undefined,
      },
    });
    return { providerMessageId: res.headers.get('x-message-id') };
  },

  async sendingDomains(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sendgrid.com' : 'https://api.sendgrid.com';
    const { data } = await request<{ domain: string; subdomain?: string; valid: boolean }[]>(ctx, `${base}/v3/whitelabel/domains?limit=100`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    return (Array.isArray(data) ? data : []).map((d) => ({ name: d.domain.toLowerCase(), verified: !!d.valid }));
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sendgrid.com' : 'https://api.sendgrid.com';
    const { data } = await request<{ scopes: string[] }>(ctx, `${base}/v3/scopes`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    const canSend = data?.scopes?.includes('mail.send');
    return canSend ? 'API key valid with mail.send scope.' : 'API key valid, but it is missing the mail.send scope.';
  },

  async receive(_cfg, req) {
    const form = await req.form();
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : '';
    };
    let envelope: { to?: string[]; from?: string } = {};
    try {
      envelope = JSON.parse(str('envelope') || '{}');
    } catch {
      /* ignore */
    }
    const verdicts: Record<string, string> = {};
    const spf = str('SPF');
    if (spf) verdicts.spf = spf.toLowerCase();
    const spamScore = Number(str('spam_score'));

    const rawField = form.get('email');
    let raw: Buffer;
    if (rawField != null) {
      raw = typeof rawField === 'string' ? Buffer.from(rawField, 'utf8') : Buffer.from(await rawField.arrayBuffer());
    } else {
      const headers = parseHeaderBlock(str('headers'));
      let info: Record<string, { filename: string; type: string; 'content-id'?: string }> = {};
      try {
        info = JSON.parse(str('attachment-info') || '{}');
      } catch {
        /* ignore */
      }
      const attachments = [];
      for (const [key, meta] of Object.entries(info)) {
        const f = form.get(key);
        if (f && typeof f !== 'string') {
          attachments.push({
            filename: meta.filename || (f as File).name || key,
            contentType: meta.type || (f as File).type || 'application/octet-stream',
            content: Buffer.from(await (f as File).arrayBuffer()),
            contentId: meta['content-id'] ?? null,
          });
        }
      }
      raw = await rebuildMime({
        from: str('from'),
        to: str('to'),
        cc: str('cc'),
        subject: str('subject'),
        text: str('text') || null,
        html: str('html') || null,
        headers,
        attachments,
      });
    }
    return {
      items: [
        {
          raw,
          rcptTo: envelope.to,
          mailFrom: envelope.from,
          verdicts,
          spamScore: Number.isFinite(spamScore) && str('spam_score') !== '' ? spamScore : undefined,
        },
      ],
    };
  },
};
