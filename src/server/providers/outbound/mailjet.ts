import { ProviderError, type ProviderDefinition } from '../types.js';
import { b64, basicAuth, envelopeLists, request, requireFields, threadingHeaders } from '../http.js';
import { rebuildMime } from '../inbound/rebuild.js';
import type { Addr } from '../../../shared/types.js';

interface MailjetConfig {
  apiKey: string;
  secretKey: string;
}

const toMj = (a: Addr) => (a.name ? { Email: a.address, Name: a.name } : { Email: a.address });

export const mailjet: ProviderDefinition<MailjetConfig> = {
  type: 'mailjet',
  name: 'Mailjet',
  description: 'Mailjet Send API v3.1 and Parse API for inbound.',
  website: 'https://www.mailjet.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: false,
  spfInclude: 'spf.mailjet.com',
  dkimSelectors: ['mailjet'],
  fields: [
    { key: 'apiKey', label: 'API key', type: 'text', required: true },
    { key: 'secretKey', label: 'Secret key', type: 'password', required: true },
  ],
  outboundSetup: 'Validate your domain and sender in Mailjet (SPF + DKIM), then copy the API key and secret key.',
  inboundSetup:
    'Create a Parse API route (POST /v3/REST/parseroute) with Url {{url}} and either a Mailjet-provided parse address or your own domain with MX → parse.mailjet.com.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey', 'secretKey']);
    const { to, cc, bcc } = envelopeLists(email);
    const { data } = await request<any>(ctx, 'https://api.mailjet.com/v3.1/send', {
      headers: { Authorization: basicAuth(cfg.apiKey, cfg.secretKey) },
      json: {
        Messages: [
          {
            From: toMj(email.from),
            To: to.map(toMj),
            Cc: cc.length ? cc.map(toMj) : undefined,
            Bcc: bcc.length ? bcc.map(toMj) : undefined,
            ReplyTo: email.replyTo[0] ? toMj(email.replyTo[0]) : undefined,
            Subject: email.subject,
            TextPart: email.text ?? undefined,
            HTMLPart: email.html ?? undefined,
            Headers: threadingHeaders(email),
            Attachments: email.attachments
              .filter((a) => !a.inline)
              .map((a) => ({ ContentType: a.contentType, Filename: a.filename, Base64Content: b64(a.content) })),
            InlinedAttachments: email.attachments
              .filter((a) => a.inline && a.contentId)
              .map((a) => ({ ContentType: a.contentType, Filename: a.filename, ContentID: a.contentId, Base64Content: b64(a.content) })),
          },
        ],
      },
    });
    const msg = data?.Messages?.[0];
    if (msg?.Status !== 'success') {
      throw new ProviderError(msg?.Errors?.map((e: any) => e.ErrorMessage).join('; ') || 'Mailjet rejected the message', true);
    }
    return { providerMessageId: String(msg.To?.[0]?.MessageID ?? msg.To?.[0]?.MessageUUID ?? '') || null };
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey', 'secretKey']);
    const { data } = await request<any>(ctx, 'https://api.mailjet.com/v3/REST/sender?Limit=10', {
      headers: { Authorization: basicAuth(cfg.apiKey, cfg.secretKey) },
    });
    return `Credentials valid. ${data?.Count ?? 0} sender(s) configured.`;
  },

  async receive(_cfg, req) {
    const p = req.json<any>();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p?.Headers ?? {})) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    const attachments = [];
    for (const part of p?.Parts ?? []) {
      const ref = part?.ContentRef;
      if (!ref || !/^Attachment\d+$/.test(ref) || typeof p[ref] !== 'string') continue;
      const h = part.Headers ?? {};
      const ct = String(h['Content-Type'] ?? 'application/octet-stream').split(';')[0];
      const fn = /filename="?([^";]+)"?/i.exec(String(h['Content-Disposition'] ?? h['Content-Type'] ?? ''))?.[1] ?? ref;
      attachments.push({ filename: fn, contentType: ct, content: Buffer.from(p[ref], 'base64') });
    }
    const raw = await rebuildMime({
      from: p.From ?? p.Sender,
      to: headers['To'] ?? p.Recipient,
      cc: headers['Cc'],
      subject: p.Subject ?? '',
      text: p['Text-part'] ?? null,
      html: p['Html-part'] ?? null,
      date: p.Date,
      headers,
      attachments,
    });
    const score = Number(p.SpamAssassinScore);
    return { items: [{ raw, rcptTo: p.Recipient ? [p.Recipient] : undefined, mailFrom: p.Sender, spamScore: Number.isFinite(score) ? score : undefined }] };
  },
};
