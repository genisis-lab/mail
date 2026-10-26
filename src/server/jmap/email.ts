/**
 * Email/*, Thread/* and SearchSnippet/get (RFC 8621 sections 3, 4 and 5).
 *
 * Header fields and bodies come from the stored columns; the body structure is
 * the one Wren keeps (text, HTML and attachments), not a byte-for-byte copy of
 * the original MIME tree. The original is always available as the email's blob.
 */
import type { Addr, Folder } from '../../shared/types.js';
import { all, get, IN_LIST, listParam, now, run, tx } from '../db/index.js';
import { escapeHtml, newMessageId, textToHtml } from '../mail/compose.js';
import { loadBody } from '../mail/body.js';
import { cancelOutbox } from '../mail/outbound.js';
import { ftsTerm } from '../mail/search.js';
import { saveDraft } from '../mail/send.js';
import { HOLD_MESSAGE, onLegalHold, purgeMessages } from '../mail/store.js';
import { rememberSenders } from '../mail/sender-verdicts.js';
import { cleanMessageId, formatAddr } from '../lib/addr.js';
import { importRaw, QuotaExceeded } from '../services/mail-import.js';
import { rawMessage, readBlob } from './blobs.js';
import { changesSince, checkState, currentState } from './changes.js';
import { MethodError, SetError, asSetError } from './errors.js';
import { parseHeaderBlock, headerForm, parseHeaderProperty } from './headers.js';
import { emailId, FOLDER_MAILBOXES, folderMailbox, labelMailboxId, mailboxFolder, parseEmailId, parseThreadId, partBlobId, rawBlobId, threadId } from './ids.js';
import { labelFor, MAILBOX_OF_ROW } from './mailbox.js';
import { applyPatch, CAP, checkSetSize, getIds, getProperties, isObject, method, pick, resolveId, type JmapContext } from './request.js';

// ── Rows ────────────────────────────────────────────────────────────────────

const ROW_COLS = `m.*, t.created_at AS thread_created_at`;

interface LabelRef {
  id: number;
  created_at: number;
}

/** Messages for JMAP email ids that still match (same thread, same draft revision). */
function loadRows(userId: number, ids: string[]): Map<string, any> {
  const keys = new Map<number, string>();
  for (const id of ids) {
    const k = parseEmailId(id);
    if (k) keys.set(k.id, id);
  }
  const out = new Map<string, any>();
  if (!keys.size) return out;
  for (const r of all<any>(`SELECT ${ROW_COLS} FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.user_id = ? AND m.id IN ${IN_LIST}`, [userId, listParam([...keys.keys()])])) {
    const id = keys.get(r.id)!;
    if (emailId(r) === id) out.set(id, r);
  }
  return out;
}

function labelsOf(messageIds: number[]): Map<number, LabelRef[]> {
  const map = new Map<number, LabelRef[]>();
  if (!messageIds.length) return map;
  for (const r of all<{ message_id: number; id: number; created_at: number }>(
    `SELECT ml.message_id, l.id, l.created_at FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id IN ${IN_LIST}`,
    [listParam(messageIds)],
  )) {
    map.set(r.message_id, [...(map.get(r.message_id) ?? []), { id: r.id, created_at: r.created_at }]);
  }
  return map;
}

// Matches MAILBOX_OF_ROW.
const folderOf = (row: { folder: Folder; snoozed_until: number | null }) =>
  row.snoozed_until !== null && (row.folder === 'inbox' || row.folder === 'archive') ? 'snoozed' : folderMailbox(row.folder);

function mailboxIds(row: any, labels: LabelRef[]): Record<string, true> {
  const out: Record<string, true> = { [folderOf(row)]: true };
  for (const l of labels) out[labelMailboxId(l)] = true;
  return out;
}

/** Keywords Wren keeps in columns; the rest are in messages.keywords (a JSON array). */
const COLUMN_KEYWORDS = new Set(['$seen', '$flagged', '$important', '$draft']);

function extraKeywords(row: { keywords: string | null }): string[] {
  try {
    const list = JSON.parse(row.keywords ?? '[]');
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function keywords(row: any): Record<string, true> {
  const out: Record<string, true> = {};
  if (row.is_read) out.$seen = true;
  if (row.is_starred) out.$flagged = true;
  if (row.is_important) out.$important = true;
  if (row.folder === 'drafts') out.$draft = true;
  for (const k of extraKeywords(row)) out[k] = true;
  return out;
}

const utcDate = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Fastmail's Email "snoozed" property (CAP.snooze), as Cyrus IMAP implements it: { until,
 * moveToMailboxId, setKeywords }, set together with the Snoozed mailbox. Wren's snooze
 * (messages.snoozed_until) always wakes mail into the Inbox, unread, so moveToMailboxId is
 * always "inbox" and setKeywords isn't taken. (Cyrus has no "setByMailboxId"; it's refused
 * like any other unknown field.)
 */
const snoozedOf = (row: any) => (folderOf(row) === 'snoozed' ? { until: utcDate(row.snoozed_until), moveToMailboxId: 'inbox' } : null);

/** When a "snoozed" value asks the email to wake, or null for not snoozed. */
function snoozeUntil(value: unknown): number | null {
  if (value === null) return null;
  const bad = (why: string) => new SetError('invalidProperties', why, { properties: ['snoozed'] });
  if (!isObject(value)) throw bad('snoozed is an object or null');
  const unknown = Object.keys(value).filter((k) => k !== 'until' && k !== 'moveToMailboxId');
  if (unknown.length) throw bad(`Can’t set snoozed/${unknown[0]}`);
  if (value.moveToMailboxId !== undefined && value.moveToMailboxId !== null && value.moveToMailboxId !== 'inbox') throw bad('Snoozed mail always comes back to the Inbox');
  const until = typeof value.until === 'string' ? Date.parse(value.until) : NaN;
  if (Number.isNaN(until)) throw bad('snoozed/until must be a UTCDate');
  return until;
}

