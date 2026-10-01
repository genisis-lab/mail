import type { Addr } from '../../../shared/types.js';
import { cleanMessageId, parseAddresses, parseReferences } from '../../lib/addr.js';
import { buildMimeMessage } from '../../mail/mime.js';

export interface RebuildInput {
  from: Addr | string | null;
  to?: Addr[] | string;
  cc?: Addr[] | string;
  replyTo?: string | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  date?: string | number | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** Original headers; threading headers are picked from here when not given explicitly. */
  headers?: Record<string, string>;
  attachments?: { filename: string; contentType: string; content: Uint8Array; contentId?: string | null }[];
}

const PASSTHROUGH = new Set([
  'authentication-results',
  'received-spf',
  'list-id',
  'list-unsubscribe',
  'auto-submitted',
  'precedence',
  'x-spam-status',
  'x-spam-score',
  'x-spam-flag',
  'delivered-to',
  'x-original-to',
]);

/**
 * Some inbound webhooks deliver parsed JSON instead of the original message.
 * Rebuild a faithful RFC 5322 message so the rest of the pipeline only ever
 * deals with raw MIME.
 */
export async function rebuildMime(input: RebuildInput): Promise<Buffer> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) h[k.toLowerCase()] = String(v);
  const toList = (v: Addr[] | string | undefined) => (typeof v === 'string' ? parseAddresses(v) : v ?? []);
  const from = (typeof input.from === 'string' ? parseAddresses(input.from)[0] : input.from) ?? { address: 'unknown@invalid', name: '' };
  const dateVal = input.date ?? h['date'];
  const date = dateVal ? new Date(dateVal) : new Date();
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (PASSTHROUGH.has(k)) extra[k.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase())] = v;
  const refs = input.references ?? h['references'];
  return buildMimeMessage({
    from,
    to: toList(input.to),
    cc: toList(input.cc),
    replyTo: input.replyTo || h['reply-to'] || null,
    subject: input.subject,
    text: input.text ?? null,
    html: input.html ?? null,
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    messageId: cleanMessageId(input.messageId ?? h['message-id']),
    inReplyTo: cleanMessageId(input.inReplyTo ?? h['in-reply-to']),
    references: refs ? parseReferences(refs) : null,
    headers: extra,
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      contentId: a.contentId || null,
      inline: !!a.contentId,
    })),
  });
}
