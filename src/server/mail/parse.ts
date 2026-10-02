import PostalMime, { type Address, type Email } from 'postal-mime';
import type { Addr } from '../../shared/types.js';
import { cleanMessageId, normalizeEmail, parseReferences } from '../lib/addr.js';

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  content: Buffer;
}

export interface Parsed {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: string | null;
  subject: string;
  date: number;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
  /** Lower-cased header name → every value of that header, in order. */
  headers: Map<string, string[]>;
  /** Auto-generated mail (auto-replies, bounces, lists) — never auto-reply to these. */
  automated: boolean;
  listId: string | null;
  deliveredTo: string[];
}

function addrs(list: Address[] | Address | undefined): Addr[] {
  if (!list) return [];
  const out: Addr[] = [];
  for (const a of Array.isArray(list) ? list : [list]) {
    if (a.group) {
      for (const g of a.group) if (g.address) out.push({ address: normalizeEmail(g.address), name: g.name || '' });
    } else if (a.address) {
      out.push({ address: normalizeEmail(a.address), name: a.name || '' });
    }
  }
  return out;
}

function toBuffer(content: ArrayBuffer | Uint8Array | string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return Buffer.from(new Uint8Array(content));
}

export async function parseMail(raw: Uint8Array): Promise<Parsed> {
  const m: Email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const headers = new Map<string, string[]>();
  for (const h of m.headers) {
    const key = h.key.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), h.value]);
  }
  const first = (k: string) => headers.get(k)?.[0] ?? '';

  const autoSubmitted = first('auto-submitted').toLowerCase();
  const precedence = first('precedence').toLowerCase().trim();
  const listIdRaw = first('list-id');
  const listId = listIdRaw ? (/<([^>]+)>/.exec(listIdRaw)?.[1] ?? listIdRaw.trim()) : null;
  const automated =
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence) ||
    !!listId ||
    headers.has('list-unsubscribe') ||
    headers.has('x-autoreply') ||
    headers.has('x-autorespond');

  const deliveredTo = ['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to']
    .flatMap((h) => headers.get(h) ?? [])
    .flatMap((v) => v.split(/[,\s]+/))
    .map((v) => v.replace(/[<>]/g, '').trim().toLowerCase())
    .filter((v) => v.includes('@'));

  const replyTo = addrs(m.replyTo).map((a) => a.address).join(', ');
  const parsedDate = m.date ? Date.parse(m.date) : Number.NaN;
  const date = Number.isNaN(parsedDate) ? Date.now() : parsedDate;

  return {
    messageId: cleanMessageId(m.messageId),
    inReplyTo: cleanMessageId(m.inReplyTo),
    references: parseReferences(m.references),
    from: addrs(m.from)[0] ?? null,
    to: addrs(m.to),
    cc: addrs(m.cc),
    bcc: addrs(m.bcc),
    replyTo: replyTo || null,
    subject: (m.subject || '').trim(),
    // Never trust far-future dates for sorting.
    date: Math.min(date, Date.now() + 5 * 60_000),
    text: m.text ?? null,
    html: m.html ?? null,
    attachments: m.attachments.map((a) => {
      const content = toBuffer(a.content);
      const contentId = cleanMessageId(a.contentId) ?? null;
      // Calendar invitations keep their iTIP method (REQUEST, REPLY, CANCEL…), which mail and calendar apps rely on.
      const calendar = a.mimeType === 'text/calendar' || a.mimeType === 'application/ics';
      return {
        filename: a.filename || (a.mimeType === 'message/rfc822' ? 'message.eml' : calendar ? 'invite.ics' : 'attachment'),
        contentType: calendar && a.method ? `text/calendar; method=${a.method}` : a.mimeType || 'application/octet-stream',
        size: content.length,
        contentId,
        inline: (a.disposition === 'inline' || !!a.related) && !!contentId,
        content,
      };
    }),
    headers,
    automated,
    listId,
    deliveredTo,
  };
}

/** A short, single-line preview of the message body. */
export function makeSnippet(text: string | null, html: string | null, max = 180): string {
  let src = text || '';
  if (!src && html) src = htmlToText(html);
  return src
    .replace(/^>.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|ul|ol|table|blockquote|h[1-6]|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getHeader(p: Parsed, key: string): string {
  return p.headers.get(key.toLowerCase())?.[0] ?? '';
}