const addrs = (json: string): { name: string | null; email: string }[] | null => {
  const list = (JSON.parse(json || '[]') as Addr[]).map((a) => ({ name: a.name || null, email: a.address }));
  return list.length ? list : null;
};
const ids = (v: string | null | undefined) => {
  const list = (v ?? '')
    .split(/\s+/)
    .map((x) => x.replace(/^<|>$/g, ''))
    .filter(Boolean);
  return list.length ? list : null;
};

// ── Email/get ───────────────────────────────────────────────────────────────

const DEFAULT_PROPS = [
  'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc',
  'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
] as const;
const ALL_PROPS = [...DEFAULT_PROPS, 'headers', 'bodyStructure'] as const;
const BODY_PROPS = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location', 'headers', 'subParts'];
const DEFAULT_BODY_PROPS = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];
const BODY_NEEDS = new Set(['bodyValues', 'textBody', 'htmlBody', 'attachments', 'bodyStructure', 'preview']);

interface Part {
  partId: string | null;
  blobId: string | null;
  size: number;
  headers: { name: string; value: string }[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts?: Part[];
}

const part = (p: Partial<Part> & { type: string }): Part => ({
  partId: null,
  blobId: null,
  size: 0,
  headers: [],
  name: null,
  charset: null,
  disposition: null,
  cid: null,
  language: null,
  location: null,
  ...p,
});

function bodyParts(row: any, atts: any[]) {
  const text = row.text_body !== null && row.text_body !== undefined && row.text_body !== '' ? part({ partId: 't', blobId: partBlobId(row, 't'), size: Buffer.byteLength(row.text_body), type: 'text/plain', charset: 'utf-8' }) : null;
  const html = row.html_body ? part({ partId: 'h', blobId: partBlobId(row, 'h'), size: Buffer.byteLength(row.html_body), type: 'text/html', charset: 'utf-8' }) : null;
  const files = atts.map((a) =>
    part({ partId: `a${a.id}`, blobId: `A${a.id}`, size: a.size, name: a.filename, type: a.content_type, disposition: a.inline ? 'inline' : 'attachment', cid: a.content_id }),
  );
  const body = text && html ? part({ type: 'multipart/alternative', subParts: [text, html] }) : (text ?? html ?? part({ partId: 't', blobId: partBlobId(row, 't'), type: 'text/plain', charset: 'utf-8' }));
  const structure = files.length ? part({ type: 'multipart/mixed', subParts: [body, ...files] }) : body;
  return {
    text,
    html,
    files,
    structure,
    textBody: text ? [text] : html ? [html] : [],
    htmlBody: html ? [html] : text ? [text] : [],
  };
}

function shapePart(p: Part, props: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of props) if (k !== 'subParts') out[k] = (p as unknown as Record<string, unknown>)[k];
  if (p.subParts) out.subParts = p.subParts.map((s) => shapePart(s, props));
  return out;
}

function truncate(value: string, maxBytes: number): { value: string; isTruncated: boolean } {
  if (!maxBytes || Buffer.byteLength(value) <= maxBytes) return { value, isTruncated: false };
  let cut = Buffer.from(value).subarray(0, maxBytes).toString('utf8');
  // Don't end on half a character.
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return { value: cut, isTruncated: true };
}

async function toEmail(row: any, labels: LabelRef[], props: Set<string>, args: Record<string, any>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { id: emailId(row) };
  const set = (k: string, v: () => unknown) => {
    if (props.has(k)) out[k] = v();
  };
  set('blobId', () => rawBlobId(row));
  set('threadId', () => threadId({ id: row.thread_id, created_at: row.thread_created_at }));
  set('mailboxIds', () => mailboxIds(row, labels));
  set('keywords', () => keywords(row));
  set('size', () => row.size || 0);
  set('receivedAt', () => utcDate(row.date));
  set('sentAt', () => utcDate(row.date));
  set('messageId', () => ids(row.message_id));
  set('inReplyTo', () => ids(row.in_reply_to));
  set('references', () => ids(row.refs));
  set('sender', () => null);
  set('from', () => (row.from_addr ? [{ name: row.from_name || null, email: row.from_addr }] : null));
  set('to', () => addrs(row.to_json));
  set('cc', () => addrs(row.cc_json));
  set('bcc', () => addrs(row.bcc_json));
  set('replyTo', () => (row.reply_to ? (headerForm(row.reply_to, 'Addresses') as unknown[]) : null));
  set('subject', () => row.subject ?? '');
  set('hasAttachment', () => !!row.has_attachments);
  set('preview', () => row.snippet ?? '');
  set('snoozed', () => snoozedOf(row));

  if ([...props].some((p) => BODY_NEEDS.has(p))) {
    await loadBody(row);
    const atts = all<any>('SELECT id, filename, content_type, size, content_id, inline FROM attachments WHERE message_id = ? ORDER BY id', [row.id]);
    const b = bodyParts(row, atts);
    const bodyProps = Array.isArray(args.bodyProperties) ? args.bodyProperties.filter((p: unknown) => typeof p === 'string' && BODY_PROPS.includes(p as string)) : DEFAULT_BODY_PROPS;
    set('textBody', () => b.textBody.map((p) => shapePart(p, bodyProps)));
    set('htmlBody', () => b.htmlBody.map((p) => shapePart(p, bodyProps)));
    set('attachments', () => b.files.map((p) => shapePart(p, bodyProps)));
    set('bodyStructure', () => shapePart(b.structure, bodyProps));
    set('bodyValues', () => {
      const values: Record<string, unknown> = {};
      const want = new Set<Part>();
      if (args.fetchTextBodyValues) b.textBody.forEach((p) => want.add(p));
      if (args.fetchHTMLBodyValues) b.htmlBody.forEach((p) => want.add(p));
      if (args.fetchAllBodyValues) [b.text, b.html].forEach((p) => p && want.add(p));
      for (const p of want) {
        const text = p.partId === 't' ? row.text_body : row.html_body;
        values[p.partId!] = { ...truncate(text ?? '', Number(args.maxBodyValueBytes) || 0), isEncodingProblem: false };
      }
      return values;
    });
  }

  const headerProps = [...props].filter((p) => p.startsWith('header:'));
  if (props.has('headers') || headerProps.length) {
    const headers = row.raw_blob || row.folder === 'drafts' ? parseHeaderBlock(await rawMessage(row)) : [];
    set('headers', () => headers);
    for (const p of headerProps) {
      const h = parseHeaderProperty(p)!;
      const values = headers.filter((x) => x.name.toLowerCase() === h.name.toLowerCase()).map((x) => headerForm(x.value, h.form));
      out[p] = h.all ? values : (values.at(-1) ?? null);
    }
  }
  return out;
}

