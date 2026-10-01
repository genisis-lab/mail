import crypto from 'node:crypto';
import type { Addr } from '../../shared/types.js';
import { APP_NAME, APP_VERSION } from '../../shared/brand.js';
import { domainOf } from '../lib/addr.js';
import { buildMimeMessage } from './mime.js';
import { htmlToText } from './parse.js';

export interface ComposeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentId?: string | null;
  inline?: boolean;
}

export interface ComposeInput {
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  bcc?: Addr[];
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: ComposeAttachment[];
  headers?: Record<string, string>;
  messageId?: string;
  date?: Date;
}

export function newMessageId(fromAddress: string): string {
  const domain = domainOf(fromAddress) || 'localhost';
  return `${Date.now().toString(36)}.${crypto.randomBytes(12).toString('hex')}@${domain}`;
}

/** Build an RFC 5322 message. Bcc is never written to the headers. */
export async function buildMime(input: ComposeInput): Promise<{ raw: Buffer; messageId: string }> {
  const messageId = input.messageId || newMessageId(input.from.address);
  const text = input.text ?? (input.html ? htmlToText(input.html) : '');
  const raw = buildMimeMessage({
    from: input.from,
    to: input.to,
    cc: input.cc,
    replyTo: input.replyTo,
    subject: input.subject,
    text,
    html: input.html || null,
    messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    date: input.date,
    headers: { 'X-Mailer': `${APP_NAME} ${APP_VERSION}`, ...(input.headers ?? {}) },
    attachments: input.attachments,
  });
  return { raw, messageId };
}

/** Quote a message body for replies/forwards. */
export function quoteHtml(opts: { html: string | null; text: string | null; from: Addr; date: number }): string {
  const when = new Date(opts.date).toUTCString();
  const who = opts.from.name ? `${escapeHtml(opts.from.name)} &lt;${escapeHtml(opts.from.address)}&gt;` : escapeHtml(opts.from.address);
  const body = opts.html ?? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(opts.text ?? '')}</pre>`;
  return `<br><div class="wren-quote"><div>On ${when}, ${who} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
