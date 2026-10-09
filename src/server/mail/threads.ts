import type { Addr, AttachmentInfo, Category, Folder, MessageDetail, ThreadDetail, ThreadSummary, View } from '../../shared/types.js';
import { all, get, IN_LIST, listParam, now, run, tx } from '../db/index.js';
import { userAddresses } from '../services/users.js';
import { loadBody } from './body.js';
import { findParcel, parcelFor, parcelRows, readFacts, type ParcelRow } from './parcel.js';
import { proxiedImage, signedImages } from '../services/image-proxy.js';
import { buildSearch } from './search.js';
import { purgeMessages } from './store.js';

export const VIEWS: View[] = ['inbox', 'starred', 'snoozed', 'important', 'sent', 'scheduled', 'drafts', 'all', 'spam', 'trash'];

function viewCondition(view: View | undefined, ts: number): { sql: string; params: unknown[] } {
  switch (view) {
    case 'inbox':
      // Plus sent messages nudged back because nobody replied ("remind me if no reply").
      return { sql: `((m.folder = 'inbox' AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)) OR (m.folder = 'sent' AND m.nudged_at IS NOT NULL))`, params: [ts] };
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
  /** Inbox only: one tab (Primary, Updates, Promotions). */
  category?: Category;
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
  delivered_to: string | null;
  category: Category;
  otp: string | null;
  nudged_at: number | null;
  parcel: string | null;
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
    if ((opts.view ?? 'inbox') === 'inbox' && opts.category) {
      where.push('m.category = ?');
      params.push(opts.category);
    }
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
    all<{ id: number }>(`SELECT m.id FROM messages m WHERE ${whereSql} AND m.thread_id IN ${IN_LIST}`, [
      ...params,
      listParam(threadIds),
    ]).map((r) => r.id),
  );
  // …and every visible message of the threads (for counts/participants).
  const hideFolders = opts.view === 'trash' || opts.view === 'spam' ? [] : ['spam', 'trash'];
  const rows = all<SummaryRow>(
    `SELECT m.id, m.thread_id, m.folder, m.direction, m.from_addr, m.from_name, m.to_json, m.subject, m.snippet, m.date,
            m.is_read, m.is_starred, m.is_important, m.has_attachments, m.status, m.send_at, m.snoozed_until, m.delivered_to, m.category, m.otp, m.nudged_at, m.parcel,
            (SELECT group_concat(label_id) FROM message_labels WHERE message_id = m.id) AS labels
       FROM messages m
      WHERE m.thread_id IN ${IN_LIST}
        ${hideFolders.length ? `AND (m.folder NOT IN ('spam','trash') OR m.id IN ${IN_LIST})` : ''}
      ORDER BY m.date ASC`,
    hideFolders.length ? [listParam(threadIds), listParam([...inView])] : [listParam(threadIds)],
  );
  const mine = new Set(userAddresses(userId));
  const primary = (get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])?.email ?? '').toLowerCase();
  const byThread = new Map<number, SummaryRow[]>();
  for (const r of rows) byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r]);

  const recipientsView = opts.view === 'sent' || opts.view === 'drafts' || opts.view === 'scheduled';
  const muted = new Set(
    all<{ id: number }>(`SELECT id FROM threads WHERE muted = 1 AND id IN ${IN_LIST}`, [listParam(threadIds)]).map((r) => r.id),
  );
  const codeSince = ts - 24 * 3600_000;
  // Loaded once, and only when a conversation on this page is about a package.
  let parcels: ParcelRow[] | null = null;
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
    const lastIn = [...viewMsgs].reverse().find((m) => m.direction === 'in') ?? [...visible].reverse().find((m) => m.direction === 'in');
    const via = lastIn?.delivered_to && lastIn.delivered_to.toLowerCase() !== primary ? lastIn.delivered_to : null;
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
      category: latest.category ?? 'primary',
      via,
      // Codes expire quickly: only offer recent ones in the list.
      code: [...viewMsgs].reverse().find((m) => m.direction === 'in' && m.otp && m.date > codeSince)?.otp ?? null,
      muted: muted.has(thread_id),
      nudge: (() => {
        const n = msgs.find((m) => m.nudged_at);
        return n ? { sentAt: n.date } : null;
      })(),
      parcel: (() => {
        const seed = [...visible].reverse().find((m) => m.direction === 'in' && m.parcel && m.folder !== 'spam' && m.folder !== 'trash');
        const facts = readFacts(seed?.parcel);
        if (!seed || !facts) return null;
        const p = parcelFor((parcels ??= parcelRows(userId)), { id: seed.id, date: seed.date, facts });
        return p && { status: p.status, statusAt: p.statusAt, eta: p.eta };
      })(),
    });
  }
  return { threads, total, page, pageSize };
}

