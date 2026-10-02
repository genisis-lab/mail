// Additional JSON-API providers: MailerSend, MailChannels, SMTP2GO, ZeptoMail,
// Elastic Email, Mailtrap and Scaleway Transactional Email.
import { ProviderError, type ProviderDefinition } from '../types.js';
import { addrString, b64, envelopeLists, request, requireFields, threadingHeaders } from '../http.js';
import type { Addr } from '../../../shared/types.js';

const toEmailName = (a: Addr) => (a.name ? { email: a.address, name: a.name } : { email: a.address });

// ── MailerSend ──────────────────────────────────────────────────────────────
export const mailersend: ProviderDefinition<{ apiToken: string; customHeaders?: boolean; webhookSecret?: string }> = {
  type: 'mailersend',
  name: 'MailerSend',
  description: 'MailerSend email API.',
  website: 'https://www.mailersend.com',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: '_spf.mailersend.net',
  dkimSelectors: ['mlsend', 'mlsend2'],
  fields: [
    { key: 'apiToken', label: 'API token', type: 'password', required: true },
    { key: 'customHeaders', label: 'Send custom headers (paid plans)', type: 'boolean', default: false },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', help: 'Optional: verifies delivery events from MailerSend webhooks.' },
  ],
  outboundSetup: 'Add and verify your domain in MailerSend, then create an API token with Email: full access.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiToken']);
    const { to, cc, bcc } = envelopeLists(email);
    const { res } = await request(ctx, 'https://api.mailersend.com/v1/email', {
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
      json: {
        from: toEmailName(email.from),
        to: to.map(toEmailName),
        cc: cc.length ? cc.map(toEmailName) : undefined,
        bcc: bcc.length ? bcc.map(toEmailName) : undefined,
        reply_to: email.replyTo[0] ? toEmailName(email.replyTo[0]) : undefined,
        subject: email.subject,
        text: email.text ?? undefined,
        html: email.html ?? undefined,
        in_reply_to: email.headers['In-Reply-To']?.replace(/[<>]/g, '') || undefined,
        headers: cfg.customHeaders
          ? Object.entries(threadingHeaders(email)).map(([name, value]) => ({ name, value }))
          : undefined,
        attachments: email.attachments.length
          ? email.attachments.map((a) => ({
              content: b64(a.content),
              filename: a.filename,
              disposition: a.inline ? 'inline' : 'attachment',
              id: a.inline ? a.contentId ?? undefined : undefined,
            }))
          : undefined,
      },
    });
    return { providerMessageId: res.headers.get('x-message-id') };
  },

  async sendingDomains(cfg, ctx) {
    requireFields(cfg, ['apiToken']);
    const { data } = await request<{ data: { name: string; is_verified: boolean }[] }>(ctx, 'https://api.mailersend.com/v1/domains?limit=100', { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
    return (data?.data ?? []).map((d) => ({ name: d.name.toLowerCase(), verified: !!d.is_verified }));
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiToken']);
    const { data } = await request<any>(ctx, 'https://api.mailersend.com/v1/domains', { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
    return `Token valid. Domains: ${(data?.data ?? []).map((d: any) => d.name).join(', ') || 'none'}.`;
  },
};

// ── MailChannels ────────────────────────────────────────────────────────────
export const mailchannels: ProviderDefinition<{ apiKey: string; dkimDomain?: string; dkimSelector?: string; dkimPrivateKey?: string }> = {
  type: 'mailchannels',
  name: 'MailChannels',
  description: 'MailChannels Email API, popular for Cloudflare Workers and shared hosting.',
  website: 'https://www.mailchannels.com',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: 'relay.mailchannels.net',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true },
    { key: 'dkimDomain', label: 'DKIM domain', type: 'text', help: 'Optional: sign with your own DKIM key.' },
    { key: 'dkimSelector', label: 'DKIM selector', type: 'text' },
    { key: 'dkimPrivateKey', label: 'DKIM private key (base64)', type: 'textarea' },
  ],
  outboundSetup: 'Create an API key in the MailChannels console and add the _mailchannels TXT “Domain Lockdown” record for your domain.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const { to, cc, bcc } = envelopeLists(email);
    const content = [] as { type: string; value: string }[];
    if (email.text) content.push({ type: 'text/plain', value: email.text });
    if (email.html) content.push({ type: 'text/html', value: email.html });
    const { data } = await request<any>(ctx, 'https://api.mailchannels.net/tx/v1/send', {
      headers: { 'X-Api-Key': cfg.apiKey },
      json: {
        personalizations: [
          {
            to: to.map(toEmailName),
            cc: cc.length ? cc.map(toEmailName) : undefined,
            bcc: bcc.length ? bcc.map(toEmailName) : undefined,
            ...(cfg.dkimDomain && cfg.dkimSelector && cfg.dkimPrivateKey
              ? { dkim_domain: cfg.dkimDomain, dkim_selector: cfg.dkimSelector, dkim_private_key: cfg.dkimPrivateKey }
              : {}),
          },
        ],
        from: toEmailName(email.from),
        reply_to: email.replyTo[0] ? toEmailName(email.replyTo[0]) : undefined,
        subject: email.subject,
        content: content.length ? content : [{ type: 'text/plain', value: ' ' }],
        headers: threadingHeaders(email),
        attachments: email.attachments.length
          ? email.attachments.map((a) => ({ content: b64(a.content), filename: a.filename, type: a.contentType }))
          : undefined,
      },
    });
    return { providerMessageId: data?.results?.[0]?.message_id ?? null };
  },
};