method('Email/get', CAP.mail, async (args, ctx) => {
  const wanted = getIds(args, ctx, false)!;
  const props = getProperties(args, ctx.using.has(CAP.snooze) ? [...ALL_PROPS, 'snoozed'] : ALL_PROPS, DEFAULT_PROPS);
  for (const p of props) if (p.startsWith('header:') && !parseHeaderProperty(p)) throw new MethodError('invalidArguments', `Bad header property ${p}`);
  const state = currentState(ctx.user.id);
  const rows = loadRows(ctx.user.id, wanted);
  const labels = labelsOf([...rows.values()].map((r) => r.id));
  const list: unknown[] = [];
  const notFound: string[] = [];
  for (const id of wanted) {
    const r = rows.get(id);
    if (!r) notFound.push(id);
    else list.push(await toEmail(r, labels.get(r.id) ?? [], props, args));
  }
  return { accountId: ctx.accountId, state, list, notFound };
});

method('Email/changes', CAP.mail, (args, ctx) => ({ accountId: ctx.accountId, ...changesSince(ctx.user.id, 'Email', args.sinceState, args.maxChanges) }));

// ── Thread/get ──────────────────────────────────────────────────────────────

method('Thread/get', CAP.mail, (args, ctx) => {
  const wanted = getIds(args, ctx, false)!;
  const state = currentState(ctx.user.id);
  const keys = wanted.map((id) => [id, parseThreadId(id)] as const);
  const valid = keys.filter((k) => k[1]).map((k) => k[1]!.id);
  const threads = new Map(
    valid.length
      ? all<{ id: number; created_at: number }>(`SELECT id, created_at FROM threads WHERE user_id = ? AND id IN ${IN_LIST}`, [ctx.user.id, listParam(valid)]).map((t) => [threadId(t), t])
      : [],
  );
  const found = wanted.filter((id) => threads.has(id));
  const emails = new Map<number, string[]>();
  if (found.length) {
    for (const m of all<any>(`SELECT id, thread_id, created_at, jmap_rev FROM messages WHERE thread_id IN ${IN_LIST} ORDER BY date, id`, [listParam(found.map((id) => threads.get(id)!.id))])) {
      emails.set(m.thread_id, [...(emails.get(m.thread_id) ?? []), emailId(m)]);
    }
  }
  return {
    accountId: ctx.accountId,
    state,
    list: found.map((id) => ({ id, emailIds: emails.get(threads.get(id)!.id) ?? [] })),
    notFound: wanted.filter((id) => !threads.has(id)),
  };
});

method('Thread/changes', CAP.mail, (args, ctx) => ({ accountId: ctx.accountId, ...changesSince(ctx.user.id, 'Thread', args.sinceState, args.maxChanges) }));

// ── Email/query ─────────────────────────────────────────────────────────────

const like = (s: string) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const KEYWORD_RE = /^[\x21-\x7e]{1,255}$/;
const BAD_KEYWORD = /[(){\]%*"\\]/;

function normKeyword(k: unknown): string {
  if (typeof k !== 'string' || !KEYWORD_RE.test(k) || BAD_KEYWORD.test(k)) throw new MethodError('invalidArguments', `Bad keyword ${String(k)}`);
  return k.toLowerCase();
}

function keywordSql(k: string, alias: string, params: unknown[]): string {
  switch (k) {
    case '$seen':
      return `${alias}.is_read = 1`;
    case '$flagged':
      return `${alias}.is_starred = 1`;
    case '$important':
      return `${alias}.is_important = 1`;
    case '$draft':
      return `${alias}.folder = 'drafts'`;
    default:
      params.push(k);
      return `EXISTS (SELECT 1 FROM json_each(COALESCE(${alias}.keywords, '[]')) WHERE value = ?)`;
  }
}

function mailboxSql(userId: number, id: unknown, params: unknown[]): string {
  if (typeof id !== 'string') throw new MethodError('invalidArguments', 'A mailbox id is a string');
  if (FOLDER_MAILBOXES.some((f) => f.id === id)) {
    params.push(id);
    return `(${MAILBOX_OF_ROW}) = ?`;
  }
  const label = labelFor(userId, id);
  if (!label) return '0';
  params.push(label.id);
  return 'EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)';
}

function parseDate(v: unknown, name: string): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new MethodError('invalidArguments', `${name} must be a UTCDate`);
  return t;
}

/** Plain words from a text condition, as FTS terms joined with AND. */
function ftsQuery(text: unknown, column?: string): string | null {
  const terms = String(text ?? '')
    .split(/\s+/)
    .map((w) => ftsTerm(w))
    .filter(Boolean)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => (column ? `${column} : ${t}` : t)).join(' AND ');
}

