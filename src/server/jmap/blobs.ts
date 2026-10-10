/** JMAP blobs: raw messages, attachments, body parts and uploads (which are unattached attachments). */
import type { Addr } from '../../shared/types.js';
import { domainOf } from '../lib/addr.js';
import { all, get, insert, now } from '../db/index.js';
import { getBlob, putBlob } from '../mail/blobs.js';
import { loadBody } from '../mail/body.js';
import { buildMime } from '../mail/compose.js';
import { parseBlobId } from './ids.js';

export interface BlobData {
  data: Uint8Array;
  type: string;
  name: string;
}

/** A message's raw MIME. Drafts have none stored, so theirs is built from the draft as it stands. */
export async function rawMessage(row: any): Promise<Uint8Array> {
  if (row.raw_blob) return getBlob(row.raw_blob);
  await loadBody(row);
  const atts = all<any>('SELECT * FROM attachments WHERE message_id = ? ORDER BY id', [row.id]);
  const { raw } = await buildMime({
    // A draft from the web app has no Message-ID until it's sent; a fixed stand-in names the same message every time.
    messageId: row.message_id || `draft.${row.id}.${row.created_at}.${row.jmap_rev}@${domainOf(row.from_addr) || 'wren.invalid'}`,
    from: { address: row.from_addr, name: row.from_name },
    to: JSON.parse(row.to_json) as Addr[],
    cc: JSON.parse(row.cc_json) as Addr[],
    subject: row.subject,
    html: row.html_body || null,
    text: row.text_body,
    inReplyTo: row.in_reply_to,
    references: (row.refs || '').split(/\s+/).filter(Boolean),
    date: new Date(row.date),
    attachments: await Promise.all(
      atts.map(async (a) => ({ filename: a.filename, contentType: a.content_type, content: await getBlob(a.blob), contentId: a.content_id, inline: !!a.inline })),
    ),
  });
  return raw;
}

/** The bytes behind a blob id, if it belongs to this mailbox. */
export async function readBlob(userId: number, blobId: unknown): Promise<BlobData | null> {
  const ref = parseBlobId(blobId);
  if (!ref) return null;
  if (ref.kind === 'attachment') {
    const a = get<any>('SELECT * FROM attachments WHERE id = ? AND user_id = ?', [ref.attachmentId, userId]);
    return a ? { data: await getBlob(a.blob), type: a.content_type, name: a.filename } : null;
  }
  const m = get<any>('SELECT * FROM messages WHERE id = ? AND user_id = ? AND created_at = ? AND jmap_rev = ?', [ref.messageId, userId, ref.createdAt, ref.rev]);
  if (!m) return null;
  if (ref.kind === 'raw') return { data: await rawMessage(m), type: 'message/rfc822', name: 'message.eml' };
  await loadBody(m);
  const text = ref.part === 'text' ? m.text_body : m.html_body;
  if (text === null || text === undefined) return null;
  return { data: new TextEncoder().encode(text), type: ref.part === 'text' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', name: ref.part === 'text' ? 'body.txt' : 'body.html' };
}

/** An upload: kept as an attachment with no message (removed after a day if nothing uses it). */
export async function storeUploadBlob(userId: number, data: Uint8Array, type: string): Promise<{ blobId: string; size: number; type: string }> {
  const blob = await putBlob(data);
  const clean = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream';
  const id = insert(
    `INSERT INTO attachments (user_id, message_id, filename, content_type, size, content_id, inline, blob, created_at) VALUES (?, NULL, ?, ?, ?, NULL, 0, ?, ?)`,
    [userId, 'upload', clean, data.length, blob, now()],
  );
  return { blobId: `A${id}`, size: data.length, type: clean };
}