function attachmentsFor(messageIds: number[]): Map<number, AttachmentInfo[]> {
  const map = new Map<number, AttachmentInfo[]>();
  if (!messageIds.length) return map;
  for (const a of all<any>(
    `SELECT id, message_id, filename, content_type, size, content_id, inline FROM attachments WHERE message_id IN ${IN_LIST} ORDER BY id`,
    [listParam(messageIds)],
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
    // In a shared mailbox, who on the team sent this.
    sentBy: r.sent_by && r.sent_by !== r.user_id && r.sent_by_email ? { name: r.sent_by_name ?? '', email: r.sent_by_email } : null,
    deliveredTo: r.delivered_to ?? null,
    category: r.category ?? 'primary',
    canUnsubscribe: r.direction === 'in' && !!r.list_unsubscribe && /<(https:|mailto:)/i.test(r.list_unsubscribe),
    unsubscribed: !!r.unsubscribed,
    hasInvite: atts.some((a) => /^(text\/calendar|application\/ics)\b/i.test(a.contentType) || /\.ics$/i.test(a.filename)),
    rsvp: r.rsvp ?? null,
    code: r.direction === 'in' ? r.otp ?? null : null,
    spoofWarning: spoofed(r),
    images: signedImages(r.html_body),
  };
}

/**
 * Mail that claims to come from one of this server's own domains, arrived from
 * outside, and failed every authentication check the receiving side reported.
 * No reported results means no warning (nothing to judge by).
 */
function spoofed(r: any): boolean {
  if (r.direction !== 'in' || ['local', 'system', 'import'].includes(r.source ?? '')) return false;
  const auth = r.auth_results ? (JSON.parse(r.auth_results) as Record<string, string>) : null;
  if (!auth || !['spf', 'dkim', 'dmarc'].some((k) => auth[k])) return false;
  if (['spf', 'dkim', 'dmarc'].some((k) => auth[k] === 'pass')) return false;
  const domain = String(r.from_addr ?? '').split('@')[1]?.toLowerCase();
  return !!domain && !!get('SELECT 1 FROM domains WHERE name = ?', [domain]);
}

export async function getMessage(userId: number, id: number): Promise<MessageDetail | null> {
  const r = get<any>('SELECT m.*, (SELECT 1 FROM unsubscribes us WHERE us.user_id = m.user_id AND us.sender = m.from_addr) AS unsubscribed FROM messages m WHERE m.id = ? AND m.user_id = ?', [
    id,
    userId,
  ]);
  if (!r) return null;
  await loadBody(r);
  const atts = attachmentsFor([id]).get(id) ?? [];
  const labels = all<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [id]).map((l) => l.label_id);
  return toDetail(r, atts, labels);
}