// ── SMTP2GO ─────────────────────────────────────────────────────────────────
export const smtp2go: ProviderDefinition<{ apiKey: string; region?: 'global' | 'eu' | 'au' | 'us' }> = {
  type: 'smtp2go',
  name: 'SMTP2GO',
  description: 'SMTP2GO HTTP API with raw MIME.',
  website: 'https://www.smtp2go.com',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: true,
  spfInclude: 'spf.smtp2go.com',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'api-…' },
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      default: 'global',
      options: [
        { value: 'global', label: 'Global (api.smtp2go.com)' },
        { value: 'us', label: 'US (us-api.smtp2go.com)' },
        { value: 'eu', label: 'EU (eu-api.smtp2go.com)' },
        { value: 'au', label: 'AU (au-api.smtp2go.com)' },
      ],
    },
  ],
  outboundSetup: 'Verify your sender domain in SMTP2GO and create an API key with the “Emails” permission.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const host = cfg.region && cfg.region !== 'global' ? `${cfg.region}-api.smtp2go.com` : 'api.smtp2go.com';
    const { data } = await request<any>(ctx, `https://${host}/v3/email/send`, {
      headers: { 'X-Smtp2go-Api-Key': cfg.apiKey },
      json: { sender: email.envelope.from, to: email.envelope.to, mime_email: email.raw.toString('utf8') },
      timeoutMs: 60_000,
    });
    const d = data?.data ?? {};
    if (d.failed && !d.succeeded) throw new ProviderError(`SMTP2GO: ${(d.failures ?? []).join('; ') || 'rejected'}`, true);
    return { providerMessageId: d.email_id ?? null };
  },
};