function conditionSql(userId: number, f: Record<string, unknown>, params: unknown[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    switch (k) {
      case 'inMailbox':
        parts.push(mailboxSql(userId, v, params));
        break;
      case 'inMailboxOtherThan': {
        if (!Array.isArray(v)) throw new MethodError('invalidArguments', 'inMailboxOtherThan is a list of ids');
        params.push(listParam(v.map(String)), listParam(v.map(String)));
        parts.push(`((${MAILBOX_OF_ROW}) NOT IN ${IN_LIST} OR EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
          WHERE ml.message_id = m.id AND ('L' || l.id || 'C' || l.created_at) NOT IN ${IN_LIST}))`);
        break;
      }
      case 'before':
        params.push(parseDate(v, k));
        parts.push('m.date < ?');
        break;
      case 'after':
        params.push(parseDate(v, k));
        parts.push('m.date >= ?');
        break;
      case 'minSize':
        params.push(Number(v) || 0);
        parts.push('m.size >= ?');
        break;
      case 'maxSize':
        params.push(Number(v) || 0);
        parts.push('m.size < ?');
        break;
      case 'hasKeyword':
        parts.push(keywordSql(normKeyword(v), 'm', params));
        break;
      case 'notKeyword':
        parts.push(`NOT (${keywordSql(normKeyword(v), 'm', params)})`);
        break;
      case 'allInThreadHaveKeyword':
        parts.push(`NOT EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = m.thread_id AND NOT (${keywordSql(normKeyword(v), 'x', params)}))`);
        break;
      case 'someInThreadHaveKeyword':
        parts.push(`EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = m.thread_id AND ${keywordSql(normKeyword(v), 'x', params)})`);
        break;
      case 'noneInThreadHaveKeyword':
        parts.push(`NOT EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = m.thread_id AND ${keywordSql(normKeyword(v), 'x', params)})`);
        break;
      case 'hasAttachment':
        parts.push(v ? 'm.has_attachments = 1' : 'm.has_attachments = 0');
        break;
      case 'text':
      case 'body': {
        const q = ftsQuery(v, k === 'body' ? 'body' : undefined);
        if (!q) break;
        params.push(q);
        parts.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
        break;
      }
      case 'from':
        params.push(like(String(v)), like(String(v)));
        parts.push(`(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')`);
        break;
      case 'to':
      case 'cc':
      case 'bcc':
        params.push(like(String(v)));
        parts.push(`m.${k}_json LIKE ? ESCAPE '\\'`);
        break;
      case 'subject':
        params.push(like(String(v)));
        parts.push(`m.subject LIKE ? ESCAPE '\\'`);
        break;
      case 'header': {
        // Only the headers Wren keeps in columns can be searched.
        const [name, value] = Array.isArray(v) ? v : [];
        const col = { 'message-id': 'm.message_id', subject: 'm.subject', 'in-reply-to': 'm.in_reply_to', 'list-unsubscribe': 'm.list_unsubscribe' }[String(name).toLowerCase()];
        if (!col) throw new MethodError('unsupportedFilter', `Can't search the ${String(name)} header`);
        if (value === undefined) parts.push(`${col} IS NOT NULL AND ${col} <> ''`);
        else {
          params.push(like(String(value)));
          parts.push(`${col} LIKE ? ESCAPE '\\'`);
        }
        break;
      }
      default:
        throw new MethodError('unsupportedFilter', `Unsupported filter ${k}`);
    }
  }
  return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : '1';
}

export function filterSql(userId: number, filter: unknown, params: unknown[], depth = 0): string {
  if (filter === null || filter === undefined) return '1';
  if (!isObject(filter)) throw new MethodError('invalidArguments', 'filter must be an object');
  if (depth > 6) throw new MethodError('unsupportedFilter', 'The filter is nested too deeply');
  if ('operator' in filter) {
    const conds = Array.isArray(filter.conditions) ? filter.conditions : null;
    if (!conds) throw new MethodError('invalidArguments', 'A FilterOperator needs conditions');
    const inner = conds.map((c) => `(${filterSql(userId, c, params, depth + 1)})`);
    if (filter.operator === 'AND') return inner.join(' AND ') || '1';
    if (filter.operator === 'OR') return inner.join(' OR ') || '0';
    if (filter.operator === 'NOT') return `NOT (${inner.join(' OR ') || '0'})`;
    throw new MethodError('invalidArguments', `Unknown operator ${String(filter.operator)}`);
  }
  return conditionSql(userId, filter, params);
}

function sortSql(sort: unknown, params: unknown[]): { exprs: string[]; dirs: string[] } {
  const list = Array.isArray(sort) && sort.length ? sort : [{ property: 'receivedAt', isAscending: false }];
  const exprs: string[] = [];
  const dirs: string[] = [];
  for (const c of list.slice(0, 4)) {
    if (!isObject(c)) throw new MethodError('invalidArguments', 'A comparator is an object');
    let expr: string;
    switch (c.property) {
      case 'receivedAt':
      case 'sentAt':
        expr = 'm.date';
        break;
      case 'size':
        expr = 'm.size';
        break;
      case 'from':
        expr = `lower(COALESCE(NULLIF(m.from_name, ''), m.from_addr))`;
        break;
      case 'to':
        expr = `lower(COALESCE(NULLIF(json_extract(m.to_json, '$[0].name'), ''), json_extract(m.to_json, '$[0].address'), ''))`;
        break;
      case 'subject':
        expr = 'lower(m.subject)';
        break;
      case 'hasKeyword':
        expr = `(${keywordSql(normKeyword(c.keyword), 'm', params)})`;
        break;
      default:
        throw new MethodError('unsupportedSort', `Can't sort by ${String(c.property)}`);
    }
    exprs.push(expr);
    dirs.push(c.isAscending === false ? 'DESC' : 'ASC');
  }
  return { exprs, dirs };
}

