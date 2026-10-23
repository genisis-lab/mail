/**
 * Private links: the recipients of a message get a link instead of its content,
 * and the link stops working after a set time. A draft is marked first
 * (setPrivate); only when the message actually goes out (preparePrivateLink, from
 * the outbox) is the token made and the outgoing message turned into a notice.
 * The original stays in Sent until a recipient accepts delivery; only then does
 * expiry start. Only the token's hash is kept; the token is in the link.
 *
 * Having the link isn't enough to read it: the viewer names one of the
 * message's recipients, Wren emails that address a one-time code, and only a
 * browser that enters it gets a short pass (a cookie) to the content.
 */
import type { Addr, AttachmentInfo } from '../../shared/types.js';
import { config } from '../config.js';
import { all, get, now, run, tx } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { sendSystemEmail, systemTemplate } from '../services/system-mail.js';
import { putBlob } from './blobs.js';
import { loadBody } from './body.js';
import { buildMime, escapeHtml } from './compose.js';
import { indexMessage } from './store.js';
import { parseMail } from './parse.js';

const DAY = 86_400_000;
/** An emailed code works for 10 minutes and a few tries; a browser that entered it can read for an hour. */
const CODE_TTL = 10 * 60_000;
export const CODE_TRIES = 5;
const PASS_TTL = 3_600_000;

/** The attachment rows moved into private_links.attachments. */
interface StoredAttachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  inline: number;
  blob: string;
}

export interface LinkRow {
  id: number;
  user_id: number;
  message_id: number;
  days: number;
  expires_at: number;
  html_body: string | null;
  text_body: string | null;
  body_blob: string | null;
  attachments: string;
}

/** Mark a draft to go out as a private link that works for `days`, or as a normal message (null). */
export function setPrivate(userId: number, draftId: number, days: number | null) {
  if (days === null) run('DELETE FROM private_links WHERE message_id = ? AND token_hash IS NULL', [draftId]);
  else
    run('INSERT INTO private_links (user_id, message_id, days, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET days = excluded.days', [
      userId,
      draftId,
      days,
      now(),
    ]);
}

export function isPrivate(messageId: number): boolean {
  return !!get('SELECT 1 FROM private_links WHERE message_id = ?', [messageId]);
}

/** Its outgoing notice was prepared, so delivery may already be in flight. */
export function linkMade(messageId: number): boolean {
  return !!get('SELECT 1 FROM private_links WHERE message_id = ? AND token_hash IS NOT NULL', [messageId]);
}