// ── ZeptoMail (Zoho) ────────────────────────────────────────────────────────
const zeptoHosts: Record<string, string> = {
  com: 'api.zeptomail.com',
  eu: 'api.zeptomail.eu',
  in: 'api.zeptomail.in',
  au: 'api.zeptomail.com.au',
  jp: 'api.zeptomail.jp',
  ca: 'api.zeptomail.ca',
  sa: 'api.zeptomail.sa',
  cn: 'api.zeptomail.com.cn',
};
export const zeptomail: ProviderDefinition<{ token: string; region?: string }> = {
  type: 'zeptomail',
  name: 'ZeptoMail (Zoho)',
  description: 'Zoho ZeptoMail transactional email API.',
  website: 'https://www.zoho.com/zeptomail/',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: 'zeptomail.net',
  fields: [
    { key: 'token', label: 'Send Mail token', type: 'password', required: true, help: 'Paste the token with or without the “Zoho-enczapikey” prefix.' },
    {
      key: 'region',
      label: 'Data center',
      type: 'select',
      default: 'com',
      options: Object.entries(zeptoHosts).map(([value, host]) => ({ value, label: host })),
    },
  ],
  outboundSetup: 'Add and verify your domain in ZeptoMail (SPF/DKIM), then copy the Send Mail token from your Mail Agent.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['token']);
    const host = zeptoHosts[cfg.region ?? 'com'] ?? zeptoHosts.com;
    const token = cfg.token.startsWith('Zoho-enczapikey') ? cfg.token : `Zoho-enczapikey ${cfg.token}`;
    const { to, cc, bcc } = envelopeLists(email);
    const wrap = (a: Addr) => ({ email_address: { address: a.address, name: a.name || undefined } });
    const { data } = await request<any>(ctx, `https://${host}/v1.1/email`, {
      headers: { Authorization: token },
      json: {
        from: { address: email.from.address, name: email.from.name || undefined },
        to: to.map(wrap),
        cc: cc.length ? cc.map(wrap) : undefined,
        bcc: bcc.length ? bcc.map(wrap) : undefined,
        reply_to: email.replyTo.length ? email.replyTo.map((a) => ({ address: a.address, name: a.name || undefined })) : undefined,
        subject: email.subject,
        htmlbody: email.html ?? undefined,
        textbody: email.text ?? undefined,
        mime_headers: threadingHeaders(email),
        attachments: email.attachments.filter((a) => !a.inline).map((a) => ({ content: b64(a.content), mime_type: a.contentType, name: a.filename })),
        inline_images: email.attachments
          .filter((a) => a.inline && a.contentId)
          .map((a) => ({ content: b64(a.content), mime_type: a.contentType, cid: a.contentId })),
      },
    });
    return { providerMessageId: data?.request_id ?? null };
  },
};

// ── Elastic Email ───────────────────────────────────────────────────────────
export const elasticemail: ProviderDefinition<{ apiKey: string }> = {
  type: 'elasticemail',
  name: 'Elastic Email',
  description: 'Elastic Email v4 transactional API.',
  website: 'https://elasticemail.com',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: '_spf.elasticemail.com',
  fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true }],
  outboundSetup: 'Verify your domain in Elastic Email (SPF, DKIM, tracking) and create an API key with “Send Email” access.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const { to, cc, bcc } = envelopeLists(email);
    const body: { ContentType: string; Content: string; Charset: string }[] = [];
    if (email.html) body.push({ ContentType: 'HTML', Content: email.html, Charset: 'utf-8' });
    if (email.text) body.push({ ContentType: 'PlainText', Content: email.text, Charset: 'utf-8' });
    const { data } = await request<any>(ctx, 'https://api.elasticemail.com/v4/emails/transactional', {
      headers: { 'X-ElasticEmail-ApiKey': cfg.apiKey },
      json: {
        Recipients: { To: to.map(addrString), CC: cc.map(addrString), BCC: bcc.map(addrString) },
        Content: {
          From: addrString(email.from),
          ReplyTo: email.replyTo[0] ? addrString(email.replyTo[0]) : undefined,
          Subject: email.subject,
          Body: body,
          Headers: threadingHeaders(email),
          Attachments: email.attachments.map((a) => ({ BinaryContent: b64(a.content), Name: a.filename, ContentType: a.contentType })),
        },
      },
    });
    return { providerMessageId: data?.MessageID ?? data?.TransactionID ?? null };
  },
};