/** SQL for the ordered ids of a query (the caller adds LIMIT/OFFSET). */
function querySql(userId: number, args: Record<string, any>): { sql: string; params: unknown[]; countSql: string } {
  const params: unknown[] = [];
  const sort = sortSql(args.sort, params);
  // Sort parameters come first (they're in the SELECT list), then the user id, then the filter's.
  const sortParams = params.splice(0);
  const where = filterSql(userId, args.filter, params);
  if (params.length > 90) throw new MethodError('unsupportedFilter', 'The filter is too large');
  const cols = sort.exprs.map((e, i) => `${e} AS s${i}`).join(', ');
  const order = sort.exprs.map((_, i) => `s${i} ${sort.dirs[i]}`).join(', ');
  const inner = `SELECT m.id, m.thread_id, m.created_at, m.jmap_rev, ${cols} FROM messages m WHERE m.user_id = ? AND (${where})`;
  const p = [...sortParams, userId, ...params];
  if (args.collapseThreads) {
    return {
      sql: `SELECT id, thread_id, created_at, jmap_rev FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.thread_id ORDER BY ${order}, x.id DESC) AS rn FROM (${inner}) x) WHERE rn = 1 ORDER BY ${order}, id DESC`,
      params: p,
      countSql: `SELECT COUNT(DISTINCT thread_id) AS c FROM (${inner})`,
    };
  }
  return { sql: `SELECT id, thread_id, created_at, jmap_rev FROM (${inner}) ORDER BY ${order}, id DESC`, params: p, countSql: `SELECT COUNT(*) AS c FROM (${inner})` };
}

const MAX_QUERY_LIMIT = 1000;

method('Email/query', CAP.mail, (args, ctx) => {
  const q = querySql(ctx.user.id, args);
  const total = get<{ c: number }>(q.countSql, q.params)?.c ?? 0;
  let position = Number.isInteger(args.position) ? args.position : 0;
  if (position < 0) position = Math.max(0, total + position);
  let limit = args.limit === undefined || args.limit === null ? MAX_QUERY_LIMIT : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new MethodError('invalidArguments', 'limit must be a non-negative integer');
  const capped = limit > MAX_QUERY_LIMIT;
  limit = Math.min(limit, MAX_QUERY_LIMIT);

  let rows: any[];
  if (args.anchor !== undefined && args.anchor !== null) {
    // Anchors need the whole ordered list (ids only).
    const everything = all<any>(q.sql, q.params);
    const at = everything.findIndex((r) => emailId(r) === args.anchor);
    if (at < 0) throw new MethodError('anchorNotFound', 'The anchor is not in the results');
    position = Math.max(0, at + (Number(args.anchorOffset) || 0));
    rows = everything.slice(position, position + limit);
  } else {
    rows = all<any>(`${q.sql} LIMIT ? OFFSET ?`, [...q.params, limit, position]);
  }
  return {
    accountId: ctx.accountId,
    queryState: currentState(ctx.user.id),
    canCalculateChanges: false,
    position,
    ids: rows.map((r) => emailId(r)),
    ...(args.calculateTotal ? { total } : {}),
    ...(capped ? { limit } : {}),
  };
});

method('Email/queryChanges', CAP.mail, () => {
  throw new MethodError('cannotCalculateChanges', 'Run Email/query again');
});

// ── Email/set ───────────────────────────────────────────────────────────────

function keywordSet(value: unknown, what = 'keywords'): Set<string> {
  if (!isObject(value)) throw new SetError('invalidProperties', `${what} must be an object`, { properties: [what] });
  const out = new Set<string>();
  for (const [k, v] of Object.entries(value)) {
    if (v !== true) throw new SetError('invalidProperties', `${what} values must be true`, { properties: [what] });
    if (!KEYWORD_RE.test(k) || BAD_KEYWORD.test(k)) throw new SetError('invalidProperties', `Bad keyword ${k}`, { properties: [what] });
    out.add(k.toLowerCase());
  }
  return out;
}

/** Split JMAP mailbox ids into the one folder (or Snoozed) and the labels. */
function placement(userId: number, ctx: JmapContext, value: unknown): { folder: Folder | null; labels: number[]; snoozed: boolean } {
  if (!isObject(value)) throw new SetError('invalidProperties', 'mailboxIds must be an object', { properties: ['mailboxIds'] });
  const folders: Folder[] = [];
  const labels: number[] = [];
  let snoozed = false;
  for (const [rawId, v] of Object.entries(value)) {
    if (v !== true) throw new SetError('invalidProperties', 'mailboxIds values must be true', { properties: ['mailboxIds'] });
    const id = String(resolveId(ctx, rawId));
    const folder = mailboxFolder(id);
    if (folder) folders.push(folder);
    else if (id === 'snoozed') snoozed = true;
    else {
      const label = labelFor(userId, id);
      if (!label) throw new SetError('invalidProperties', `No mailbox ${id}`, { properties: ['mailboxIds'] });
      labels.push(label.id);
    }
  }
  if (!folders.length && !labels.length && !snoozed) throw new SetError('invalidProperties', 'An email must be in at least one mailbox', { properties: ['mailboxIds'] });
  if (folders.length + Number(snoozed) > 1) throw new SetError('invalidProperties', 'An email can be in only one of Inbox, Archive, Drafts, Sent, Spam, Trash and Snoozed', { properties: ['mailboxIds'] });
  return { folder: folders[0] ?? null, labels, snoozed };
}

function writeKeywords(row: any, kw: Set<string>) {
  const extra = [...kw].filter((k) => !COLUMN_KEYWORDS.has(k)).sort();
  const json = extra.length ? JSON.stringify(extra) : null;
  const read = kw.has('$seen') ? 1 : 0;
  const starred = kw.has('$flagged') ? 1 : 0;
  const important = kw.has('$important') ? 1 : 0;
  if (read !== row.is_read || starred !== row.is_starred || important !== row.is_important || json !== (row.keywords ?? null)) {
    run('UPDATE messages SET is_read = ?, is_starred = ?, is_important = ?, keywords = ? WHERE id = ?', [read, starred, important, json, row.id]);
  }
}

