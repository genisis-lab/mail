import type { Addr, AttachmentInfo, Folder, MessageDetail, ThreadDetail, ThreadSummary, View } from '../../shared/types.js';
import { all, get, now, placeholders, run, tx } from '../db/index.js';
import { userAddresses } from '../services/users.js';
import { buildSearch } from './search.js';
import { purgeMessages } from './store.js';

export const VIEWS: View[] = ['inbox', 'starred', 'snoozed', 'important', 'sent', 'scheduled', 'drafts', 'all', 'spam', 'trash'];

function viewCondition(view: View | undefined, ts: number): { sql: string; params: unknown[] } {
  switch (view) {
    case 'inbox':
      return { sql: `m.folder = 'inbox' AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)`, params: [ts] };
    case 'starred':
      return { sql: `m.is_starred = 1 AND m.folder NOT IN ('spam','trash')`, params: [] };
    case 'snoozed':
      return { sql: `m.snoozed_until > ? AND m.folder NOT IN ('spam','trash')`, params: [ts] };
    case 'important':
      return { sql: `m.is_important = 1 AND m.folder NOT IN ('spam','trash','drafts')`, params: [] };
    case 'sent':
      return { sql: `m.folder = 'sent' AND NOT (m.status = 'queued' AND m.is_scheduled = 1)`, params: [] };
    case 'scheduled':
      return { sql: `m.folder = 'sent' AND m.status = 'queued' AND m.is_scheduled = 1`, params: [] };
    case 'drafts':
      return { sql: `m.folder = 'drafts'`, params: [] };
    case 'spam':
      return { sql: `m.folder = 'spam'`, params: [] };
    case 'trash':
      return { sql: `m.folder = 'trash'`, params: [] };
    case 'all':
    default:
      return { sql: `m.folder NOT IN ('spam','trash','drafts')`, params: [] };
  }
}

export interface ListOptions {
  view?: View;
  labelId?: number;
  query?: string;
  page?: number;
  pageSize?: number;
}

interface SummaryRow {
  id: number;
  thread_id: number;
  folder: Folder;
  direction: 'in' | 'out';
  from_addr: string;
  from_name: string;
  to_json: string;
  subject: string;
  snippet: string;
  date: number;
  is_read: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  status: string;
  send_at: number | null;
  snoozed_until: number | null;
  labels: string | null;
}

