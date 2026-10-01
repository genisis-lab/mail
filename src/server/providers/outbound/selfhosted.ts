// Self-hosted / generic integrations: Postal, custom HTTP webhook, log-only,
// plus inbound-only sources (raw MIME, ForwardEmail, CloudMailin).
import crypto from 'node:crypto';
import { ProviderError, type ProviderDefinition } from '../types.js';
import { b64, request, requireFields } from '../http.js';
import { rawInbound } from '../inbound/raw.js';
import { rebuildMime } from '../inbound/rebuild.js';
import { logger } from '../../lib/log.js';

const log = logger('provider');

// ── Postal ──────────────────────────────────────────────────────────────────
export const postal: ProviderDefinition<{ baseUrl: string; apiKey: string }> = {
  type: 'postal',
  name: 'Postal (self-hosted)',
  description: 'Postal open-source mail server — send raw MIME via its API and receive via HTTP endpoints.',
  website: 'https://docs.postalserver.io',
  category: 'self-hosted',
  outbound: true,
  inbound: true,
  rawMime: true,
  fields: [
    { key: 'baseUrl', label: 'Postal URL', type: 'url', required: true, placeholder: 'https://postal.example.com' },
    { key: 'apiKey', label: 'Server API key', type: 'password', required: true },
  ],
  outboundSetup: 'Create a mail server and an API credential in Postal, and add the domain with its DNS records.',
  inboundSetup: 'In Postal add an HTTP Endpoint with URL {{url}} and format “Raw message”, then a route for your address(es) pointing to it.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['baseUrl', 'apiKey']);
    const { data } = await request<any>(ctx, `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/send/raw`, {
      headers: { 'X-Server-API-Key': cfg.apiKey },
      json: { mail_from: email.envelope.from, rcpt_to: email.envelope.to, data: b64(email.raw), bounce: false },
      timeoutMs: 60_000,
    });
    if (data?.status !== 'success') {
      throw new ProviderError(`Postal: ${data?.data?.message ?? data?.data?.code ?? 'error'}`, true);
    }
    return { providerMessageId: data?.data?.message_id ?? null };
  },

  async receive(_cfg, req) {
    const p = req.json<any>();
    if (!p?.message) throw new ProviderError('Expected Postal raw message payload', true, 400);
    return {
      items: [
        {
          raw: Buffer.from(p.message, p.base64 === false ? 'utf8' : 'base64'),
          rcptTo: p.rcpt_to ? [p.rcpt_to] : undefined,
          mailFrom: p.mail_from,
        },
      ],
    };
  },
};