function moveTo(userId: number, row: any, target: Folder) {
  const shown = folderOf(row);
  if (folderMailbox(target) === shown) return;
  if (target === 'drafts') throw new SetError('invalidProperties', 'Only new drafts go in Drafts', { properties: ['mailboxIds'] });
  if (row.folder === 'drafts' && target !== 'trash') throw new SetError('invalidProperties', 'A draft is sent with EmailSubmission, or deleted', { properties: ['mailboxIds'] });
  if (target === 'sent' && row.direction !== 'out') throw new SetError('invalidProperties', 'Only mail you sent goes in Sent', { properties: ['mailboxIds'] });
  // A mail app's "Junk" / "Not Junk" teaches Wren about the sender, like the web app's buttons.
  if (target === 'spam' && row.folder !== 'spam') rememberSenders(userId, [row.id], 'spam');
  else if (row.folder === 'spam' && target === 'inbox') rememberSenders(userId, [row.id], 'safe');
  run(
    `UPDATE messages SET folder = ?, snoozed_until = NULL, nudged_at = NULL,
       trashed_at = CASE WHEN ? = 'trash' THEN COALESCE(trashed_at, ?) ELSE NULL END WHERE id = ?`,
    [target, target, now(), row.id],
  );
}

function setLabels(row: any, current: LabelRef[], wanted: number[]) {
  const have = new Set(current.map((l) => l.id));
  const want = new Set(wanted);
  for (const id of want) if (!have.has(id)) run('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)', [row.id, id]);
  for (const id of have) if (!want.has(id)) run('DELETE FROM message_labels WHERE message_id = ? AND label_id = ?', [row.id, id]);
}

function updateEmail(ctx: JmapContext, row: any, labels: LabelRef[], patch: Record<string, unknown>) {
  const props = new Set(Object.keys(patch).map((k) => k.split('/')[0]));
  const snooze = ctx.using.has(CAP.snooze);
  const bad = [...props].filter((p) => p !== 'keywords' && p !== 'mailboxIds' && !(snooze && p === 'snoozed'));
  if (bad.length) throw new SetError('invalidProperties', snooze ? 'Only keywords, mailboxIds and snoozed can change' : 'Only keywords and mailboxIds can change', { properties: bad });
  let next: Record<string, any>;
  try {
    next = applyPatch({ keywords: keywords(row), mailboxIds: mailboxIds(row, labels), snoozed: snoozedOf(row) }, patch);
  } catch (err) {
    throw new SetError('invalidPatch', (err as Error).message);
  }
  tx(() => {
    if (props.has('mailboxIds') || props.has('snoozed')) {
      const where = placement(ctx.user.id, ctx, next.mailboxIds);
      // As in Cyrus: "snoozed" and the Snoozed mailbox are set together, and taking an email out of Snoozed un-snoozes it.
      const until = props.has('snoozed') ? snoozeUntil(next.snoozed) : where.snoozed ? row.snoozed_until : null;
      if (where.snoozed !== (until !== null)) throw new SetError('invalidProperties', 'A snoozed email is in Snoozed, and only a snoozed one', { properties: ['mailboxIds', 'snoozed'] });
      if (until === null) {
        // Taking an email out of its folder (into labels only) archives it, like Gmail's "remove from Inbox".
        moveTo(ctx.user.id, row, where.folder ?? (row.folder === 'drafts' ? 'drafts' : 'archive'));
      } else {
        if (row.status === 'queued') throw new SetError('invalidProperties', 'Cancel the scheduled send before snoozing it', { properties: ['snoozed'] });
        // Snoozed mail waits in Inbox or Archive and wakes into the Inbox (wakeSnoozed), as from the web app.
        if (row.folder !== 'inbox' && row.folder !== 'archive') moveTo(ctx.user.id, row, 'archive');
        run('UPDATE messages SET snoozed_until = ? WHERE id = ?', [until, row.id]);
      }
      setLabels(row, labels, where.labels);
    }
    if (props.has('keywords')) writeKeywords(row, keywordSet(next.keywords));
  });
}

function destroyEmail(row: any) {
  // On legal hold, only drafts can go (as from the web app); everything else stays.
  if (row.folder !== 'drafts' && onLegalHold(row.user_id)) throw new SetError('forbidden', HOLD_MESSAGE);
  if (row.status === 'queued') cancelOutbox(row.id);
  purgeMessages([row.id]);
}

interface BodyInput {
  html: string | null;
  text: string | null;
  attachments: number[];
}

