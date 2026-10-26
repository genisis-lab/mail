import type { Addr } from '../../shared/types.js';
import { all, get, insert, now, run, tx } from '../db/index.js';
import { isEmail, parseAddresses, uniqueAddrs } from '../lib/addr.js';
import { badRequest, notFound, tooMany } from '../lib/http.js';
import { getSettings } from '../settings.js';
import { getPrefs, getUser, identities, sendLimit, sentToday, userAddresses } from '../services/users.js';
import { guardSend } from '../services/send-guard.js';
import { getBlob, putBlob } from './blobs.js';
import { bodyColumns, loadBody } from './body.js';
import { buildMime, quoteHtml, escapeHtml } from './compose.js';
import { cancelOutbox, enqueue } from './outbound.js';
import { htmlToText, makeSnippet } from './parse.js';
import { isPrivate, linkMade, setPrivate } from './private.js';
import { indexMessage, touchContacts } from './store.js';
import { getMessage } from './threads.js';

export interface DraftInput {
  id?: number | null;
  from?: string;
  to?: string | Addr[];
  cc?: string | Addr[];
  bcc?: string | Addr[];
  subject?: string;
  html?: string;
  /** Plain text only, sent exactly as written (PGP-encrypted or signed text); `html` is ignored. */
  text?: string;
  /** Browser compose preference; signing itself happens only in the browser. */
  pgpSign?: boolean;
  attachments?: number[];
  /** db id of the message being replied to / forwarded */
  replyToId?: number | null;
  forwardOfId?: number | null;
  /** Send as a private link that works for this many days (null: a normal message). Web compose only. */
  privateDays?: number | null;
}

function addrList(v: string | Addr[] | undefined): Addr[] {
  return uniqueAddrs(parseAddresses(v ?? []));
}

function pickIdentity(userId: number, from: string | undefined): { address: string; name: string } {
  const ids = identities(userId);
  if (!ids.length) throw badRequest('You have no address you can send from. Ask an administrator to check your domain.');
  if (from) {
    const parsed = parseAddresses(from)[0];
    const hit = parsed && ids.find((i) => i.address.toLowerCase() === parsed.address.toLowerCase());
    if (!hit) throw badRequest(`You can't send as ${from}`);
    return { address: hit.address, name: parsed.name || hit.name };
  }
  const prefs = getPrefs(userId);
  const def = ids.find((i) => i.address === prefs.defaultFrom) ?? ids[0];
  return { address: def.address, name: def.name };
}

