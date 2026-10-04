import type { Addr, Category, Folder } from '../../shared/types.js';
import { all, get, IN_LIST, insert, listParam, now, run, tx } from '../db/index.js';
import { putBlob } from './blobs.js';
import { bodyColumns } from './body.js';
import { makeSnippet, htmlToText, type ParsedAttachment } from './parse.js';

/** Strip reply/forward prefixes so "Re: Fwd: Hello" threads with "Hello". */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(re|fw|fwd|aw|wg|sv|vs|antw|ref|tr|rv|odp)(\s*\[\d+\])?\s*:\s*/i, '').trim();
  }
  return s.toLowerCase();
}

export function isReplySubject(subject: string): boolean {
  return /^(re|fw|fwd|aw|wg|sv|antw)(\s*\[\d+\])?\s*:/i.test(subject.trim());
}

/**
 * Find the conversation a message belongs to: first by Message-ID references,
 * then (for replies) by normalized subject + overlapping participants.
 */
export function findThread(
  userId: number,
  opts: { messageId: string | null; inReplyTo: string | null; references: string[]; subject: string; participants: string[] },
): number | null {
  const ids = [...new Set([opts.inReplyTo, ...opts.references].filter((x): x is string => !!x))];
  if (ids.length) {
    const row = get<{ thread_id: number }>(
      `SELECT thread_id FROM messages WHERE user_id = ? AND message_id IN ${IN_LIST} ORDER BY date DESC LIMIT 1`,
      [userId, listParam(ids)],
    );
    if (row) return row.thread_id;
  }
  // A message that arrived earlier may reference this one (out-of-order delivery).
  if (opts.messageId) {
    const row = get<{ thread_id: number }>(
      `SELECT thread_id FROM messages WHERE user_id = ? AND in_reply_to = ? LIMIT 1`,
      [userId, opts.messageId],
    );
    if (row) return row.thread_id;
  }
  // A reply whose references we don't know: the provider that sent our message may have
  // replaced its Message-ID (Resend and SES do). Match the subject of a recent message
  // (not the thread's stored subject, which a draft may have saved half-typed) plus a shared participant.
  if (isReplySubject(opts.subject) && opts.participants.length) {
    const norm = normalizeSubject(opts.subject);
    if (!norm) return null;
    const since = now() - 30 * 24 * 3600 * 1000;
    const recent = all<{ thread_id: number; subject: string }>(
      `SELECT thread_id, subject FROM messages WHERE user_id = ? AND date > ? ORDER BY date DESC LIMIT 1000`,
      [userId, since],
    );
    const candidates = [...new Set(recent.filter((m) => normalizeSubject(m.subject) === norm).map((m) => m.thread_id))].map((id) => ({ id }));
    for (const t of candidates) {
      const people = new Set(
        all<{ a: string | null }>(
          `SELECT from_addr AS a FROM messages WHERE thread_id = ?
           UNION SELECT json_extract(j.value, '$.address') FROM messages m, json_each(m.to_json) j WHERE m.thread_id = ?
           UNION SELECT json_extract(j.value, '$.address') FROM messages m, json_each(m.cc_json) j WHERE m.thread_id = ?`,
          [t.id, t.id, t.id],
        ).map((r) => (r.a ?? '').toLowerCase()),
      );
      if (opts.participants.some((p) => people.has(p.toLowerCase()))) return t.id;
    }
  }
  return null;
}

export interface StoreInput {
  userId: number;
  folder: Folder;
  direction: 'in' | 'out';
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc?: Addr[];
  replyTo: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  date: number;
  size: number;
  rawBlob: string | null;
  attachments: ParsedAttachment[];
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  status?: string;
  identity?: string | null;
  source?: string;
  spamScore?: number | null;
  authResults?: Record<string, string> | null;
  labelIds?: number[];
  threadId?: number | null;
  /** Incoming mail: which of the user's addresses it was delivered to. */
  deliveredTo?: string | null;
  category?: Category;
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
}