/** The draft's text, HTML and attachments from textBody/htmlBody/bodyStructure/attachments and bodyValues. */
function bodyInput(userId: number, obj: Record<string, any>): BodyInput {
  const values = isObject(obj.bodyValues) ? (obj.bodyValues as Record<string, { value?: unknown }>) : {};
  const valueOf = (p: any): string | null => {
    if (!isObject(p)) return null;
    if (typeof p.partId === 'string' && typeof values[p.partId]?.value === 'string') return values[p.partId].value as string;
    return null;
  };
  let html: string | null = null;
  let text: string | null = null;
  const files: any[] = Array.isArray(obj.attachments) ? [...obj.attachments] : [];
  if (isObject(obj.bodyStructure)) {
    const walkPart = (p: any) => {
      if (!isObject(p)) return;
      if (Array.isArray(p.subParts)) return p.subParts.forEach(walkPart);
      const type = String(p.type ?? 'text/plain').toLowerCase();
      if (p.blobId || p.disposition === 'attachment' || !type.startsWith('text/')) files.push(p);
      else if (type === 'text/html' && html === null) html = valueOf(p);
      else if (type === 'text/plain' && text === null) text = valueOf(p);
    };
    walkPart(obj.bodyStructure);
  } else {
    if (Array.isArray(obj.htmlBody) && obj.htmlBody[0]) html = valueOf(obj.htmlBody[0]);
    if (Array.isArray(obj.textBody) && obj.textBody[0]) text = valueOf(obj.textBody[0]);
  }
  const attachments: number[] = [];
  for (const f of files) {
    const m = typeof f?.blobId === 'string' ? /^A(\d+)$/.exec(f.blobId) : null;
    const a = m && get<{ id: number }>('SELECT id FROM attachments WHERE id = ? AND user_id = ?', [Number(m[1]), userId]);
    if (!a) throw new SetError('invalidProperties', `Can't attach ${String(f?.blobId)}: upload the file first`, { properties: ['attachments'] });
    // Keep the client's name, type and inline flag for this copy.
    if (typeof f.name === 'string' || typeof f.type === 'string' || f.disposition === 'inline' || typeof f.cid === 'string') {
      run('UPDATE attachments SET filename = COALESCE(?, filename), content_type = COALESCE(?, content_type), inline = ?, content_id = COALESCE(?, content_id) WHERE id = ? AND message_id IS NULL', [
        typeof f.name === 'string' ? f.name.slice(0, 255) : null,
        typeof f.type === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(f.type) ? f.type.toLowerCase() : null,
        f.disposition === 'inline' ? 1 : 0,
        typeof f.cid === 'string' ? f.cid.replace(/^<|>$/g, '') : null,
        a.id,
      ]);
    }
    attachments.push(a.id);
  }
  return { html, text, attachments };
}

const CREATE_PROPS = new Set([
  'mailboxIds', 'keywords', 'from', 'sender', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'receivedAt', 'messageId', 'inReplyTo', 'references',
  'textBody', 'htmlBody', 'bodyStructure', 'bodyValues', 'attachments',
]);

/** A new draft from a mail app. Only drafts are created here; other mail arrives with Email/import. */
async function createDraft(ctx: JmapContext, obj: Record<string, any>): Promise<Record<string, unknown>> {
  const userId = ctx.user.id;
  const bad = Object.keys(obj).filter((k) => !CREATE_PROPS.has(k) && !k.startsWith('header:'));
  if (bad.length) throw new SetError('invalidProperties', `Can't set ${bad.join(', ')}`, { properties: bad });
  const where = placement(userId, ctx, obj.mailboxIds);
  if (where.folder !== 'drafts') throw new SetError('invalidProperties', 'Only drafts can be created; import other mail with Email/import', { properties: ['mailboxIds'] });
  const kw = obj.keywords === undefined ? new Set(['$draft', '$seen']) : keywordSet(obj.keywords);
  const from = Array.isArray(obj.from) && obj.from[0]?.email ? formatAddr({ address: String(obj.from[0].email), name: String(obj.from[0].name ?? '') }) : undefined;
  const body = bodyInput(userId, obj);
  const html = body.html ?? (body.text !== null ? textToHtml(body.text) : '');

  // Thread it with the message it answers, when that message is in this mailbox.
  const inReplyTo = Array.isArray(obj.inReplyTo) && typeof obj.inReplyTo[0] === 'string' ? cleanMessageId(obj.inReplyTo[0]) : null;
  const refs = Array.isArray(obj.references) ? obj.references.filter((r: unknown): r is string => typeof r === 'string').map((r: string) => cleanMessageId(r)).filter(Boolean) : null;
  const original = inReplyTo ? get<{ id: number }>('SELECT id FROM messages WHERE user_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1', [userId, inReplyTo]) : undefined;

  const id = await saveDraft(userId, {
    from,
    to: obj.to ?? [],
    cc: obj.cc ?? [],
    bcc: obj.bcc ?? [],
    subject: typeof obj.subject === 'string' ? obj.subject : '',
    html,
    attachments: body.attachments,
    replyToId: original?.id ?? null,
  });
  const ownId = Array.isArray(obj.messageId) && typeof obj.messageId[0] === 'string' ? cleanMessageId(obj.messageId[0]) : null;
  tx(() => {
    const row = get<any>('SELECT * FROM messages WHERE id = ?', [id]);
    run(`UPDATE messages SET message_id = ?, source = 'jmap', in_reply_to = COALESCE(?, in_reply_to), refs = COALESCE(?, refs) WHERE id = ?`, [
      ownId || newMessageId(row.from_addr),
      original ? null : inReplyTo,
      refs?.length ? refs.join(' ') : null,
      id,
    ]);
    if (body.text !== null && body.html !== null) run('UPDATE messages SET text_body = ? WHERE id = ? AND body_blob IS NULL', [body.text, id]);
    writeKeywords(row, new Set([...kw, '$seen']));
    setLabels(row, [], where.labels);
  });
  const row = get<any>(`SELECT ${ROW_COLS} FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`, [id]);
  return { id: emailId(row), blobId: rawBlobId(row), threadId: threadId({ id: row.thread_id, created_at: row.thread_created_at }), size: row.size || 0 };
}