export function listThreads(userId: number, opts: ListOptions): { threads: ThreadSummary[]; total: number; page: number; pageSize: number } {
  const ts = now();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 10), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where: string[] = ['m.user_id = ?'];
  const params: unknown[] = [userId];

  if (opts.query?.trim()) {
    const s = buildSearch(opts.query, userId, ts);
    where.push(...s.where);
    params.push(...s.params);
    if (!s.scoped) where.push(`m.folder NOT IN ('spam','trash')`);
  } else if (opts.labelId) {
    where.push(`EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?) AND m.folder NOT IN ('spam','trash')`);
    params.push(opts.labelId);
  } else {
    const v = viewCondition(opts.view ?? 'inbox', ts);
    where.push(v.sql);
    params.push(...v.params);
  }

  const whereSql = where.join(' AND ');
  const total = get<{ c: number }>(`SELECT COUNT(DISTINCT m.thread_id) AS c FROM messages m WHERE ${whereSql}`, params)?.c ?? 0;
  const pageRows = all<{ thread_id: number; last_date: number }>(
    `SELECT m.thread_id, MAX(MAX(m.date, COALESCE(m.woke_at, 0))) AS last_date FROM messages m WHERE ${whereSql}
     GROUP BY m.thread_id ORDER BY last_date DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  if (!pageRows.length) return { threads: [], total, page, pageSize };

  const threadIds = pageRows.map((r) => r.thread_id);
  // Messages of these threads that match the view (for unread/date/snippet)…
  const inView = new Set(
    all<{ id: number }>(`SELECT m.id FROM messages m WHERE ${whereSql} AND m.thread_id IN (${placeholders(threadIds.length)})`, [
      ...params,
      ...threadIds,
    ]).map((r) => r.id),
  );
  // …and every visible message of the threads (for counts/participants).
  const hideFolders = opts.view === 'trash' || opts.view === 'spam' ? [] : ['spam', 'trash'];
  const rows = all<SummaryRow>(
    `SELECT m.id, m.thread_id, m.folder, m.direction, m.from_addr, m.from_name, m.to_json, m.subject, m.snippet, m.date,
            m.is_read, m.is_starred, m.is_important, m.has_attachments, m.status, m.send_at, m.snoozed_until,
            (SELECT group_concat(label_id) FROM message_labels WHERE message_id = m.id) AS labels
       FROM messages m
      WHERE m.thread_id IN (${placeholders(threadIds.length)})
        ${hideFolders.length ? `AND (m.folder NOT IN ('spam','trash') OR m.id IN (${[...inView].join(',') || 0}))` : ''}
      ORDER BY m.date ASC`,
    threadIds,
  );
  const mine = new Set(userAddresses(userId));
  const byThread = new Map<number, SummaryRow[]>();
  for (const r of rows) byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r]);

  const recipientsView = opts.view === 'sent' || opts.view === 'drafts' || opts.view === 'scheduled';
  const threads: ThreadSummary[] = [];
  for (const { thread_id } of pageRows) {
    const msgs = byThread.get(thread_id) ?? [];
    const visible = msgs.filter((m) => m.folder !== 'drafts' || opts.view === 'drafts');
    const viewMsgs = msgs.filter((m) => inView.has(m.id));
    const latest = viewMsgs[viewMsgs.length - 1] ?? msgs[msgs.length - 1];
    if (!latest) continue;
    const first = visible[0] ?? latest;

    let participants: ThreadSummary['participants'] = [];
    if (recipientsView) {
      const to: Addr[] = JSON.parse(latest.to_json);
      participants = to.map((a) => ({ name: a.name || a.address, address: a.address, unread: false, me: mine.has(a.address.toLowerCase()) }));
    } else {
      const seen = new Map<string, ThreadSummary['participants'][number]>();
      for (const m of visible) {
        const me = m.direction === 'out' || mine.has(m.from_addr.toLowerCase());
        const key = me ? '__me' : m.from_addr.toLowerCase();
        const entry = seen.get(key) ?? { name: me ? 'me' : m.from_name || m.from_addr, address: m.from_addr, unread: false, me };
        if (!m.is_read && inView.has(m.id)) entry.unread = true;
        seen.delete(key);
        seen.set(key, entry);
      }
      participants = [...seen.values()];
    }
    const labelSet = new Set<number>();
    for (const m of msgs) for (const l of (m.labels ?? '').split(',').filter(Boolean)) labelSet.add(Number(l));

    threads.push({
      id: thread_id,
      subject: first.subject || latest.subject,
      snippet: latest.snippet,
      participants,
      count: visible.length || 1,
      unread: viewMsgs.some((m) => !m.is_read),
      starred: msgs.some((m) => m.is_starred),
      important: msgs.some((m) => m.is_important),
      hasAttachments: msgs.some((m) => m.has_attachments),
      date: latest.status === 'queued' && latest.send_at ? latest.send_at : latest.date,
      labels: [...labelSet],
      folders: [...new Set(msgs.map((m) => m.folder))],
      hasDraft: msgs.some((m) => m.folder === 'drafts'),
      status: latest.direction === 'out' ? latest.status : undefined,
      sendAt: latest.send_at,
      snoozedUntil: viewMsgs.find((m) => m.snoozed_until && m.snoozed_until > now())?.snoozed_until ?? null,
    });
  }
  return { threads, total, page, pageSize };
}

function attachmentsFor(messageIds: number[]): Map<number, AttachmentInfo[]> {
  const map = new Map<number, AttachmentInfo[]>();
  if (!messageIds.length) return map;
  for (const a of all<any>(
    `SELECT id, message_id, filename, content_type, size, content_id, inline FROM attachments WHERE message_id IN (${placeholders(messageIds.length)}) ORDER BY id`,
    messageIds,
  )) {
    const list = map.get(a.message_id) ?? [];
    list.push({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, contentId: a.content_id, inline: !!a.inline });
    map.set(a.message_id, list);
  }
  return map;
}

export function toDetail(r: any, atts: AttachmentInfo[], labels: number[]): MessageDetail {
  return {
    id: r.id,
    threadId: r.thread_id,
    folder: r.folder,
    direction: r.direction,
    messageId: r.message_id,
    from: { address: r.from_addr, name: r.from_name },
    to: JSON.parse(r.to_json),
    cc: JSON.parse(r.cc_json),
    bcc: JSON.parse(r.bcc_json),
    replyTo: r.reply_to,
    subject: r.subject,
    snippet: r.snippet,
    text: r.text_body,
    html: r.html_body,
    date: r.date,
    size: r.size,
    isRead: !!r.is_read,
    isStarred: !!r.is_starred,
    isImportant: !!r.is_important,
    status: r.status,
    sendAt: r.send_at,
    lastError: r.last_error,
    labels,
    attachments: atts,
    spamScore: r.spam_score,
    authResults: r.auth_results ? JSON.parse(r.auth_results) : null,
    inReplyTo: r.in_reply_to,
    references: r.refs,
    identity: r.identity,
  };
}

export function getMessage(userId: number, id: number): MessageDetail | null {
  const r = get<any>('SELECT * FROM messages WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) return null;
  const atts = attachmentsFor([id]).get(id) ?? [];
  const labels = all<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [id]).map((l) => l.label_id);
  return toDetail(r, atts, labels);
}

export function getThread(userId: number, threadId: number): ThreadDetail | null {
  const t = get<{ id: number; subject: string }>('SELECT id, subject FROM threads WHERE id = ? AND user_id = ?', [threadId, userId]);
  if (!t) return null;
  let rows = all<any>(`SELECT * FROM messages WHERE thread_id = ? AND folder NOT IN ('spam','trash') ORDER BY date ASC, id ASC`, [threadId]);
  if (!rows.length) rows = all<any>('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC, id ASC', [threadId]);
  const ids = rows.map((r) => r.id);
  const atts = attachmentsFor(ids);
  const labelRows = ids.length
    ? all<{ message_id: number; label_id: number }>(`SELECT message_id, label_id FROM message_labels WHERE message_id IN (${placeholders(ids.length)})`, ids)
    : [];
  const labelMap = new Map<number, number[]>();
  for (const l of labelRows) labelMap.set(l.message_id, [...(labelMap.get(l.message_id) ?? []), l.label_id]);
  const subject = rows.find((r) => r.folder !== 'drafts')?.subject ?? t.subject;
  return { id: t.id, subject, messages: rows.map((r) => toDetail(r, atts.get(r.id) ?? [], labelMap.get(r.id) ?? [])) };
}

// ── Actions ────────────────────────────────────────────────────────────────

export type ThreadAction =
  | { type: 'read' | 'unread' | 'star' | 'unstar' | 'important' | 'unimportant' | 'archive' | 'inbox' | 'trash' | 'untrash' | 'spam' | 'notspam' | 'delete' | 'unsnooze' }
  | { type: 'snooze'; until: number }
  | { type: 'label' | 'unlabel'; labelId: number };

/** Message ids a thread action applies to. Drafts are never moved by thread actions. */
function threadMessageIds(userId: number, threadIds: number[], extra = ''): number[] {
  if (!threadIds.length) return [];
  return all<{ id: number }>(
    `SELECT id FROM messages WHERE user_id = ? AND thread_id IN (${placeholders(threadIds.length)}) AND folder != 'drafts' ${extra}`,
    [userId, ...threadIds],
  ).map((r) => r.id);
}

export function applyThreadAction(userId: number, threadIds: number[], action: ThreadAction): number {
  return tx(() => {
    const ts = now();
    const ids = (extra = '') => threadMessageIds(userId, threadIds, extra);
    const upd = (sql: string, list: number[], ...p: unknown[]) => {
      if (!list.length) return 0;
      return run(`UPDATE messages SET ${sql} WHERE id IN (${placeholders(list.length)})`, [...p, ...list]).changes;
    };
    switch (action.type) {
      case 'read':
        return upd('is_read = 1', ids());
      case 'unread': {
        // Like Gmail: mark only the latest message of each thread unread.
        let n = 0;
        for (const t of threadIds) {
          const r = get<{ id: number }>(`SELECT id FROM messages WHERE thread_id = ? AND user_id = ? AND folder != 'drafts' ORDER BY date DESC LIMIT 1`, [t, userId]);
          if (r) n += upd('is_read = 0', [r.id]);
        }
        return n;
      }
      case 'star': {
        let n = 0;
        for (const t of threadIds) {
          const r = get<{ id: number }>(`SELECT id FROM messages WHERE thread_id = ? AND user_id = ? AND folder != 'drafts' ORDER BY date DESC LIMIT 1`, [t, userId]);
          if (r) n += upd('is_starred = 1', [r.id]);
        }
        return n;
      }
      case 'unstar':
        return upd('is_starred = 0', ids());
      case 'important':
        return upd('is_important = 1', ids());
      case 'unimportant':
        return upd('is_important = 0', ids());
      case 'archive':
        return upd(`folder = 'archive', snoozed_until = NULL`, ids(`AND folder = 'inbox'`));
      case 'inbox':
        return upd(`folder = 'inbox', trashed_at = NULL`, ids(`AND direction = 'in' AND folder IN ('archive','spam','trash')`));
      case 'trash':
        return upd(`folder = 'trash', trashed_at = ?, snoozed_until = NULL`, ids(`AND folder != 'trash'`), ts);
      case 'untrash': {
        const list = ids(`AND folder = 'trash'`);
        return upd(`folder = CASE WHEN direction = 'out' THEN 'sent' ELSE 'inbox' END, trashed_at = NULL`, list);
      }
      case 'spam':
        return upd(`folder = 'spam', snoozed_until = NULL`, ids(`AND direction = 'in'`));
      case 'notspam':
        return upd(`folder = 'inbox'`, ids(`AND folder = 'spam'`));
      case 'delete': {
        const list = ids(`AND folder IN ('trash','spam')`);
        purgeMessages(list);
        return list.length;
      }
      case 'snooze':
        if (!(action.until > ts)) return 0;
        return upd('snoozed_until = ?', ids(`AND folder IN ('inbox','archive')`), action.until);
      case 'unsnooze':
        return upd(`snoozed_until = NULL, folder = CASE WHEN folder = 'archive' THEN 'inbox' ELSE folder END`, ids(`AND snoozed_until IS NOT NULL`));
      case 'label':
      case 'unlabel': {
        if (!get('SELECT 1 FROM labels WHERE id = ? AND user_id = ?', [action.labelId, userId])) return 0;
        const list = ids();
        for (const id of list) {
          if (action.type === 'label') run('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)', [id, action.labelId]);
          else run('DELETE FROM message_labels WHERE message_id = ? AND label_id = ?', [id, action.labelId]);
        }
        return list.length;
      }
    }
    return 0;
  });
}

/** Per-view counters for the sidebar. */
export function counters(userId: number) {
  const ts = now();
  const c = get<any>(
    `SELECT
       COUNT(DISTINCT CASE WHEN folder = 'inbox' AND is_read = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN thread_id END) AS inbox,
       COUNT(DISTINCT CASE WHEN folder = 'spam' AND is_read = 0 THEN thread_id END) AS spam,
       COUNT(CASE WHEN folder = 'drafts' THEN 1 END) AS drafts,
       COUNT(DISTINCT CASE WHEN folder = 'sent' AND status = 'queued' AND is_scheduled = 1 THEN thread_id END) AS scheduled,
       COUNT(DISTINCT CASE WHEN snoozed_until > ? AND folder NOT IN ('spam','trash') THEN thread_id END) AS snoozed,
       COUNT(DISTINCT CASE WHEN is_starred = 1 AND is_read = 0 AND folder NOT IN ('spam','trash') THEN thread_id END) AS starred,
       COUNT(DISTINCT CASE WHEN is_important = 1 AND is_read = 0 AND folder NOT IN ('spam','trash','drafts') THEN thread_id END) AS important
     FROM messages WHERE user_id = ?`,
    [ts, ts, userId],
  );
  const labels = all<{ id: number; unread: number; total: number }>(
    `SELECT l.id,
            COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unread,
            COUNT(DISTINCT m.thread_id) AS total
       FROM labels l
       LEFT JOIN message_labels ml ON ml.label_id = l.id
       LEFT JOIN messages m ON m.id = ml.message_id AND m.folder NOT IN ('spam','trash')
      WHERE l.user_id = ? GROUP BY l.id`,
    [userId],
  );
  return { ...c, labels };
}

/** Wake snoozed messages whose time has come: back to the inbox, unread, on top. */
export function wakeSnoozed(): number {
  const ts = now();
  const rows = all<{ id: number; thread_id: number }>('SELECT id, thread_id FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?', [ts]);
  if (!rows.length) return 0;
  tx(() => {
    for (const r of rows) {
      run(`UPDATE messages SET snoozed_until = NULL, is_read = 0, woke_at = ?, folder = CASE WHEN folder = 'archive' THEN 'inbox' ELSE folder END WHERE id = ?`, [
        ts,
        r.id,
      ]);
      run('UPDATE threads SET last_date = ? WHERE id = ?', [ts, r.thread_id]);
    }
  });
  return rows.length;
}