export async function storeMessage(input: StoreInput): Promise<number> {
  // Write attachment blobs before the transaction (storage I/O is async).
  const att: (ParsedAttachment & { blob: string })[] = [];
  for (const a of input.attachments) att.push({ ...a, blob: await putBlob(a.content) });
  const body = await bodyColumns(input.text, input.html);
  return tx(() => {
    // Participants other than the mailbox owner, used for subject-based threading.
    const own = new Set(
      all<{ address: string }>('SELECT address FROM addresses WHERE user_id = ?', [input.userId]).map((r) => r.address.toLowerCase()),
    );
    const participants = [input.from?.address, ...input.to.map((a) => a.address), ...input.cc.map((a) => a.address)].filter(
      (x): x is string => !!x && !own.has(x.toLowerCase()),
    );
    let threadId =
      input.threadId ??
      findThread(input.userId, {
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subject: input.subject,
        participants,
      });
    const ts = now();
    if (!threadId) {
      threadId = insert('INSERT INTO threads (user_id, subject, last_date, created_at) VALUES (?, ?, ?, ?)', [
        input.userId,
        input.subject,
        input.date,
        ts,
      ]);
    } else {
      run('UPDATE threads SET last_date = MAX(last_date, ?) WHERE id = ?', [input.date, threadId]);
    }
    const snippet = makeSnippet(input.text, input.html);
    const id = insert(
      `INSERT INTO messages (user_id, thread_id, folder, direction, message_id, in_reply_to, refs, from_addr, from_name,
        to_json, cc_json, bcc_json, reply_to, subject, snippet, text_body, html_body, body_blob, date, size, raw_blob, has_attachments,
        is_read, is_starred, is_important, status, identity, source, spam_score, auth_results, created_at,
        delivered_to, category, list_unsubscribe, list_unsubscribe_post)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        threadId,
        input.folder,
        input.direction,
        input.messageId,
        input.inReplyTo,
        input.references.join(' '),
        input.from?.address ?? '',
        input.from?.name ?? '',
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.bcc ?? []),
        input.replyTo,
        input.subject,
        snippet,
        body.text_body,
        body.html_body,
        body.body_blob,
        input.date,
        input.size,
        input.rawBlob,
        att.some((a) => !a.inline) ? 1 : 0,
        input.isRead ? 1 : 0,
        input.isStarred ? 1 : 0,
        input.isImportant ? 1 : 0,
        input.status ?? 'none',
        input.identity ?? null,
        input.source ?? null,
        input.spamScore ?? null,
        input.authResults ? JSON.stringify(input.authResults) : null,
        ts,
        input.deliveredTo ?? null,
        input.category ?? 'primary',
        input.listUnsubscribe?.slice(0, 2000) ?? null,
        input.listUnsubscribePost?.slice(0, 200) ?? null,
      ],
    );
    for (const a of att) {
      insert(
        `INSERT INTO attachments (user_id, message_id, filename, content_type, size, content_id, inline, blob, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, id, a.filename, a.contentType, a.size, a.contentId, a.inline ? 1 : 0, a.blob, ts],
      );
    }
    for (const labelId of input.labelIds ?? []) {
      run('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)', [id, labelId]);
    }
    indexMessage(id);
    const total = input.size || 0;
    run('UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?', [total, input.userId]);
    return id;
  });
}

/** (Re)build the full-text index entry for a message. */
export function indexMessage(id: number) {
  const m = get<any>('SELECT * FROM messages WHERE id = ?', [id]);
  if (!m) return;
  const recipients = [...JSON.parse(m.to_json), ...JSON.parse(m.cc_json), ...JSON.parse(m.bcc_json)]
    .map((a: Addr) => `${a.name ?? ''} ${a.address}`)
    .join(' ');
  const attNames = all<{ filename: string }>('SELECT filename FROM attachments WHERE message_id = ?', [id])
    .map((a) => a.filename)
    .join(' ');
  const body = `${m.text_body || (m.html_body ? htmlToText(m.html_body) : '')} ${attNames}`.slice(0, 200_000);
  run('DELETE FROM messages_fts WHERE rowid = ?', [id]);
  run('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)', [
    id,
    m.subject,
    `${m.from_name} ${m.from_addr}`,
    recipients,
    body,
  ]);
}

/** Permanently delete messages (and their now-empty threads). */
export function purgeMessages(ids: number[]) {
  if (!ids.length) return;
  tx(() => {
    for (const chunk of chunks(ids, 500)) {
      const rows = all<{ id: number; user_id: number; size: number; thread_id: number }>(
        `SELECT id, user_id, size, thread_id FROM messages WHERE id IN ${IN_LIST}`,
        [listParam(chunk)],
      );
      for (const r of rows) {
        run('DELETE FROM messages_fts WHERE rowid = ?', [r.id]);
        run('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?', [r.size, r.user_id]);
      }
      run(`DELETE FROM messages WHERE id IN ${IN_LIST}`, [listParam(chunk)]);
      const threads = [...new Set(rows.map((r) => r.thread_id))];
      for (const t of threads) {
        const left = get<{ c: number; d: number | null }>('SELECT COUNT(*) AS c, MAX(date) AS d FROM messages WHERE thread_id = ?', [t]);
        if (!left || left.c === 0) run('DELETE FROM threads WHERE id = ?', [t]);
        else run('UPDATE threads SET last_date = ? WHERE id = ?', [left.d, t]);
      }
    }
  });
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Record that a user corresponded with these addresses (for autocomplete). */
export function touchContacts(userId: number, addrs: Addr[]) {
  const ts = now();
  for (const a of addrs) {
    if (!a.address) continue;
    run(
      `INSERT INTO contacts (user_id, email, name, times_contacted, last_contacted_at, created_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, email) DO UPDATE SET
         times_contacted = times_contacted + 1,
         last_contacted_at = excluded.last_contacted_at,
         name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END`,
      [userId, a.address.toLowerCase(), a.name ?? '', ts, ts],
    );
  }
}