export async function emailSet(args: Record<string, any>, ctx: JmapContext) {
  checkSetSize(args);
  const userId = ctx.user.id;
  checkState(userId, args.ifInState);
  const oldState = currentState(userId);
  const created: Record<string, unknown> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];
  const notCreated: Record<string, unknown> = {};
  const notUpdated: Record<string, unknown> = {};
  const notDestroyed: Record<string, unknown> = {};

  for (const [cid, obj] of Object.entries<Record<string, any>>(args.create ?? {})) {
    try {
      if (!isObject(obj)) throw new SetError('invalidProperties', 'Not an object');
      const c = await createDraft(ctx, obj);
      ctx.createdIds.set(cid, c.id as string);
      created[cid] = c;
    } catch (err) {
      notCreated[cid] = asSetError(err);
    }
  }

  const updates = Object.entries<Record<string, unknown>>(args.update ?? {}).map(([raw, patch]) => [String(resolveId(ctx, raw)), patch] as const);
  const rows = loadRows(userId, updates.map(([id]) => id));
  const labels = labelsOf([...rows.values()].map((r) => r.id));
  for (const [id, patch] of updates) {
    try {
      const row = rows.get(id);
      if (!row) throw new SetError('notFound', 'No such email');
      if (!isObject(patch)) throw new SetError('invalidPatch', 'Not an object');
      updateEmail(ctx, row, labels.get(row.id) ?? [], patch);
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = asSetError(err);
    }
  }

  const doomed = ((args.destroy ?? []) as unknown[]).map((raw) => String(resolveId(ctx, raw)));
  const doomedRows = loadRows(userId, doomed);
  for (const id of doomed) {
    try {
      const row = doomedRows.get(id);
      if (!row) throw new SetError('notFound', 'No such email');
      destroyEmail(row);
      destroyed.push(id);
    } catch (err) {
      notDestroyed[id] = asSetError(err);
    }
  }

  return { accountId: ctx.accountId, oldState, newState: currentState(userId), created, updated, destroyed, notCreated, notUpdated, notDestroyed };
}

method('Email/set', CAP.mail, emailSet);

// ── Email/import ────────────────────────────────────────────────────────────

method('Email/import', CAP.mail, async (args, ctx) => {
  const userId = ctx.user.id;
  checkState(userId, args.ifInState);
  if (!isObject(args.emails)) throw new MethodError('invalidArguments', 'emails must be an object');
  if (Object.keys(args.emails).length > 50) throw new MethodError('requestTooLarge', 'Import at most 50 emails per call');
  const oldState = currentState(userId);
  const created: Record<string, unknown> = {};
  const notCreated: Record<string, unknown> = {};
  for (const [cid, e] of Object.entries(args.emails as Record<string, Record<string, any>>)) {
    try {
      if (!isObject(e)) throw new SetError('invalidProperties', 'Not an object');
      const blob = await readBlob(userId, resolveId(ctx, e.blobId));
      if (!blob) throw new SetError('blobNotFound', 'No such blob', { notFound: [e.blobId] });
      const where = placement(userId, ctx, e.mailboxIds);
      if (where.folder === 'drafts') throw new SetError('invalidProperties', 'Create drafts with Email/set', { properties: ['mailboxIds'] });
      if (where.snoozed) throw new SetError('invalidProperties', 'Import the email, then snooze it', { properties: ['mailboxIds'] });
      const kw = e.keywords === undefined ? new Set<string>() : keywordSet(e.keywords);
      const receivedAt = typeof e.receivedAt === 'string' && !Number.isNaN(Date.parse(e.receivedAt)) ? Date.parse(e.receivedAt) : null;
      let result;
      try {
        result = await importRaw(userId, blob.data, {
          folder: where.folder ?? 'archive',
          read: kw.has('$seen'),
          starred: kw.has('$flagged'),
          important: kw.has('$important'),
          date: receivedAt,
        });
      } catch (err) {
        if (err instanceof QuotaExceeded) throw new SetError('overQuota', err.message);
        throw err;
      }
      const row = get<any>(`SELECT ${ROW_COLS} FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`, [result.id]);
      if (result.status === 'duplicate') throw new SetError('alreadyExists', 'This message is already in the mailbox', { existingId: emailId(row) });
      tx(() => {
        if (receivedAt) run('UPDATE messages SET date = ? WHERE id = ?', [receivedAt, row.id]);
        writeKeywords(row, kw);
        setLabels(row, [], where.labels);
      });
      ctx.createdIds.set(cid, emailId(row));
      created[cid] = { id: emailId(row), blobId: rawBlobId(row), threadId: threadId({ id: row.thread_id, created_at: row.thread_created_at }), size: row.size || 0 };
    } catch (err) {
      notCreated[cid] = asSetError(err);
    }
  }
  return { accountId: ctx.accountId, oldState, newState: currentState(userId), created, notCreated };
});

// ── SearchSnippet/get ───────────────────────────────────────────────────────

function filterWords(filter: unknown, out: string[] = []): string[] {
  if (!isObject(filter)) return out;
  if (Array.isArray(filter.conditions) && filter.operator !== 'NOT') for (const c of filter.conditions) filterWords(c, out);
  for (const k of ['text', 'subject', 'body']) if (typeof filter[k] === 'string') out.push(...(filter[k] as string).split(/\s+/).filter((w) => w.length > 1));
  return out;
}

function highlight(text: string, words: string[], max: number): string | null {
  if (!text || !words.length) return null;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const first = text.search(re);
  if (first < 0) return null;
  const start = Math.max(0, first - Math.floor(max / 3));
  const slice = text.slice(start, start + max);
  return (start > 0 ? '…' : '') + escapeHtml(slice).replace(new RegExp(re.source.replace(/&/g, '&amp;'), 'gi'), '<mark>$1</mark>');
}

method('SearchSnippet/get', CAP.mail, (args, ctx) => {
  const wanted = Array.isArray(args.emailIds) ? args.emailIds.map((i: unknown) => String(resolveId(ctx, i))) : [];
  if (wanted.length > 500) throw new MethodError('requestTooLarge', 'At most 500 emails');
  const words = filterWords(args.filter);
  const rows = loadRows(ctx.user.id, wanted);
  return {
    accountId: ctx.accountId,
    list: wanted
      .filter((id: string) => rows.has(id))
      .map((id: string) => {
        const r = rows.get(id);
        return { emailId: id, subject: highlight(r.subject ?? '', words, 200), preview: highlight(r.text_body ?? r.snippet ?? '', words, 180) };
      }),
    notFound: wanted.filter((id: string) => !rows.has(id)),
  };
});

export { loadRows, pick };