/** What recipients get: who sent it, a button to open it and when it stops working. Nothing of the message itself. */
function noticeBody(sender: string, url: string, days: number): { html: string; text: string } {
  // A retry may happen much later. The notice must not promise a deadline before delivery.
  const expiry = `${days} ${days === 1 ? 'day' : 'days'} after delivery`;
  const text = `${sender} sent you a private message.\n\nOpen the message:\n${url}\n\nTo open it, you'll enter a code that is emailed to you. This link stops working ${expiry}.\n`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p><b>${escapeHtml(sender)}</b> sent you a private message.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">Open the message</a></p>
<p style="color:#5f6368;font-size:13px">To open it, you’ll enter a code that is emailed to you. This link stops working ${expiry}.</p>
</div>`;
  return { html, text };
}

/**
 * Prepare a notice and a copy of the content, retaining the original message
 * until delivery succeeds. Returns the notice's raw blob, or null when the message isn't
 * private or its link was already made (a retry).
 */
export async function preparePrivateLink(messageId: number, outboxId: number): Promise<string | null> {
  const link = get<{ id: number; days: number }>('SELECT id, days FROM private_links WHERE message_id = ? AND token_hash IS NULL', [messageId]);
  const m = link && get<any>('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!link || !m) return null;
  const token = randomToken(32);
  const from: Addr = { address: m.from_addr, name: m.from_name };
  const sender = from.name || from.address;
  const body = noticeBody(sender, `${config.publicUrl}/p/${token}`, link.days);
  const { raw } = await buildMime({
    messageId: m.message_id,
    from,
    to: JSON.parse(m.to_json),
    cc: JSON.parse(m.cc_json),
    bcc: JSON.parse(m.bcc_json),
    subject: m.subject,
    html: body.html,
    text: body.text,
    inReplyTo: m.in_reply_to,
    references: (m.refs || '').split(/\s+/).filter(Boolean),
  });
  const rawBlob = await putBlob(raw);
  const atts = all<StoredAttachment>('SELECT id, filename, content_type, size, content_id, inline, blob FROM attachments WHERE message_id = ? ORDER BY id', [messageId]);
  tx(() => {
    run('UPDATE private_links SET token_hash = ?, html_body = ?, text_body = ?, body_blob = ?, attachments = ? WHERE id = ?', [
      sha256(token),
      m.html_body,
      m.text_body,
      m.body_blob,
      JSON.stringify(atts),
      link.id,
    ]);
    run('UPDATE outbox SET raw_blob = ? WHERE id = ?', [rawBlob, outboxId]);
  });
  return rawBlob;
}

/** Start the lifetime on the first accepted delivery, including partial/local success. */
export async function activatePrivateLink(messageId: number, raw: Buffer, rawBlob: string) {
  if (!get('SELECT 1 FROM private_links WHERE message_id = ? AND token_hash IS NOT NULL AND expires_at IS NULL', [messageId])) return;
  const notice = await parseMail(raw);
  tx(() => {
    const activated = run('UPDATE private_links SET expires_at = ? + days * ? WHERE message_id = ? AND token_hash IS NOT NULL AND expires_at IS NULL', [now(), DAY, messageId]);
    if (!activated.changes) return; // a retry must never extend an already delivered link
    run('DELETE FROM attachments WHERE message_id = ?', [messageId]);
    // A new revision, so mail apps (JMAP) see the notice as a new email rather than a changed one.
    run('UPDATE messages SET html_body = ?, text_body = ?, body_blob = NULL, snippet = ?, raw_blob = ?, has_attachments = 0, jmap_rev = jmap_rev + 1 WHERE id = ?', [
      notice.html,
      notice.text,
      `${notice.from?.name || notice.from?.address || 'Someone'} sent you a private message.`,
      rawBlob,
      messageId,
    ]);
    indexMessage(messageId);
  });
}

/** The working link for a token, with its message's sender, subject and date. Expired, withdrawn and unknown tokens are all null. */
export function findLink(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return (
    get<LinkRow & { from_addr: string; from_name: string; subject: string; date: number }>(
      'SELECT p.*, m.from_addr, m.from_name, m.subject, m.date FROM private_links p JOIN messages m ON m.id = p.message_id WHERE p.token_hash = ? AND p.expires_at > ?',
      [sha256(token), now()],
    ) ?? null
  );
}

/** The working link of a message the user sent. */
export function ownLink(userId: number, messageId: number): LinkRow | null {
  return get<LinkRow>('SELECT * FROM private_links WHERE message_id = ? AND user_id = ? AND token_hash IS NOT NULL AND expires_at > ?', [messageId, userId, now()]) ?? null;
}

/** What the link shows: the message's body and attachments (without their storage keys). */
export async function linkContent(link: LinkRow): Promise<{ expiresAt: number; html: string | null; text: string | null; attachments: AttachmentInfo[] }> {
  await loadBody(link);
  const attachments = (JSON.parse(link.attachments) as StoredAttachment[]).map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    contentId: a.content_id,
    inline: !!a.inline,
  }));
  return { expiresAt: link.expires_at, html: link.html_body, text: link.text_body, attachments };
}

export function linkAttachment(link: LinkRow, id: number): StoredAttachment | undefined {
  return (JSON.parse(link.attachments) as StoredAttachment[]).find((a) => a.id === id);
}

/** The addresses the message went to (To, Cc and Bcc): the only ones a code is ever sent to. */
function recipientsOf(messageId: number): string[] {
  const m = get<{ to_json: string; cc_json: string; bcc_json: string }>('SELECT to_json, cc_json, bcc_json FROM messages WHERE id = ?', [messageId]);
  if (!m) return [];
  return [m.to_json, m.cc_json, m.bcc_json].flatMap((j) => (JSON.parse(j || '[]') as Addr[]).map((a) => normalizeEmail(a.address)));
}

/** The stored form of a code: keyed, and bound to its link and recipient, so a copy of the database can't be tried offline. */
const codeHash = (linkId: number, recipient: string, code: string) => hmac(`private-link-code:${linkId}:${recipient}:${code}`);

/**
 * Email a new one-time code to `email` if the message went to that address
 * (replacing any earlier one). Does nothing otherwise, and the caller answers
 * the same either way, so the link can't be used to find out who else got it.
 */
export async function sendLinkCode(link: LinkRow & { from_addr: string; from_name: string }, email: string) {
  const recipient = normalizeEmail(email);
  if (!recipientsOf(link.message_id).includes(recipient)) return;
  const code = randomDigits(6);
  tx(() => {
    run(`DELETE FROM private_link_access WHERE link_id = ? AND recipient = ? AND kind = 'code'`, [link.id, recipient]);
    run(`INSERT INTO private_link_access (link_id, recipient, kind, hash, expires_at) VALUES (?, ?, 'code', ?, ?)`, [
      link.id,
      recipient,
      codeHash(link.id, recipient, code),
      Math.min(now() + CODE_TTL, link.expires_at),
    ]);
  });
  const sender = escapeHtml(link.from_name || link.from_addr);
  await sendSystemEmail({
    to: [recipient],
    subject: 'Your code to open a private message',
    html: systemTemplate({
      title: 'Your code to open a private message',
      paragraphs: [
        `${sender} sent you a private message. To open it, enter this code on the page where you asked for it:`,
        `<b>${code}</b>`,
        'The code works once, for 10 minutes. If you didn’t try to open a private message, you can ignore this email: nobody can open it without the code.',
      ],
    }),
    userId: link.user_id,
  });
}

/** Check a code for `email`. Right: it's used up and a pass for this browser is returned (its cookie value). Wrong, expired or out of tries: null. */
export function verifyLinkCode(link: LinkRow, email: string, code: string): { pass: string; expiresAt: number } | null {
  const recipient = normalizeEmail(email);
  const row = get<{ id: number; hash: string }>(`SELECT id, hash FROM private_link_access WHERE link_id = ? AND recipient = ? AND kind = 'code' AND expires_at > ?`, [
    link.id,
    recipient,
    now(),
  ]);
  // The try counts before the comparison, so no number of guesses can get past the cap.
  if (!row || !run('UPDATE private_link_access SET attempts = attempts + 1 WHERE id = ? AND attempts < ?', [row.id, CODE_TRIES]).changes) return null;
  if (!safeEqual(row.hash, codeHash(link.id, recipient, code))) return null;
  const pass = randomToken(32);
  const expiresAt = Math.min(now() + PASS_TTL, link.expires_at);
  tx(() => {
    run('DELETE FROM private_link_access WHERE id = ?', [row.id]);
    run(`INSERT INTO private_link_access (link_id, recipient, kind, hash, expires_at) VALUES (?, ?, 'pass', ?, ?)`, [link.id, recipient, sha256(pass), expiresAt]);
  });
  return { pass, expiresAt };
}

/** This browser entered a code for this link, and its pass hasn't run out. */
export function hasPass(link: LinkRow, pass: string | undefined): boolean {
  return !!pass && !!get(`SELECT 1 FROM private_link_access WHERE link_id = ? AND kind = 'pass' AND hash = ? AND expires_at > ?`, [link.id, sha256(pass), now()]);
}

/** "Stop sharing now": the link stops working and its content is deleted. */
export function revokeLink(userId: number, messageId: number): boolean {
  // Only a made link: removing the mark from a message still waiting to go out would send its content in full.
  return run('DELETE FROM private_links WHERE message_id = ? AND user_id = ? AND token_hash IS NOT NULL', [messageId, userId]).changes > 0;
}

/** Expired links go with their content; blob garbage collection then removes the files. */
export function pruneLinks() {
  run('DELETE FROM private_links WHERE expires_at < ?', [now()]);
  run('DELETE FROM private_link_access WHERE expires_at < ?', [now()]);
}
