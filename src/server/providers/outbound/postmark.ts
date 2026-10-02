import { ProviderError, type ProviderDefinition, type InboundItem } from '../types.js';
import { addrString, envelopeLists, request, requireFields, b64, threadingHeaders } from '../http.js';
import { rebuildMime } from '../inbound/rebuild.js';

interface PostmarkConfig {
  serverToken: string;
  messageStream?: string;
}

export const postmark: ProviderDefinition<PostmarkConfig> = {
  type: 'postmark',
  name: 'Postmark',
  description: 'Fast transactional email with excellent deliverability and inbound processing.',
  website: 'https://postmarkapp.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: false,
  spfInclude: 'spf.mtasv.net',
  fields: [
    { key: 'serverToken', label: 'Server API token', type: 'password', required: true },
    { key: 'messageStream', label: 'Message stream', type: 'text', default: 'outbound', help: 'Usually “outbound”.' },
  ],
  outboundSetup: 'Add and verify a Sender Signature or Domain (DKIM + Return-Path) in Postmark, then copy the server API token.',
  inboundSetup:
    'In your Postmark server, open the Inbound stream → Settings and set the webhook URL to {{url}}. Enable “Include raw email content in JSON payload” for best fidelity. Point your MX to inbound.postmarkapp.com (or forward to the inbound address Postmark gives you).',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['serverToken']);
    const { to, cc, bcc } = envelopeLists(email);
    const headers = Object.entries(threadingHeaders(email)).map(([Name, Value]) => ({ Name, Value }));
    const { data } = await request<{ MessageID: string; ErrorCode: number; Message: string }>(ctx, 'https://api.postmarkapp.com/email', {
      headers: { 'X-Postmark-Server-Token': cfg.serverToken },
      json: {
        From: addrString(email.from),
        To: to.map(addrString).join(', '),
        Cc: cc.length ? cc.map(addrString).join(', ') : undefined,
        Bcc: bcc.length ? bcc.map(addrString).join(', ') : undefined,
        ReplyTo: email.replyTo.length ? email.replyTo.map(addrString).join(', ') : undefined,
        Subject: email.subject,
        HtmlBody: email.html ?? undefined,
        TextBody: email.text ?? undefined,
        Headers: headers,
        MessageStream: cfg.messageStream || 'outbound',
        Attachments: email.attachments.map((a) => ({
          Name: a.filename,
          Content: b64(a.content),
          ContentType: a.contentType,
          ContentID: a.inline && a.contentId ? `cid:${a.contentId}` : undefined,
        })),
      },
    });
    if (data?.ErrorCode) throw new ProviderError(`Postmark ${data.ErrorCode}: ${data.Message}`, true);
    return { providerMessageId: data?.MessageID ?? null };
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['serverToken']);
    const { data } = await request<{ Name: string }>(ctx, 'https://api.postmarkapp.com/server', {
      headers: { 'X-Postmark-Server-Token': cfg.serverToken },
    });
    return `Connected to Postmark server “${data?.Name}”.`;
  },

  async receive(_cfg, req) {
    const p = req.json<any>();
    // Delivery status webhooks (Bounce, Delivery, SpamComplaint) can share this URL.
    if (p?.RecordType === 'Bounce' || p?.RecordType === 'Delivery' || p?.RecordType === 'SpamComplaint') {
      const hard = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked', 'SpamNotification'].includes(p.Type);
      return {
        events: [
          {
            providerMessageId: p.MessageID,
            type: p.RecordType === 'Bounce' ? 'bounced' : p.RecordType === 'Delivery' ? 'delivered' : 'complained',
            recipients: [p.Email ?? p.Recipient].filter(Boolean),
            permanent: p.RecordType === 'Bounce' ? hard : undefined,
            detail: p.RecordType === 'Bounce' ? [p.Type, p.Description].filter(Boolean).join(': ') : p.Details,
          },
        ],
        response: { status: 200, body: { ok: true } },
      };
    }
    const verdicts: Record<string, string> = {};
    const headerList: { Name: string; Value: string }[] = p?.Headers ?? [];
    const spamScoreHeader = headerList.find((h) => h.Name.toLowerCase() === 'x-spam-score')?.Value;
    const spamStatus = headerList.find((h) => h.Name.toLowerCase() === 'x-spam-status')?.Value ?? '';
    if (spamStatus) verdicts.spam = spamStatus.toLowerCase().startsWith('yes') ? 'fail' : 'pass';
    let item: InboundItem;
    const rcpt = [p.OriginalRecipient, ...(p.ToFull ?? []).map((t: any) => t.Email), ...(p.CcFull ?? []).map((t: any) => t.Email)].filter(
      Boolean,
    );
    if (p?.RawEmail) {
      item = { raw: Buffer.from(p.RawEmail, 'utf8') };
    } else {
      const headers: Record<string, string> = {};
      for (const h of headerList) headers[h.Name] = h.Value;
      item = {
        raw: await rebuildMime({
          from: p.FromFull ? { address: p.FromFull.Email, name: p.FromFull.Name } : p.From,
          to: (p.ToFull ?? []).map((t: any) => ({ address: t.Email, name: t.Name })),
          cc: (p.CcFull ?? []).map((t: any) => ({ address: t.Email, name: t.Name })),
          replyTo: p.ReplyTo,
          subject: p.Subject ?? '',
          text: p.TextBody,
          html: p.HtmlBody,
          date: p.Date,
          messageId: p.MessageID,
          headers,
          attachments: (p.Attachments ?? []).map((a: any) => ({
            filename: a.Name,
            contentType: a.ContentType,
            content: Buffer.from(a.Content ?? '', 'base64'),
            contentId: a.ContentID ? String(a.ContentID).replace(/^cid:/, '') : null,
          })),
        }),
      };
    }
    item.rcptTo = p.OriginalRecipient ? [p.OriginalRecipient] : rcpt;
    item.mailFrom = p.FromFull?.Email ?? p.From;
    item.verdicts = verdicts;
    if (spamScoreHeader && !Number.isNaN(Number(spamScoreHeader))) item.spamScore = Number(spamScoreHeader);
    return { items: [item] };
  },
};