// ── Custom HTTP webhook ─────────────────────────────────────────────────────
export const webhook: ProviderDefinition<{ url: string; secret?: string; authHeader?: string }> = {
  type: 'webhook',
  name: 'Custom HTTP webhook',
  description: 'POST every outgoing message as signed JSON to your own endpoint; accept generic JSON inbound.',
  website: 'https://en.wikipedia.org/wiki/Webhook',
  category: 'other',
  outbound: true,
  inbound: true,
  rawMime: true,
  fields: [
    { key: 'url', label: 'Endpoint URL', type: 'url', required: true },
    { key: 'secret', label: 'Signing secret', type: 'password', help: 'Adds X-Wren-Signature: sha256=HMAC(body).' },
    { key: 'authHeader', label: 'Authorization header', type: 'password', help: 'Optional value sent as the Authorization header.' },
  ],
  outboundSetup:
    'Wren POSTs JSON {from,to,cc,bcc,envelope,subject,text,html,headers,messageId,raw(base64),attachments[]}. Respond 2xx (optionally with {"id": "…"}).',
  inboundSetup:
    'POST JSON to {{url}} — either {"raw": "<base64 RFC 822>", "base64": true, "rcptTo": [...]} or {"from","to","cc","subject","text","html","headers","attachments":[{"filename","contentType","content"(base64)}]}.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['url']);
    const body = JSON.stringify({
      messageId: email.messageId,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      envelope: email.envelope,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: email.headers,
      raw: b64(email.raw),
      attachments: email.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, contentId: a.contentId, content: b64(a.content) })),
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Wren-Mail' };
    if (cfg.secret) headers['X-Wren-Signature'] = `sha256=${crypto.createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
    if (cfg.authHeader) headers.Authorization = cfg.authHeader;
    const { data } = await request<any>(ctx, cfg.url, { method: 'POST', headers, body });
    return { providerMessageId: data?.id ?? data?.messageId ?? null };
  },

  async receive(_cfg, req) {
    const p = req.json<any>();
    if (p?.raw) return rawInbound(req);
    const raw = await rebuildMime({
      from: p.from,
      to: p.to,
      cc: p.cc,
      subject: p.subject ?? '',
      text: p.text ?? null,
      html: p.html ?? null,
      date: p.date,
      messageId: p.messageId,
      inReplyTo: p.inReplyTo,
      references: p.references,
      headers: p.headers,
      attachments: (p.attachments ?? []).map((a: any) => ({
        filename: a.filename ?? 'attachment',
        contentType: a.contentType ?? 'application/octet-stream',
        content: Buffer.from(a.content ?? '', 'base64'),
        contentId: a.contentId ?? null,
      })),
    });
    const rcpt = p.rcptTo ?? p.envelope?.to;
    return { items: [{ raw, rcptTo: Array.isArray(rcpt) ? rcpt : rcpt ? [rcpt] : undefined, mailFrom: p.envelope?.from }] };
  },
};

// ── Log only (development) ──────────────────────────────────────────────────
export const logOnly: ProviderDefinition<Record<string, never>> = {
  type: 'log',
  name: 'Log only (testing)',
  description: 'Pretends to send: records the message in the server log. Useful for trying Wren without credentials.',
  website: '',
  category: 'other',
  outbound: true,
  inbound: false,
  rawMime: true,
  fields: [],
  outboundSetup: 'Nothing is delivered to external recipients. Local recipients on this server still receive mail.',

  async send(_cfg, email) {
    log.info(`[log provider] ${email.envelope.from} → ${email.envelope.to.join(', ')} :: ${email.subject} (${email.raw.length} bytes)`);
    return { providerMessageId: `log-${Date.now().toString(36)}`, detail: 'Logged only — not delivered' };
  },
};

// ── Inbound-only sources ────────────────────────────────────────────────────
export const rawMime: ProviderDefinition<Record<string, never>> = {
  type: 'raw',
  name: 'Raw MIME (HTTP)',
  description: 'Accept original RFC 822 messages over HTTP — for MTA pipes (Postfix, Exim), scripts, or custom workers.',
  website: '',
  category: 'inbound',
  outbound: false,
  inbound: true,
  rawMime: true,
  fields: [],
  inboundSetup:
    'POST the message bytes to {{url}} with Content-Type: message/rfc822 and optional X-Rcpt-To / X-Mail-From headers. Postfix example: curl -sf --data-binary @- -H "Content-Type: message/rfc822" -H "X-Rcpt-To: ${recipient}" {{url}}',
  receive: (_cfg, req) => rawInbound(req),
};

export const forwardemail: ProviderDefinition<{ webhookKey?: string }> = {
  type: 'forwardemail',
  name: 'Forward Email',
  description: 'Receive through forwardemail.net webhooks (privacy-focused, open-source forwarding).',
  website: 'https://forwardemail.net',
  category: 'inbound',
  outbound: false,
  inbound: true,
  rawMime: true,
  fields: [{ key: 'webhookKey', label: 'Webhook signature key', type: 'password', inbound: true, help: 'Verifies X-Webhook-Signature.' }],
  inboundSetup: 'Add a TXT record forward-email=<address>:{{url}} (or configure the webhook in your Forward Email dashboard).',

  async receive(cfg, req) {
    if (cfg.webhookKey) {
      const sig = req.headers.get('x-webhook-signature') ?? '';
      const expected = crypto.createHmac('sha256', cfg.webhookKey).update(req.body).digest('hex');
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw new ProviderError('Invalid webhook signature', true, 401);
      }
    }
    const p = req.json<any>();
    if (!p?.raw) throw new ProviderError('Payload has no raw message', true, 400);
    const rcpt = p.recipients ?? p.session?.envelope?.rcptTo?.map((r: any) => r.address);
    return { items: [{ raw: Buffer.from(p.raw, 'utf8'), rcptTo: rcpt, mailFrom: p.session?.envelope?.mailFrom?.address }] };
  },
};

export const cloudmailin: ProviderDefinition<Record<string, never>> = {
  type: 'cloudmailin',
  name: 'CloudMailin',
  description: 'Receive through CloudMailin (JSON Normalized or Raw format).',
  website: 'https://www.cloudmailin.com',
  category: 'inbound',
  outbound: false,
  inbound: true,
  rawMime: false,
  fields: [],
  inboundSetup: 'Set your CloudMailin address target to {{url}} using the “JSON (Normalized)” or “Multipart (Raw)” format.',

  async receive(_cfg, req) {
    if (!req.contentType.includes('application/json')) return rawInbound(req);
    const p = req.json<any>();
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(p?.headers ?? {})) h[k] = Array.isArray(v) ? String(v[0]) : String(v);
    const raw = await rebuildMime({
      from: h.from ?? h.From ?? p.envelope?.from,
      to: h.to ?? h.To,
      cc: h.cc ?? h.Cc,
      subject: h.subject ?? h.Subject ?? '',
      text: p.plain ?? null,
      html: p.html ?? null,
      headers: h,
      attachments: (p.attachments ?? [])
        .filter((a: any) => a.content)
        .map((a: any) => ({
          filename: a.file_name ?? 'attachment',
          contentType: a.content_type ?? 'application/octet-stream',
          content: Buffer.from(a.content, 'base64'),
          contentId: a.content_id ?? null,
        })),
    });
    return {
      items: [
        {
          raw,
          rcptTo: p.envelope?.recipients ?? (p.envelope?.to ? [p.envelope.to] : undefined),
          mailFrom: p.envelope?.from,
          verdicts: p.envelope?.spf?.result ? { spf: String(p.envelope.spf.result).toLowerCase() } : undefined,
        },
      ],
    };
  },
};