/** Attach uploaded files (or copies of another message's attachments) to a draft. */
function linkAttachments(userId: number, draftId: number, ids: number[]) {
  const keep = new Set<number>();
  for (const id of ids) {
    const a = get<any>('SELECT * FROM attachments WHERE id = ? AND user_id = ?', [id, userId]);
    if (!a) continue;
    if (a.message_id === null || a.message_id === draftId) {
      run('UPDATE attachments SET message_id = ? WHERE id = ?', [draftId, id]);
      keep.add(id);
    } else {
      const copy = insert(
        `INSERT INTO attachments (user_id, message_id, filename, content_type, size, content_id, inline, blob, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, draftId, a.filename, a.content_type, a.size, a.content_id, a.inline, a.blob, now()],
      );
      keep.add(copy);
    }
  }
  const existing = all<{ id: number }>('SELECT id FROM attachments WHERE message_id = ?', [draftId]);
  for (const e of existing) if (!keep.has(e.id)) run('DELETE FROM attachments WHERE id = ?', [e.id]);
  run('UPDATE messages SET has_attachments = (SELECT COUNT(*) > 0 FROM attachments WHERE message_id = ? AND inline = 0) WHERE id = ?', [draftId, draftId]);
}

/** Create or update a draft. Returns the draft's message id. */
export async function saveDraft(userId: number, input: DraftInput): Promise<number> {
  if (input.id) {
    const existing = get<any>('SELECT * FROM messages WHERE id = ? AND user_id = ?', [input.id, userId]);
    if (!existing) throw notFound('Draft not found');
    if (existing.folder !== 'drafts') throw badRequest('This message is no longer a draft');
    // Also reject stale clients that previously obtained only a search prefix.
    await loadBody(existing);
  }
  const from = pickIdentity(userId, input.from);
  const to = addrList(input.to);
  const cc = addrList(input.cc);
  const bcc = addrList(input.bcc);
  const subject = (input.subject ?? '').slice(0, 998);
  const html = input.text !== undefined ? '' : (input.html ?? '');
  const text = input.text ?? htmlToText(html);
  const ts = now();
  const body = await bodyColumns(text, html);

  return tx(() => {
    let draftId = input.id ?? null;
    if (draftId) {
      const d = get<{ id: number; folder: string }>('SELECT id, folder FROM messages WHERE id = ? AND user_id = ?', [draftId, userId]);
      if (!d) throw notFound('Draft not found');
      if (d.folder !== 'drafts') throw badRequest('This message is no longer a draft');
      run(
        `UPDATE messages SET from_addr = ?, from_name = ?, identity = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?,
           html_body = ?, text_body = ?, body_blob = ?, snippet = ?, date = ?, size = ?, jmap_rev = jmap_rev + 1 WHERE id = ?`,
        [from.address, from.name, from.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, body.html_body, body.text_body, body.body_blob, makeSnippet(text, null), ts, (html || text).length, draftId],
      );
      // A new conversation takes its subject from the draft as it's finished, not as first autosaved.
      run('UPDATE threads SET subject = ? WHERE id = (SELECT thread_id FROM messages WHERE id = ?) AND (SELECT COUNT(*) FROM messages WHERE thread_id = threads.id) = 1', [
        subject,
        draftId,
      ]);
    } else {
      // Thread the draft with the message it replies to / forwards.
      let threadId: number | null = null;
      let inReplyTo: string | null = null;
      let refs = '';
      const ref = input.replyToId ?? input.forwardOfId;
      if (ref) {
        const orig = get<{ thread_id: number; message_id: string | null; refs: string }>('SELECT thread_id, message_id, refs FROM messages WHERE id = ? AND user_id = ?', [
          ref,
          userId,
        ]);
        if (orig) {
          threadId = orig.thread_id;
          if (input.replyToId) {
            inReplyTo = orig.message_id;
            refs = [orig.refs, orig.message_id].filter(Boolean).join(' ').trim();
          }
        }
      }
      if (!threadId) {
        threadId = insert('INSERT INTO threads (user_id, subject, last_date, created_at) VALUES (?, ?, ?, ?)', [userId, subject, ts, ts]);
      }
      draftId = insert(
        `INSERT INTO messages (user_id, thread_id, folder, direction, from_addr, from_name, identity, to_json, cc_json, bcc_json, subject, snippet,
           text_body, html_body, body_blob, date, size, is_read, status, in_reply_to, refs, created_at)
         VALUES (?, ?, 'drafts', 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?)`,
        [userId, threadId, from.address, from.name, from.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, makeSnippet(text, null), body.text_body, body.html_body, body.body_blob, ts, (html || text).length, inReplyTo, refs, ts],
      );
    }
    if (input.attachments) linkAttachments(userId, draftId, input.attachments);
    if (input.pgpSign !== undefined) run('UPDATE messages SET pgp_sign = ? WHERE id = ?', [input.pgpSign ? 1 : 0, draftId]);
    if (input.privateDays !== undefined) setPrivate(userId, draftId, input.privateDays);
    indexMessage(draftId);
    return draftId;
  });
}

export function deleteDraft(userId: number, id: number) {
  const d = get<{ thread_id: number }>(`SELECT thread_id FROM messages WHERE id = ? AND user_id = ? AND folder = 'drafts'`, [id, userId]);
  if (!d) throw notFound('Draft not found');
  tx(() => {
    run('DELETE FROM messages_fts WHERE rowid = ?', [id]);
    run('DELETE FROM messages WHERE id = ?', [id]);
    if (!get('SELECT 1 FROM messages WHERE thread_id = ?', [d.thread_id])) run('DELETE FROM threads WHERE id = ?', [d.thread_id]);
  });
}

export interface SendOptions {
  /** Absolute time for scheduled send. */
  sendAt?: number | null;
  /** Override the user's undo-send delay (API sends use 0). */
  undoSeconds?: number;
  kind?: 'user' | 'api';
  /** Person who pressed Send (differs from the mailbox owner in shared mailboxes). */
  sentBy?: number;
  /** An iCalendar part to send with it (a meeting reply). */
  calendar?: { method: string; content: string };
}

/** Turn a draft into a queued outgoing message. */
export async function sendDraft(userId: number, draftId: number, opts: SendOptions = {}): Promise<{ id: number; sendAt: number; undoUntil: number | null }> {
  const user = getUser(userId);
  if (!user || user.status !== 'active') throw badRequest('Account is not active');
  // Sending paused, or about to be (an hourly burst, many bounces): the mailbox and whoever pressed Send.
  await guardSend([userId, opts.sentBy ?? userId]);
  const d = get<any>(`SELECT * FROM messages WHERE id = ? AND user_id = ? AND folder = 'drafts'`, [draftId, userId]);
  if (!d) throw notFound('Draft not found');
  await loadBody(d);

  const to: Addr[] = JSON.parse(d.to_json);
  const cc: Addr[] = JSON.parse(d.cc_json);
  const bcc: Addr[] = JSON.parse(d.bcc_json);
  const all_ = [...to, ...cc, ...bcc];
  if (!all_.length) throw badRequest('Add at least one recipient');
  const bad = all_.find((a) => !isEmail(a.address));
  if (bad) throw badRequest(`Invalid address: ${bad.address}`);
  const s = getSettings();
  if (all_.length > s['limits.maxRecipients']) throw badRequest(`Too many recipients (max ${s['limits.maxRecipients']})`);
  if (sentToday(userId) >= sendLimit(user)) throw tooMany('Daily sending limit reached. Try again later.');

  const from = pickIdentity(userId, d.identity || d.from_addr);
  const atts = all<any>('SELECT * FROM attachments WHERE message_id = ? ORDER BY id', [draftId]);
  const totalSize = atts.reduce((n: number, a: any) => n + a.size, 0);
  if (totalSize > s['limits.maxAttachmentMb'] * 1024 * 1024) throw badRequest(`Attachments exceed ${s['limits.maxAttachmentMb']} MB`);

  const refs: string[] = (d.refs || '').split(/\s+/).filter(Boolean);
  // A private message's content never enters the outbox: it's replaced by the notice as it goes out (private.ts).
  const priv = isPrivate(draftId);
  const { raw, messageId } = await buildMime({
    // Drafts made by a mail app (JMAP) already have their Message-ID.
    messageId: d.message_id || undefined,
    from,
    to,
    cc,
    bcc,
    subject: d.subject,
    // A plain-text draft (encrypted or signed) goes out as text/plain alone. The editor's own
    // class names (quote, forward, signature) stay behind: they'd say which software wrote it.
    html: priv ? '<p></p>' : d.html_body?.replace(/ class="wren-(?:quote|forward|signature)"/g, '') || (d.text_body ? null : '<p></p>'),
    text: priv ? '' : d.text_body,
    inReplyTo: d.in_reply_to,
    references: refs,
    calendar: opts.calendar,
    attachments: await Promise.all(
      (priv ? [] : atts).map(async (a: any) => ({
        filename: a.filename,
        contentType: a.content_type,
        content: await getBlob(a.blob),
        contentId: a.content_id,
        inline: !!a.inline,
      })),
    ),
  });
  const rawBlob = await putBlob(raw);
  const ts = now();
  const undo = opts.undoSeconds ?? getPrefs(opts.sentBy ?? userId).undoSendSeconds;
  const scheduled = !!opts.sendAt && opts.sendAt > ts + 30_000;
  const sendAt = scheduled ? opts.sendAt! : ts + Math.max(0, Math.min(undo, 30)) * 1000;

  tx(() => {
    run(
      `UPDATE messages SET folder = 'sent', status = 'queued', message_id = ?, raw_blob = ?, size = ?, date = ?, send_at = ?,
         is_scheduled = ?, from_addr = ?, from_name = ?, last_error = NULL, sent_by = ? WHERE id = ?`,
      [messageId, rawBlob, raw.length, scheduled ? sendAt : ts, sendAt, scheduled ? 1 : 0, from.address, from.name, opts.sentBy ?? userId, draftId],
    );
    // A reply to a thread that is otherwise only a draft keeps the thread subject in sync.
    run('UPDATE threads SET last_date = MAX(last_date, ?) WHERE id = ?', [ts, d.thread_id]);
    // Following up yourself answers a "no reply yet" nudge.
    run('UPDATE messages SET nudged_at = NULL WHERE thread_id = ? AND nudged_at IS NOT NULL', [d.thread_id]);
    // The message this answers is marked answered (the $answered keyword mail apps show).
    if (d.in_reply_to) addKeyword(userId, d.in_reply_to, '$answered');
    run('UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?', [raw.length, userId]);
    enqueue({
      kind: opts.kind ?? 'user',
      userId,
      messageId: draftId,
      mailFrom: from.address,
      recipients: all_.map((a) => a.address),
      rawBlob,
      subject: d.subject,
      sendAt,
    });
  });
  touchContacts(userId, all_);
  return { id: draftId, sendAt, undoUntil: scheduled ? null : sendAt };
}

/** Add a JMAP keyword (see src/server/jmap) to the user's messages with this Message-ID. */
function addKeyword(userId: number, messageId: string, keyword: string) {
  run(
    `UPDATE messages SET keywords = json_insert(COALESCE(keywords, '[]'), '$[#]', ?)
      WHERE user_id = ? AND message_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(messages.keywords, '[]')) WHERE value = ?)`,
    [keyword, userId, messageId, keyword],
  );
}

/** Undo send / cancel a scheduled message: turns it back into a draft. */
export function cancelSend(userId: number, messageId: number): boolean {
  const m = get<{ id: number; status: string; size: number }>(`SELECT id, status, size FROM messages WHERE id = ? AND user_id = ? AND folder = 'sent'`, [messageId, userId]);
  if (!m || m.status !== 'queued') return false;
  // A private message being retried already has its link (and someone may have it).
  if (linkMade(messageId) || !cancelOutbox(messageId)) return false;
  run(
    `UPDATE messages SET folder = 'drafts', status = 'draft', send_at = NULL, is_scheduled = 0, raw_blob = NULL, message_id = NULL WHERE id = ?`,
    [messageId],
  );
  run('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?', [m.size, userId]);
  return true;
}

/** Send now: skip what's left of the undo-send wait. False once it was undone (or for a scheduled send). */
export function sendNow(userId: number, messageId: number): boolean {
  const m = get<{ status: string }>(`SELECT status FROM messages WHERE id = ? AND user_id = ? AND folder = 'sent' AND is_scheduled = 0`, [messageId, userId]);
  if (!m) return false;
  if (m.status !== 'queued') return true; // already on its way
  const ts = now();
  // A first attempt only: a retry keeps its backoff.
  run(`UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE message_id = ? AND status = 'queued' AND attempts = 0 AND next_attempt_at > ?`, [ts, ts, messageId, ts]);
  run(`UPDATE messages SET send_at = MIN(send_at, ?) WHERE id = ? AND status = 'queued'`, [ts, messageId]);
  return true;
}

/** Prefilled compose fields for reply / reply-all / forward. Nothing is saved yet. */
export async function composeTemplate(userId: number, messageId: number, mode: 'reply' | 'replyAll' | 'forward') {
  const m = await getMessage(userId, messageId);
  if (!m) throw notFound('Message not found');
  const mine = new Set(userAddresses(userId));
  const ids = identities(userId);
  const prefs = getPrefs(userId);

  // Reply from whichever of my addresses the message was sent to.
  const recipientsOfOrig = [...m.to, ...m.cc].map((a) => a.address.toLowerCase());
  const via = ids.find((i) => recipientsOfOrig.includes(i.address.toLowerCase())) ?? ids.find((i) => i.address === m.identity);
  const from = via?.address ?? (ids.find((i) => i.address === prefs.defaultFrom) ?? ids[0])?.address ?? '';

  let to: Addr[] = [];
  let cc: Addr[] = [];
  if (mode !== 'forward') {
    // My own message (sent, or the copy of a note to myself that arrived): reply to whoever it went to, like Gmail.
    const ownMessage = m.direction === 'out' || mine.has(m.from.address.toLowerCase());
    if (ownMessage) {
      to = m.to;
      if (mode === 'replyAll') cc = m.cc;
    } else {
      const replyTo = m.replyTo ? parseAddresses(m.replyTo) : [m.from];
      to = replyTo;
      if (mode === 'replyAll') {
        const others = [...m.to, ...m.cc].filter((a) => !mine.has(a.address.toLowerCase()));
        cc = others.filter((a) => !to.some((t) => t.address.toLowerCase() === a.address.toLowerCase()));
      }
    }
    to = uniqueAddrs(to.filter((a) => !mine.has(a.address.toLowerCase()) || ownMessage));
    // Never leave To empty (say Reply-To pointed back at me): answer the sender.
    if (!to.length) to = [m.from];
    cc = uniqueAddrs(cc.filter((a) => !to.some((t) => t.address.toLowerCase() === a.address.toLowerCase())));
  }

  const subject = mode === 'forward' ? `Fwd: ${m.subject}` : /^re\s*:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;

  let html: string;
  if (mode === 'forward') {
    const hdr = [
      `---------- Forwarded message ---------`,
      `From: ${escapeHtml(m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address)}`,
      `Date: ${new Date(m.date).toUTCString()}`,
      `Subject: ${escapeHtml(m.subject)}`,
      `To: ${escapeHtml(m.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '))}`,
      m.cc.length ? `Cc: ${escapeHtml(m.cc.map((a) => a.address).join(', '))}` : '',
    ]
      .filter(Boolean)
      .join('<br>');
    const body = m.html ?? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(m.text ?? '')}</pre>`;
    html = `<p><br></p><div class="wren-forward">${hdr}<br><br>${body}</div>`;
  } else {
    html = `<p><br></p>${quoteHtml({ html: m.html, text: m.text, from: m.from, date: m.date })}`;
  }

  return {
    from,
    to,
    cc,
    bcc: [] as Addr[],
    subject,
    html,
    attachments: mode === 'forward' ? m.attachments : [],
    replyToId: mode === 'forward' ? null : m.id,
    forwardOfId: mode === 'forward' ? m.id : null,
    threadId: m.threadId,
  };
}

/** Store an uploaded file as an unattached attachment owned by the user. */
export async function storeUpload(userId: number, file: { filename: string; contentType: string; content: Buffer; inline?: boolean; contentId?: string | null }) {
  const s = getSettings();
  if (file.content.length > s['limits.maxAttachmentMb'] * 1024 * 1024) throw badRequest(`File exceeds ${s['limits.maxAttachmentMb']} MB`);
  const blob = await putBlob(file.content);
  const id = insert(
    `INSERT INTO attachments (user_id, message_id, filename, content_type, size, content_id, inline, blob, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, file.filename.slice(0, 255) || 'file', file.contentType || 'application/octet-stream', file.content.length, file.contentId ?? null, file.inline ? 1 : 0, blob, now()],
  );
  return { id, filename: file.filename, contentType: file.contentType, size: file.content.length, contentId: file.contentId ?? null, inline: !!file.inline };
}

/** Simple programmatic send used by the HTTP API (API keys). */
export async function sendDirect(
  userId: number,
  input: { from?: string; to: string | Addr[]; cc?: string | Addr[]; bcc?: string | Addr[]; subject: string; html?: string; text?: string },
) {
  const html = input.html ?? (input.text ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(input.text)}</pre>` : '');
  const id = await saveDraft(userId, { from: input.from, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, html });
  run(`UPDATE messages SET source = 'api' WHERE id = ?`, [id]);
  return sendDraft(userId, id, { undoSeconds: 0, kind: 'api' });
}
