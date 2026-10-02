/**
 * Delivery status from every provider that reports it by webhook: what
 * happened after the provider accepted a message (delivered, bounced,
 * marked as spam, delayed). Each provider's webhook posts to the same
 * secret URL as its inbound mail (/api/inbound/<token>).
 *
 * Resend, Amazon SES and Postmark read their events in their own adapters
 * (their inbound webhooks share the payload format). Providers that report
 * bounces only by email (SMTP relays, Cloudflare Email Service) are covered
 * by the bounce-report reader in mail/dsn.ts.
 */
import crypto from 'node:crypto';
import { derToRaw } from '../lib/webauthn.js';
import { ProviderError, type DeliveryEvent, type InboundRequest, type ProviderContext } from './types.js';

type Parser = (req: InboundRequest, cfg: Record<string, any>, ctx: ProviderContext) => Promise<DeliveryEvent[] | null> | DeliveryEvent[] | null;

const list = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const clean = (id: unknown) => str(id).replace(/[<>]/g, '').trim() || null;
const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(': ');

function json(req: InboundRequest): any {
  if (!/json/i.test(req.contentType) && !/^\s*[[{]/.test(req.body.toString('utf8', 0, 64))) return null;
  try {
    return req.json();
  } catch {
    return null;
  }
}

/** Form or query fields as an object (Elastic Email and SMTP2GO can post forms). */
async function fields(req: InboundRequest): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.fromEntries(req.url.searchParams.entries());
  if (/form/i.test(req.contentType)) {
    for (const [k, v] of await req.form()) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** SparkPost bounce classes that mean the address is bad. */
const SPARKPOST_HARD = new Set([10, 30, 90]);

/** SendGrid's signed event webhook (optional): ECDSA P-256 over timestamp + body. */
async function verifySendgrid(req: InboundRequest, publicKey: string) {
  const sig = req.headers.get('x-twilio-email-event-webhook-signature');
  const ts = req.headers.get('x-twilio-email-event-webhook-timestamp');
  if (!sig || !ts) throw new ProviderError('Missing SendGrid event signature', true, 401);
  let ok = false;
  try {
    const key = await crypto.webcrypto.subtle.importKey('spki', Buffer.from(publicKey.replace(/-----[^-]+-----|\s+/g, ''), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(Buffer.from(sig, 'base64')), Buffer.concat([Buffer.from(ts), req.body]));
  } catch {
    ok = false; // a malformed signature or key
  }
  if (!ok) throw new ProviderError('Invalid SendGrid event signature', true, 401);
}

function verifyHmac(given: string | null, secret: string, data: Buffer | string, encoding: 'hex' | 'base64' = 'hex') {
  const expected = crypto.createHmac('sha256', secret).update(data).digest(encoding);
  if (!given || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new ProviderError('Invalid webhook signature', true, 401);
  }
}

export const EVENT_PARSERS: Record<string, Parser> = {
  // Event Webhook: an array of events.
  async sendgrid(req, cfg) {
    const body = json(req);
    if (!Array.isArray(body) || !body.some((e) => e?.event && e?.sg_message_id)) return null;
    if (cfg.eventWebhookKey) await verifySendgrid(req, cfg.eventWebhookKey);
    const out: DeliveryEvent[] = [];
    for (const e of body) {
      const base = { providerMessageId: str(e.sg_message_id).split('.')[0] || null, messageId: clean(e['smtp-id']), recipients: [str(e.email)] };
      if (e.event === 'delivered') out.push({ ...base, type: 'delivered', detail: str(e.response) });
      else if (e.event === 'bounce') out.push({ ...base, type: 'bounced', permanent: e.type !== 'blocked', detail: join(e.bounce_classification ?? e.type, e.reason) });
      else if (e.event === 'dropped') out.push({ ...base, type: 'bounced', permanent: true, detail: join('Dropped', e.reason), suppress: /bounced|invalid|spam/i.test(str(e.reason)) });
      else if (e.event === 'deferred') out.push({ ...base, type: 'delayed', detail: str(e.response) });
      else if (e.event === 'spamreport') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Webhooks: one event per post, signed like inbound routes.
  mailgun(req, cfg) {
    const body = json(req);
    const e = body?.['event-data'];
    if (!e?.event) return null;
    if (cfg.webhookSigningKey) {
      const s = body.signature ?? {};
      if (Math.abs(Date.now() / 1000 - Number(s.timestamp)) > 15 * 60) throw new ProviderError('Stale Mailgun signature', true, 401);
      verifyHmac(str(s.signature), cfg.webhookSigningKey, str(s.timestamp) + str(s.token));
    }
    const id = clean(e.message?.headers?.['message-id']);
    const base = { providerMessageId: id, messageId: id, recipients: [str(e.recipient)] };
    const status = e['delivery-status'] ?? {};
    if (e.event === 'delivered') return [{ ...base, type: 'delivered', detail: str(status.message) }];
    if (e.event === 'failed') return [{ ...base, type: 'bounced', permanent: e.severity === 'permanent', detail: join(e.reason, status.description || status.message) }];
    if (e.event === 'complained') return [{ ...base, type: 'complained' }];
    return [];
  },

  // Transactional webhooks: one event, or a batch.
  brevo(req) {
    const body = json(req);
    const events = list(body).filter((e: any) => e?.event && (e.email || e['message-id']));
    if (!events.length || body?.items) return null;
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: clean(e['message-id']), messageId: clean(e['message-id']), recipients: [str(e.email)] };
      if (e.event === 'delivered') out.push({ ...base, type: 'delivered' });
      else if (e.event === 'hard_bounce' || e.event === 'invalid_email') out.push({ ...base, type: 'bounced', permanent: true, detail: join(e.event, e.reason) });
      else if (e.event === 'soft_bounce' || e.event === 'blocked') out.push({ ...base, type: 'bounced', permanent: false, detail: join(e.event, e.reason) });
      else if (e.event === 'deferred') out.push({ ...base, type: 'delayed', detail: str(e.reason) });
      else if (e.event === 'spam' || e.event === 'complaint') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Event API: one event or a batch; MessageID matches what the Send API returned.
  mailjet(req) {
    const body = json(req);
    const events = list(body).filter((e: any) => e?.event && (e.MessageID || e.Message_GUID));
    if (!events.length) return null;
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: str(e.MessageID) || str(e.Message_GUID), recipients: [str(e.email)] };
      if (e.event === 'sent') out.push({ ...base, type: 'delivered', detail: str(e.smtp_reply) });
      else if (e.event === 'bounce') out.push({ ...base, type: 'bounced', permanent: !!e.hard_bounce, detail: join(e.error_related_to, e.error, e.comment) });
      else if (e.event === 'blocked') out.push({ ...base, type: 'bounced', permanent: false, detail: join('Blocked', e.error_related_to, e.error) });
      else if (e.event === 'spam') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Event webhooks: [{msys: {message_event: …}}]; relay (inbound) batches are left to the adapter.
  sparkpost(req, cfg) {
    const body = json(req);
    const events = list(body)
      .map((e: any) => e?.msys?.message_event)
      .filter(Boolean);
    if (!events.length) return null;
    if (cfg.relayToken && req.headers.get('x-messagesystems-webhook-token') && req.headers.get('x-messagesystems-webhook-token') !== cfg.relayToken) {
      throw new ProviderError('Invalid webhook token', true, 401);
    }
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: str(e.transmission_id) || null, recipients: [str(e.rcpt_to)] };
      if (e.type === 'delivery') out.push({ ...base, type: 'delivered', detail: str(e.raw_reason) });
      else if (e.type === 'bounce' || e.type === 'out_of_band') {
        const cls = Number(e.bounce_class);
        out.push({ ...base, type: 'bounced', permanent: SPARKPOST_HARD.has(cls), detail: join(`class ${cls}`, e.raw_reason ?? e.reason) });
      } else if (e.type === 'delay') out.push({ ...base, type: 'delayed', detail: str(e.raw_reason) });
      else if (e.type === 'spam_complaint') out.push({ ...base, type: 'complained' });
      else if (e.type === 'policy_rejection' || e.type === 'generation_rejection') out.push({ ...base, type: 'bounced', permanent: false, detail: join('Rejected', e.raw_reason ?? e.reason) });
    }
    return out;
  },

  // Webhooks with an optional signing secret (Signature header, HMAC-SHA256 of the body).
  mailersend(req, cfg) {
    const body = json(req);
    if (!str(body?.type).startsWith('activity.')) return null;
    if (cfg.webhookSecret) verifyHmac(req.headers.get('signature'), cfg.webhookSecret, req.body);
    const email = body.data?.email ?? {};
    const base = { providerMessageId: str(email.message?.id) || null, recipients: [str(email.recipient?.email)] };
    const reason = join(body.data?.morph?.reason, body.data?.morph?.readable_reason);
    switch (body.type) {
      case 'activity.delivered':
        return [{ ...base, type: 'delivered' }];
      case 'activity.hard_bounced':
        return [{ ...base, type: 'bounced', permanent: true, detail: reason }];
      case 'activity.soft_bounced':
        return [{ ...base, type: 'bounced', permanent: false, detail: reason }];
      case 'activity.spam_complaint':
        return [{ ...base, type: 'complained' }];
      default:
        return [];
    }
  },

  // Delivery-events webhook: one event or a batch.
  mailchannels(req) {
    const body = json(req);
    const events = list(body?.events ?? body).filter((e: any) => e?.event && (e.email || e.recipient));
    if (!events.length) return null;
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: str(e.message_id ?? e.request_id) || null, messageId: clean(e.smtp_id ?? e['message-id']), recipients: [str(e.email ?? e.recipient)] };
      const ev = str(e.event).toLowerCase();
      if (ev === 'delivered') out.push({ ...base, type: 'delivered' });
      else if (ev === 'hard-bounced' || ev === 'hard_bounced') out.push({ ...base, type: 'bounced', permanent: true, detail: str(e.reason ?? e.status) });
      else if (ev === 'soft-bounced' || ev === 'soft_bounced' || ev === 'dropped') out.push({ ...base, type: 'bounced', permanent: false, detail: str(e.reason ?? e.status) });
      else if (ev === 'complained') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Webhooks post JSON or a form; email_id is what the send API returned.
  async smtp2go(req) {
    const body = json(req) ?? (await fields(req));
    const events = list(body).filter((e: any) => e?.event && (e.email_id || e['message-id']));
    if (!events.length) return null;
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: str(e.email_id) || null, messageId: clean(e['message-id'] ?? e.message_id), recipients: [str(e.rcpt ?? e.email ?? e.recipient)] };
      const ev = str(e.event).toLowerCase();
      if (ev === 'delivered') out.push({ ...base, type: 'delivered', detail: str(e.context) });
      else if (ev === 'bounce') out.push({ ...base, type: 'bounced', permanent: str(e.bounce).toLowerCase() !== 'soft', detail: str(e.context ?? e.bounce_context) });
      else if (ev === 'reject') out.push({ ...base, type: 'bounced', permanent: false, detail: join('Rejected', e.context) });
      else if (ev === 'spam') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Webhooks: event_name plus event_message[] with the request_id the send API returned.
  zeptomail(req) {
    const body = json(req);
    const names = list(body?.event_name).map((n) => str(n).toLowerCase());
    if (!names.length || !body?.event_message) return null;
    const out: DeliveryEvent[] = [];
    for (const m of list<any>(body.event_message)) {
      const id = str(m.request_id ?? m.email_info?.request_id) || null;
      const details = list<any>(m.event_data).flatMap((d) => list<any>(d.details));
      const to = list<any>(m.email_info?.to).map((t) => str(t.email_address?.address ?? t.address));
      const recipients = details.map((d) => str(d.bounced_recipient)).filter(Boolean);
      const detail = details.map((d) => join(d.reason, d.diagnostic_message)).filter(Boolean).join('; ');
      for (const n of names) {
        if (n === 'hardbounce') out.push({ providerMessageId: id, type: 'bounced', permanent: true, recipients: recipients.length ? recipients : to, detail });
        else if (n === 'softbounce') out.push({ providerMessageId: id, type: 'bounced', permanent: false, recipients: recipients.length ? recipients : to, detail });
        else if (n === 'delivered' || n === 'email_delivered') out.push({ providerMessageId: id, type: 'delivered', recipients: to });
        else if (n === 'spam' || n === 'feedback_loop') out.push({ providerMessageId: id, type: 'complained', recipients: to });
      }
    }
    return out;
  },

  // Notifications arrive as query parameters (GET or POST), or JSON.
  async elasticemail(req) {
    const body = json(req) ?? (await fields(req));
    const e = list(body).find((x: any) => x && (x.status || x.Status) && (x.messageid || x.MessageID || x.transaction || x.TransactionID));
    if (!e) return null;
    const status = str(e.status ?? e.Status).toLowerCase();
    const category = str(e.category ?? e.Category);
    const base = { providerMessageId: str(e.messageid ?? e.MessageID ?? e.transaction ?? e.TransactionID) || null, recipients: [str(e.to ?? e.To)] };
    if (status === 'sent' || status === 'delivered') return [{ ...base, type: 'delivered' }];
    if (status === 'error' || status === 'bounce') {
      const hard = /nomailbox|accountproblem|dnsproblem|notdelivered/i.test(category);
      return [{ ...base, type: 'bounced', permanent: hard, detail: category }];
    }
    if (status === 'abusereport') return [{ ...base, type: 'complained' }];
    return [];
  },

  // Webhooks: {events: [...]}, message_id from the send API.
  mailtrap(req) {
    const body = json(req);
    const events = list<any>(body?.events).filter((e) => e?.event && e.message_id);
    if (!events.length) return null;
    const out: DeliveryEvent[] = [];
    for (const e of events) {
      const base = { providerMessageId: str(e.message_id), recipients: [str(e.email)] };
      const ev = str(e.event).toLowerCase();
      if (ev === 'delivery') out.push({ ...base, type: 'delivered', detail: str(e.response) });
      else if (ev === 'bounce') out.push({ ...base, type: 'bounced', permanent: true, detail: join(e.bounce_category, e.response) });
      else if (ev === 'soft bounce' || ev === 'soft_bounce') out.push({ ...base, type: 'bounced', permanent: false, detail: str(e.response) });
      else if (ev === 'reject' || ev === 'suspension') out.push({ ...base, type: 'bounced', permanent: false, detail: join(ev, e.reason ?? e.response) });
      else if (ev === 'spam') out.push({ ...base, type: 'complained' });
    }
    return out;
  },

  // Webhooks through Scaleway Topics and Events (SNS-style envelopes) or posted directly.
  async scaleway(req, _cfg, ctx) {
    let body = json(req);
    if (!body) return null;
    if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
      const u = new URL(body.SubscribeURL);
      if (!/(^|\.)scaleway\.com$|(^|\.)scw\.cloud$/.test(u.hostname)) throw new ProviderError('Refusing to confirm a non-Scaleway subscription URL', true, 400);
      await ctx.fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
      return [];
    }
    if (body.Type === 'Notification' && typeof body.Message === 'string') {
      try {
        body = JSON.parse(body.Message);
      } catch {
        return null;
      }
    }
    const type = str(body?.type);
    if (!type.startsWith('email_')) return null;
    const base = { providerMessageId: str(body.email_id ?? body.id) || null, messageId: clean(body.email_message_id ?? body.message_id), recipients: [str(body.email_to ?? body.to)] };
    if (type === 'email_delivered') return [{ ...base, type: 'delivered' }];
    if (type === 'email_mailbox_not_found') return [{ ...base, type: 'bounced', permanent: true, detail: 'Mailbox not found' }];
    if (type === 'email_dropped' || type === 'email_blocklisted') return [{ ...base, type: 'bounced', permanent: false, detail: join(type.replace('email_', ''), body.email_response_message) }];
    if (type === 'email_deferred') return [{ ...base, type: 'delayed', detail: str(body.email_response_message) }];
    if (type === 'email_spam') return [{ ...base, type: 'complained' }];
    return [];
  },

  // Webhooks: {event, payload}; inbound "raw message" posts are left to the adapter.
  postal(req) {
    const body = json(req);
    if (!str(body?.event).startsWith('Message') || !body.payload) return null;
    const p = body.payload;
    const msg = p.message ?? p.original_message ?? {};
    const id = clean(msg.message_id);
    const base = { providerMessageId: id, messageId: id, recipients: [str(msg.to ?? p.bounce?.to)] };
    switch (body.event) {
      case 'MessageSent':
        return [{ ...base, type: 'delivered', detail: str(p.output ?? p.details) }];
      case 'MessageDelayed':
        return [{ ...base, type: 'delayed', detail: str(p.details ?? p.output) }];
      case 'MessageDeliveryFailed':
        return [{ ...base, type: 'bounced', permanent: str(p.status).toLowerCase() === 'hardfail', detail: str(p.details ?? p.output) }];
      case 'MessageBounced':
        return [{ ...base, type: 'bounced', permanent: true, detail: str(p.bounce?.subject) || 'Bounced' }];
      default:
        return [];
    }
  },

  // Your own endpoint can report status too: {"events": [{"messageId" | "providerMessageId", "type", "recipients", "permanent", "detail"}]}.
  webhook(req) {
    const body = json(req);
    const events = list<any>(body?.events).filter((e) => e && ['delivered', 'bounced', 'complained', 'delayed'].includes(e.type));
    if (!events.length) return null;
    return events.map((e) => ({
      providerMessageId: str(e.providerMessageId) || null,
      messageId: clean(e.messageId),
      type: e.type,
      recipients: list(e.recipients).map(str),
      permanent: e.permanent === undefined ? undefined : !!e.permanent,
      detail: str(e.detail),
    }));
  },
};

/** How to turn on delivery status for each provider; {{url}} is the provider's webhook URL. */
export const EVENTS_SETUP: Record<string, string> = {
  resend: 'In Resend → Webhooks, add (or edit) the endpoint {{url}} and select email.delivered, email.bounced, email.complained and email.delivery_delayed.',
  ses: 'Create a configuration set (or identity notifications) that sends Bounce, Complaint and Delivery events to an SNS topic, and subscribe {{url}} to it over HTTPS.',
  postmark: 'In Postmark → your server → Webhooks, add {{url}} and tick Delivery, Bounce and Spam Complaint.',
  sendgrid: 'In SendGrid → Settings → Mail Settings → Event Webhook, set the URL to {{url}} and select Delivered, Bounced, Dropped, Deferred and Spam Reports. If you turn on signature verification, paste the verification key here.',
  mailgun: 'In Mailgun → Sending → Webhooks, add {{url}} for Delivered, Permanent failure, Temporary failure and Spam complaints. The HTTP webhook signing key verifies them.',
  brevo: 'In Brevo → Transactional → Settings → Webhooks, add {{url}} with Delivered, Hard bounce, Soft bounce, Blocked, Deferred, Invalid email and Complaint.',
  mailjet: 'In Mailjet → Account settings → Event notifications (webhooks), set {{url}} for Sent, Bounce, Blocked and Spam.',
  sparkpost: 'In SparkPost → Webhooks, add {{url}} with the Delivery, Bounce, Delay, Spam complaint, Out-of-band and Policy rejection events.',
  mailersend: 'In MailerSend → Domains → Webhooks, add {{url}} with activity.delivered, activity.soft_bounced, activity.hard_bounced and activity.spam_complaint. Paste the signing secret here.',
  mailchannels: 'In the MailChannels console → Webhooks, add {{url}} for delivered, hard-bounced, soft-bounced and complained events.',
  smtp2go: 'In SMTP2GO → Settings → Webhooks, add {{url}} with the Delivered, Bounce, Reject and Spam events.',
  zeptomail: 'In ZeptoMail → Mail Agent → Webhooks, add {{url}} with Hard bounce, Soft bounce and Feedback loop events.',
  elasticemail: 'In Elastic Email → Settings → Notifications, add {{url}} as the webhook URL and tick Sent, Error (bounces) and Abuse reports.',
  mailtrap: 'In Mailtrap → Sending Domains → Webhooks, add {{url}} with Delivery, Bounce, Soft bounce, Reject and Spam.',
  scaleway: 'In Scaleway TEM → Webhooks, send the delivered, dropped, deferred, mailbox-not-found, blocklisted and spam events to a Topics and Events topic, and subscribe {{url}} to it over HTTPS.',
  postal: 'In Postal → your mail server → Webhooks, add {{url}} with MessageSent, MessageDelayed, MessageDeliveryFailed and MessageBounced.',
  webhook: 'Your endpoint can POST delivery status to {{url}} as {"events": [{"messageId", "type": "delivered" | "bounced" | "complained" | "delayed", "recipients": [...], "permanent": true}]}.',
  smtp: 'Bounce messages and spam reports that come back to the sender are read automatically.',
  cloudflare: 'Bounce messages and spam reports that come back to the sender are read automatically.',
  'cloudflare-binding': 'Bounce messages and spam reports that come back to the sender are read automatically.',
};

export const hasEventWebhook = (type: string) => !!EVENT_PARSERS[type];