// ── Mailtrap ────────────────────────────────────────────────────────────────
export const mailtrap: ProviderDefinition<{ apiToken: string; stream?: 'transactional' | 'bulk' }> = {
  type: 'mailtrap',
  name: 'Mailtrap',
  description: 'Mailtrap Email Sending API (transactional or bulk stream).',
  website: 'https://mailtrap.io',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: '_spf.smtp.mailtrap.live',
  fields: [
    { key: 'apiToken', label: 'API token', type: 'password', required: true },
    {
      key: 'stream',
      label: 'Stream',
      type: 'select',
      default: 'transactional',
      options: [
        { value: 'transactional', label: 'Transactional (send.api.mailtrap.io)' },
        { value: 'bulk', label: 'Bulk (bulk.api.mailtrap.io)' },
      ],
    },
  ],
  outboundSetup: 'Verify your sending domain in Mailtrap and create an API token for it.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiToken']);
    const host = cfg.stream === 'bulk' ? 'bulk.api.mailtrap.io' : 'send.api.mailtrap.io';
    const { to, cc, bcc } = envelopeLists(email);
    const headers: Record<string, string> = { ...threadingHeaders(email) };
    if (email.replyTo.length) headers['Reply-To'] = email.replyTo.map(addrString).join(', ');
    const { data } = await request<any>(ctx, `https://${host}/api/send`, {
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
      json: {
        from: toEmailName(email.from),
        to: to.map(toEmailName),
        cc: cc.length ? cc.map(toEmailName) : undefined,
        bcc: bcc.length ? bcc.map(toEmailName) : undefined,
        subject: email.subject,
        text: email.text ?? undefined,
        html: email.html ?? undefined,
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
    if (data && data.success === false) throw new ProviderError((data.errors ?? []).join('; ') || 'Mailtrap rejected the message', true);
    return { providerMessageId: data?.message_ids?.[0] ?? null };
  },
};

// ── Scaleway Transactional Email ────────────────────────────────────────────
export const scaleway: ProviderDefinition<{ secretKey: string; projectId: string; region?: string }> = {
  type: 'scaleway',
  name: 'Scaleway TEM',
  description: 'Scaleway Transactional Email (EU-hosted).',
  website: 'https://www.scaleway.com/en/transactional-email-tem/',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: false,
  spfInclude: '_spf.tem.scaleway.com',
  fields: [
    { key: 'secretKey', label: 'Secret key', type: 'password', required: true },
    { key: 'projectId', label: 'Project ID', type: 'text', required: true },
    { key: 'region', label: 'Region', type: 'select', default: 'fr-par', options: [{ value: 'fr-par', label: 'Paris (fr-par)' }] },
  ],
  outboundSetup: 'Add and verify your domain in Scaleway TEM, then create an API key with TransactionalEmailFullAccess.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['secretKey', 'projectId']);
    const { to, cc, bcc } = envelopeLists(email);
    const headers = Object.entries(threadingHeaders(email)).map(([key, value]) => ({ key, value }));
    if (email.replyTo.length) headers.push({ key: 'Reply-To', value: email.replyTo.map(addrString).join(', ') });
    const { data } = await request<any>(
      ctx,
      `https://api.scaleway.com/transactional-email/v1alpha1/regions/${encodeURIComponent(cfg.region || 'fr-par')}/emails`,
      {
        headers: { 'X-Auth-Token': cfg.secretKey },
        json: {
          from: toEmailName(email.from),
          to: to.map(toEmailName),
          cc: cc.map(toEmailName),
          bcc: bcc.map(toEmailName),
          subject: email.subject,
          text: email.text ?? '',
          html: email.html ?? '',
          project_id: cfg.projectId,
          additional_headers: headers,
          attachments: email.attachments.map((a) => ({ name: a.filename, type: a.contentType, content: b64(a.content) })),
        },
      },
    );
    return { providerMessageId: data?.emails?.[0]?.message_id ?? data?.emails?.[0]?.id ?? null };
  },
};
