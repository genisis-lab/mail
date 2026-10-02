import type { Addr, ProviderFieldDef, ProviderTypeInfo } from '../../shared/types.js';

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentId?: string | null;
  inline?: boolean;
}

/** Everything an adapter could need: structured fields AND the full raw MIME. */
export interface OutboundEmail {
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  subject: string;
  text: string | null;
  html: string | null;
  /** Threading / custom headers that JSON APIs should forward (Message-ID, In-Reply-To, References…). */
  headers: Record<string, string>;
  attachments: OutboundAttachment[];
  /** Full RFC 5322 message without Bcc header. */
  raw: Buffer;
  messageId: string;
  /** SMTP envelope: who actually receives this attempt (may be a subset on retries). */
  envelope: { from: string; to: string[] };
}

export interface SendResult {
  providerMessageId?: string | null;
  /** Recipients the provider refused while accepting the rest (SMTP RCPT errors). */
  rejected?: { rcpt: string; reason: string; permanent: boolean; code?: number }[];
  /** Free-form note recorded in the delivery log. */
  detail?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Permanent errors (bad credentials, rejected sender) are not retried. */
    public permanent = false,
    public status?: number,
  ) {
    super(message);
  }
}

/** A message extracted from an inbound webhook, ready for the ingest pipeline. */
export interface InboundItem {
  raw: Buffer;
  rcptTo?: string[];
  mailFrom?: string;
  /** Verdicts supplied by the provider (spf/dkim/dmarc/spam/virus). */
  verdicts?: Record<string, string>;
  /** Provider spam score if any (higher = spammier). */
  spamScore?: number;
}

export interface InboundRequest {
  method: string;
  headers: Headers;
  url: URL;
  body: Buffer;
  contentType: string;
  /** Lazily parsed form data (multipart or urlencoded). */
  form(): Promise<FormData>;
  json<T = any>(): T;
}

/** A webhook can respond with messages to ingest, or a direct HTTP response (e.g. a handshake). */
/** What happened to a message after the provider accepted it (from its event webhooks). */
export interface DeliveryEvent {
  /** The id the provider returned when Wren sent the message (outbox.provider_message_id). */
  providerMessageId?: string | null;
  /** The message's Message-ID header, when the provider (or a bounce report) gives it. */
  messageId?: string | null;
  type: 'delivered' | 'bounced' | 'complained' | 'delayed';
  recipients: string[];
  /** For bounces: true when the address can't receive mail (hard bounce). */
  permanent?: boolean;
  /** For permanent bounces: stop mailing the address (default). False when the message, not the address, was refused. */
  suppress?: boolean;
  detail?: string;
}

export interface InboundResult {
  items?: InboundItem[];
  events?: DeliveryEvent[];
  response?: { status: number; body: unknown };
}

export interface ProviderContext {
  fetch: typeof fetch;
}

export interface ProviderDefinition<C = Record<string, any>> extends Omit<ProviderTypeInfo, 'fields'> {
  fields: ProviderFieldDef[];
  send?(cfg: C, email: OutboundEmail, ctx: ProviderContext): Promise<SendResult>;
  /** Optional lightweight credential check; returns a human-readable status. */
  verify?(cfg: C, ctx: ProviderContext): Promise<string>;
  receive?(cfg: C, req: InboundRequest, ctx: ProviderContext): Promise<InboundResult>;
  /** Domains set up for sending at the provider, and whether each is verified (for picking a sender address). */
  sendingDomains?(cfg: C, ctx: ProviderContext): Promise<{ name: string; verified: boolean }[]>;
}