export async function getThread(userId: number, threadId: number): Promise<ThreadDetail | null> {
  const t = get<{ id: number; subject: string; muted: number; follow_up_at: number | null }>('SELECT id, subject, muted, follow_up_at FROM threads WHERE id = ? AND user_id = ?', [threadId, userId]);
  if (!t) return null;
  const cols =
    'm.*, sb.name AS sent_by_name, sb.email AS sent_by_email, (SELECT 1 FROM unsubscribes us WHERE us.user_id = m.user_id AND us.sender = m.from_addr) AS unsubscribed FROM messages m LEFT JOIN users sb ON sb.id = m.sent_by';
  let rows = all<any>(`SELECT ${cols} WHERE m.thread_id = ? AND m.folder NOT IN ('spam','trash') ORDER BY m.date ASC, m.id ASC`, [threadId]);
  if (!rows.length) rows = all<any>(`SELECT ${cols} WHERE m.thread_id = ? ORDER BY m.date ASC, m.id ASC`, [threadId]);
  for (const r of rows) await loadBody(r);
  // Mail from before package cards is looked at the first time it's opened.
  for (const r of rows) {
    if (r.parcel !== null || r.direction !== 'in' || r.folder === 'drafts') continue;
    const auth = r.auth_results ? (JSON.parse(r.auth_results) as Record<string, string>) : null;
    const facts = auth?.dmarc === 'fail' ? null : findParcel({ subject: r.subject, text: r.text_body, html: r.html_body, from: { address: r.from_addr, name: r.from_name }, date: r.date });
    r.parcel = facts ? JSON.stringify(facts) : '';
    run('UPDATE messages SET parcel = ? WHERE id = ?', [r.parcel, r.id]);
  }
  const parcelSeed = [...rows].reverse().find((r) => r.direction === 'in' && r.parcel && r.folder !== 'spam' && r.folder !== 'drafts');
  const parcelFacts = readFacts(parcelSeed?.parcel);
  const ids = rows.map((r) => r.id);
  const atts = attachmentsFor(ids);
  const labelRows = ids.length
    ? all<{ message_id: number; label_id: number }>(`SELECT message_id, label_id FROM message_labels WHERE message_id IN ${IN_LIST}`, [listParam(ids)])
    : [];
  const labelMap = new Map<number, number[]>();
  for (const l of labelRows) labelMap.set(l.message_id, [...(labelMap.get(l.message_id) ?? []), l.label_id]);
  const subject = rows.find((r) => r.folder !== 'drafts')?.subject ?? t.subject;
  return {
    id: t.id,
    subject,
    messages: rows.map((r) => toDetail(r, atts.get(r.id) ?? [], labelMap.get(r.id) ?? [])),
    muted: !!t.muted,
    followUpAt: t.follow_up_at,
    nudged: rows.some((r) => r.nudged_at),
    parcel: (() => {
      const p = parcelSeed && parcelFacts ? parcelFor(parcelRows(userId), { id: parcelSeed.id, date: parcelSeed.date, facts: parcelFacts }) : null;
      return p && { ...p, imageUrl: proxiedImage(p.image) };
    })(),
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

export type ThreadAction =
  | { type: 'read' | 'unread' | 'star' | 'unstar' | 'important' | 'unimportant' | 'archive' | 'inbox' | 'trash' | 'untrash' | 'spam' | 'notspam' | 'delete' | 'unsnooze' }
  | { type: 'snooze'; until: number }
  | { type: 'label' | 'unlabel'; labelId: number }
  /** Move to an inbox tab; future mail from the same sender follows. */
  | { type: 'category'; category: Category }
  /** Mute: new replies skip the inbox (and the conversation leaves it now). */
  | { type: 'mute' | 'unmute' }
  /** "Remind me if no reply" by `at`; or cancel it. */
  | { type: 'followUp'; at: number }
  | { type: 'cancelFollowUp' }
  /** Make the selected conversations one (the oldest keeps its place). */
  | { type: 'merge' };

/** The given conversations that belong to this user. */
function ownThreads(userId: number, threadIds: number[]): number[] {
  if (!threadIds.length) return [];
  return all<{ id: number }>(`SELECT id FROM threads WHERE user_id = ? AND id IN ${IN_LIST}`, [userId, listParam(threadIds)]).map((r) => r.id);
}

/** Message ids a thread action applies to. Drafts are never moved by thread actions. */
function threadMessageIds(userId: number, threadIds: number[], extra = ''): number[] {
  if (!threadIds.length) return [];
  return all<{ id: number }>(
    `SELECT id FROM messages WHERE user_id = ? AND thread_id IN ${IN_LIST} AND folder != 'drafts' ${extra}`,
    [userId, listParam(threadIds)],
  ).map((r) => r.id);
}

export function applyThreadAction(userId: number, threadIds: number[], action: ThreadAction): number {
  return tx(() => {
    const ts = now();
    const ids = (extra = '') => threadMessageIds(userId, threadIds, extra);
    const upd = (sql: string, list: number[], ...p: unknown[]) => {
      if (!list.length) return 0;
      return run(`UPDATE messages SET ${sql} WHERE id IN ${IN_LIST}`, [...p, listParam(list)]).changes;
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
        upd('nudged_at = NULL', ids('AND nudged_at IS NOT NULL'));
        return upd(`folder = 'archive', snoozed_until = NULL`, ids(`AND folder = 'inbox'`));
      case 'inbox':
        return upd(`folder = 'inbox', trashed_at = NULL`, ids(`AND direction = 'in' AND folder IN ('archive','spam','trash')`));
      case 'trash':
        upd('nudged_at = NULL', ids('AND nudged_at IS NOT NULL'));
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
      case 'category': {
        const list = ids(`AND direction = 'in'`);
        const senders = new Set(
          all<{ from_addr: string }>(`SELECT DISTINCT from_addr FROM messages WHERE id IN ${IN_LIST} AND from_addr <> ''`, [listParam(list)]).map((r) => r.from_addr.toLowerCase()),
        );
        for (const sender of senders) {
          run(
            `INSERT INTO category_rules (user_id, sender, category, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, sender) DO UPDATE SET category = excluded.category, created_at = excluded.created_at`,
            [userId, sender, action.category, ts],
          );
        }
        return upd('category = ?', list, action.category);
      }
      case 'mute':
      case 'unmute': {
        const own = ownThreads(userId, threadIds);
        if (!own.length) return 0;
        run(`UPDATE threads SET muted = ? WHERE id IN ${IN_LIST}`, [action.type === 'mute' ? 1 : 0, listParam(own)]);
        if (action.type === 'mute') {
          upd('nudged_at = NULL', ids('AND nudged_at IS NOT NULL'));
          upd(`folder = 'archive', snoozed_until = NULL`, ids(`AND folder = 'inbox'`));
        }
        return own.length;
      }
      case 'followUp': {
        if (!(action.at > ts)) return 0;
        let n = 0;
        for (const t of ownThreads(userId, threadIds)) {
          // Waits on the latest message I sent in the conversation.
          const sent = get<{ date: number }>(`SELECT date FROM messages WHERE thread_id = ? AND user_id = ? AND direction = 'out' AND folder = 'sent' ORDER BY date DESC LIMIT 1`, [t, userId]);
          if (!sent) continue;
          n += run('UPDATE threads SET follow_up_at = ?, follow_up_since = ? WHERE id = ?', [action.at, sent.date, t]).changes;
        }
        return n;
      }
      case 'cancelFollowUp': {
        const own = ownThreads(userId, threadIds);
        if (!own.length) return 0;
        upd('nudged_at = NULL', ids('AND nudged_at IS NOT NULL'));
        return run(`UPDATE threads SET follow_up_at = NULL, follow_up_since = NULL WHERE id IN ${IN_LIST}`, [listParam(own)]).changes;
      }
      case 'merge': {
        const own = ownThreads(userId, threadIds);
        if (own.length < 2) return 0;
        // The conversation that started first keeps its id (and subject); the others join it.
        const first = get<{ thread_id: number }>(`SELECT thread_id FROM messages WHERE thread_id IN ${IN_LIST} ORDER BY date ASC, id ASC LIMIT 1`, [listParam(own)])?.thread_id ?? own[0];
        const others = own.filter((t) => t !== first);
        const moved = run(`UPDATE messages SET thread_id = ? WHERE user_id = ? AND thread_id IN ${IN_LIST}`, [first, userId, listParam(others)]).changes;
        const agg = get<{ last: number; muted: number; fu: number | null }>(
          `SELECT MAX(last_date) AS last, MAX(muted) AS muted, MAX(follow_up_at) AS fu FROM threads WHERE id IN ${IN_LIST}`,
          [listParam(own)],
        )!;
        run('UPDATE threads SET last_date = ?, muted = ? WHERE id = ?', [agg.last, agg.muted, first]);
        run(`DELETE FROM threads WHERE id IN ${IN_LIST}`, [listParam(others)]);
        return moved;
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
       COUNT(DISTINCT CASE WHEN ((folder = 'inbox' AND (snoozed_until IS NULL OR snoozed_until <= ?)) OR (folder = 'sent' AND nudged_at IS NOT NULL)) AND is_read = 0 THEN thread_id END) AS inbox,
       COUNT(DISTINCT CASE WHEN folder = 'spam' AND is_read = 0 THEN thread_id END) AS spam,
       COUNT(CASE WHEN folder = 'drafts' THEN 1 END) AS drafts,
       COUNT(DISTINCT CASE WHEN folder = 'sent' AND status = 'queued' AND is_scheduled = 1 THEN thread_id END) AS scheduled,
       COUNT(DISTINCT CASE WHEN snoozed_until > ? AND folder NOT IN ('spam','trash') THEN thread_id END) AS snoozed,
       COUNT(DISTINCT CASE WHEN is_starred = 1 AND is_read = 0 AND folder NOT IN ('spam','trash') THEN thread_id END) AS starred,
       COUNT(DISTINCT CASE WHEN is_important = 1 AND is_read = 0 AND folder NOT IN ('spam','trash','drafts') THEN thread_id END) AS important,
       COUNT(DISTINCT CASE WHEN ((folder = 'inbox' AND (snoozed_until IS NULL OR snoozed_until <= ?)) OR (folder = 'sent' AND nudged_at IS NOT NULL)) AND is_read = 0 AND category = 'primary' THEN thread_id END) AS primary_unread,
       COUNT(DISTINCT CASE WHEN folder = 'inbox' AND is_read = 0 AND category = 'updates' AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN thread_id END) AS updates_unread,
       COUNT(DISTINCT CASE WHEN folder = 'inbox' AND is_read = 0 AND category = 'promotions' AND (snoozed_until IS NULL OR snoozed_until <= ?) THEN thread_id END) AS promotions_unread
     FROM messages WHERE user_id = ?`,
    [ts, ts, ts, ts, ts, userId],
  );
  const { primary_unread, updates_unread, promotions_unread, ...rest } = c;
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
  return { ...rest, categories: { primary: primary_unread, updates: updates_unread, promotions: promotions_unread }, labels };
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

/**
 * "Remind me if no reply": when the time comes and nobody has answered, the
 * message I sent comes back to the top of the inbox, unread, marked as
 * waiting for a reply.
 */
export function dueFollowUps(): number {
  const ts = now();
  const due = all<{ id: number; user_id: number; follow_up_since: number }>('SELECT id, user_id, follow_up_since FROM threads WHERE follow_up_at IS NOT NULL AND follow_up_at <= ?', [ts]);
  if (!due.length) return 0;
  let nudged = 0;
  tx(() => {
    for (const t of due) {
      run('UPDATE threads SET follow_up_at = NULL, follow_up_since = NULL WHERE id = ?', [t.id]);
      const mine = new Set(userAddresses(t.user_id));
      const replies = all<{ from_addr: string }>(`SELECT from_addr FROM messages WHERE thread_id = ? AND direction = 'in' AND folder != 'spam' AND date > ?`, [t.id, t.follow_up_since]);
      if (replies.some((r) => !mine.has(r.from_addr.toLowerCase()))) continue;
      const sent = get<{ id: number }>(`SELECT id FROM messages WHERE thread_id = ? AND direction = 'out' AND folder = 'sent' ORDER BY date DESC LIMIT 1`, [t.id]);
      if (!sent) continue;
      run('UPDATE messages SET nudged_at = ?, woke_at = ?, is_read = 0 WHERE id = ?', [ts, ts, sent.id]);
      run('UPDATE threads SET last_date = ? WHERE id = ?', [ts, t.id]);
      nudged++;
    }
  });
  return nudged;
}
