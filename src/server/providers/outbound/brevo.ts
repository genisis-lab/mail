import type { ProviderDefinition, InboundItem } from '../types.js';
import { b64, envelopeLists, request, requireFields, threadingHeaders } from '../http.js';
import { rebuildMime } from '../inbound/rebuild.js';
import type { Addr } from '../../../shared/types.js';

interface BrevoConfig {
  apiKey: string;
}

const toBrevo = (a: Addr) => (a.name ? { email: a.address, name: a.name } : { email: a.address });

export const brevo: ProviderDefinition<BrevoConfig> = {
  type: 'brevo',
  name: 'Brevo (Sendinblue)',
  description: 'Brevo transactional email API and inbound parsing webhooks.',
  website: 'https://www.brevo.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: false,
  spfInclude: 'spf.brevo.com',
  dkimSelectors: ['brevo1', 'brevo2', 'mail'],
  fields: [{ key: 'apiKey', label: 'API key (v3)', type: 'password', required: true, placeholder: 'xkeysib-…' }],
  outboundSetup: 'Authenticate your domain in Brevo (Senders, Domains & Dedicated IPs → Domains) and create an API key.',
  inboundSetup:
    'Set up an inbound domain in Brevo (MX → inbound1.brevo.com / inbound2.brevo.com), then create a webhook of type “inbound” targeting {{url}}. Attachments are downloaded with the API key.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const { to, cc, bcc } = envelopeLists(email);
    const { data } = await request<{ messageId: string }>(ctx, 'https://api.brevo.com/v3/smtp/email', {
      headers: { 'api-key': cfg.apiKey },
      json: {
        sender: toBrevo(email.from),
        to: to.map(toBrevo),
        cc: cc.length ? cc.map(toBrevo) : undefined,
        bcc: bcc.length ? bcc.map(toBrevo) : undefined,
        replyTo: email.replyTo[0] ? toBrevo(email.replyTo[0]) : undefined,
        subject: email.subject,
        htmlContent: email.html ?? undefined,
        textContent: email.text ?? undefined,
        headers: threadingHeaders(email),
        attachment: email.attachments.length ? email.attachments.map((a) => ({ name: a.filename, content: b64(a.content) })) : undefined,
      },
    });
    return { providerMessageId: data?.messageId ? String(data.messageId).replace(/[<>]/g, '') : null };
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const { data } = await request<any>(ctx, 'https://api.brevo.com/v3/account', { headers: { 'api-key': cfg.apiKey } });
    return `Connected to Brevo account ${data?.email ?? ''}.`.trim();
  },

  async receive(cfg, req, ctx) {
    const body = req.json<{ items: any[] }>();
    const items: InboundItem[] = [];
    for (const it of body?.items ?? []) {
      const attachments = [];
      for (const a of it.Attachments ?? []) {
        if (!cfg.apiKey || !a.DownloadToken) continue;
        try {
          const res = await ctx.fetch(`https://api.brevo.com/v3/inbound/attachments/${encodeURIComponent(a.DownloadToken)}`, {
            headers: { 'api-key': cfg.apiKey },
            signal: AbortSignal.timeout(60_000),
          });
          if (res.ok) {
            attachments.push({
              filename: a.Name,
              contentType: a.ContentType || 'application/octet-stream',
              content: Buffer.from(await res.arrayBuffer()),
              contentId: a.ContentID ?? null,
            });
          }
        } catch {
          /* skip attachment on failure */
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(it.Headers ?? {})) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      const raw = await rebuildMime({
        from: it.From ? { address: it.From.Address, name: it.From.Name } : null,
        to: (it.To ?? []).map((t: any) => ({ address: t.Address, name: t.Name })),
        cc: (it.Cc ?? []).map((t: any) => ({ address: t.Address, name: t.Name })),
        replyTo: it.ReplyTo?.Address,
        subject: it.Subject ?? '',
        text: it.RawTextBody ?? null,
        html: it.RawHtmlBody ?? null,
        date: it.SentAtDate,
        messageId: it.MessageId,
        inReplyTo: it.InReplyTo,
        headers,
        attachments,
      });
      items.push({
        raw,
        rcptTo: (it.Recipients ?? (it.To ?? []).map((t: any) => t.Address)) as string[],
        mailFrom: it.From?.Address,
        spamScore: typeof it.SpamScore === 'number' ? it.SpamScore : undefined,
      });
    }
    return { items };
  },
};
