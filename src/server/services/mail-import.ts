/**
 * Moving mail in and out:
 *
 *  - mbox files (Google Takeout, Thunderbird, Apple Mail…): the browser splits
 *    the file into messages and uploads them in batches.
 *  - IMAP (Gmail, Fastmail, iCloud, Yahoo…): a background job copies one
 *    folder slice at a time over cloudflare:sockets.
 *  - Export: a background job writes the whole mailbox as mbox parts, which
 *    the download stitches together.
 *
 * Messages are matched by Message-ID, so re-running an import never
 * duplicates mail; a message found in several folders (Gmail labels) gets one
 * copy with several labels.
 */
import type { Folder } from '../../shared/types.js';
import { all, get, insert, now, run } from '../db/index.js';
import { decryptJson, encryptJson, sha256 } from '../lib/crypto.js';
import { badRequest } from '../lib/http.js';
import { platform } from '../platform.js';
import { getBlob, putBlob } from '../mail/blobs.js';
import { loadBody } from '../mail/body.js';
import { buildMime } from '../mail/compose.js';
import { ImapConnection, type ImapOptions, type Mailbox } from '../mail/imap-client.js';
import { getHeader, parseMail } from '../mail/parse.js';
import { storeMessage } from '../mail/store.js';
import { getUser, quotaBytes } from './users.js';
import { createJob, registerJob, type JobRow } from './jobs.js';

export class QuotaExceeded extends Error {
  /** Retrying won't help. */
  readonly permanent = true;
}

export interface ImportOptions {
  folder: Folder;
  read: boolean;
  starred?: boolean;
  important?: boolean;
  labels?: string[];
  /** Fallback date (IMAP INTERNALDATE) when the message has none. */
  date?: number | null;
}

const LABEL_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#64748b'];

function ensureLabel(userId: number, name: string): number {
  const clean = name.trim().slice(0, 60);
  const existing = get<{ id: number }>('SELECT id FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE', [userId, clean]);
  if (existing) return existing.id;
  const n = get<{ c: number }>('SELECT COUNT(*) AS c FROM labels WHERE user_id = ?', [userId])?.c ?? 0;
  return insert('INSERT INTO labels (user_id, name, color, created_at) VALUES (?, ?, ?, ?)', [userId, clean, LABEL_COLORS[n % LABEL_COLORS.length], now()]);
}

/** Store one raw message. Returns 'imported' or 'duplicate'. */
export async function importRawMessage(userId: number, raw: Uint8Array, opts: ImportOptions): Promise<'imported' | 'duplicate'> {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const p = await parseMail(buf);
  const messageId = p.messageId || `import.${sha256(buf).slice(0, 32)}@wren.invalid`;
  const labelIds = (opts.labels ?? []).filter((l) => l.trim()).map((l) => ensureLabel(userId, l));
  const existing = get<{ id: number }>('SELECT id FROM messages WHERE user_id = ? AND message_id = ?', [userId, messageId]);
  if (existing) {
    for (const l of labelIds) run('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)', [existing.id, l]);
    if (opts.starred) run('UPDATE messages SET is_starred = 1 WHERE id = ?', [existing.id]);
    return 'duplicate';
  }
  const user = getUser(userId);
  if (!user) throw new Error('User not found');
  if (user.used_bytes + raw.length > quotaBytes(user)) throw new QuotaExceeded('The mailbox is full. Ask your administrator for more storage.');
  const direction = opts.folder === 'sent' ? 'out' : 'in';
  const id = await storeMessage({
    userId,
    folder: opts.folder,
    direction,
    messageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    replyTo: p.replyTo,
    subject: p.subject,
    text: p.text,
    html: p.html,
    date: p.date || opts.date || now(),
    size: raw.length,
    rawBlob: await putBlob(raw),
    attachments: p.attachments,
    isRead: opts.read || direction === 'out',
    isStarred: !!opts.starred,
    isImportant: !!opts.important,
    status: direction === 'out' ? 'sent' : undefined,
    source: 'import',
    labelIds,
  });
  if (opts.folder === 'trash') run('UPDATE messages SET trashed_at = ? WHERE id = ?', [now(), id]);
  return 'imported';
}

// ── mbox / Google Takeout ───────────────────────────────────────────────────

/** Split "Inbox,Important,\"Work, 2024\",Category Updates" respecting quotes. */
export function splitLabels(header: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Folder, flags and labels from Gmail's X-Gmail-Labels (or Wren's own export headers). */
export function optionsFromHeaders(headers: { gmail?: string; wrenFolder?: string; wrenLabels?: string; wrenFlags?: string }): ImportOptions | null {
  if (headers.wrenFolder) {
    const folder = (['inbox', 'sent', 'archive', 'spam', 'trash', 'drafts'].includes(headers.wrenFolder) ? headers.wrenFolder : 'archive') as Folder;
    if (folder === 'drafts') return null;
    const flags = headers.wrenFlags === undefined ? null : new Set(headers.wrenFlags.toLowerCase().split(/[\s,]+/).filter(Boolean));
    return {
      folder,
      read: flags ? flags.has('seen') : true,
      starred: !!flags?.has('starred'),
      important: !!flags?.has('important'),
      labels: headers.wrenLabels ? splitLabels(headers.wrenLabels) : [],
    };
  }
  const labels = splitLabels(headers.gmail ?? '');
  const has = (l: string) => labels.some((x) => x.toLowerCase() === l.toLowerCase());
  if (has('Chat') || has('Drafts')) return null;
  const folder: Folder = has('Trash') ? 'trash' : has('Spam') ? 'spam' : has('Inbox') ? 'inbox' : has('Sent') ? 'sent' : 'archive';
  const system = new Set(['inbox', 'sent', 'trash', 'spam', 'starred', 'important', 'unread', 'opened', 'archived', 'drafts', 'chat']);
  return {
    folder,
    read: !has('Unread'),
    starred: has('Starred'),
    important: has('Important'),
    labels: labels.filter((l) => !system.has(l.toLowerCase()) && !/^category /i.test(l)),
  };
}

export async function importMboxBatch(userId: number, messages: Uint8Array[]) {
  let imported = 0;
  let duplicates = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const raw of messages) {
    try {
      const p = await parseMail(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
      const opts = optionsFromHeaders({
        gmail: getHeader(p, 'x-gmail-labels'),
        wrenFolder: getHeader(p, 'x-wren-folder'),
        wrenLabels: getHeader(p, 'x-wren-labels'),
        wrenFlags: getHeader(p, 'x-wren-flags'),
      });
      if (!opts) {
        skipped++;
        continue;
      }
      if ((await importRawMessage(userId, raw, opts)) === 'imported') imported++;
      else duplicates++;
    } catch (err) {
      if (err instanceof QuotaExceeded) throw badRequest(err.message);
      errors.push((err as Error).message);
    }
  }
  return { imported, duplicates, skipped, failed: errors.length, errors: errors.slice(0, 5) };
}

// ── IMAP import job ─────────────────────────────────────────────────────────

interface PlannedFolder {
  name: string;
  display: string;
  folder: Folder;
  label: string | null;
  total: number;
}

interface ImapState {
  planned?: PlannedFolder[];
  index: number;
  lastUid: number;
  uidValidity: number;
  imported: number;
  duplicates: number;
  failed: number;
}

/** Decide where each IMAP folder goes. Virtual and system folders are skipped. */
export function planFolders(boxes: Mailbox[]): Omit<PlannedFolder, 'total'>[] {
  const flag = (b: Mailbox, f: string) => b.flags.some((x) => x.toLowerCase() === f.toLowerCase());
  const plan: Omit<PlannedFolder, 'total'>[] = [];
  for (const b of boxes) {
    if (flag(b, '\\Noselect') || flag(b, '\\NonExistent')) continue;
    if (flag(b, '\\Drafts') || flag(b, '\\Flagged') || flag(b, '\\Important') || /^\[gmail\]\/(starred|important|drafts|chats)$/i.test(b.name)) continue;
    const leaf = b.display.split(b.delimiter ?? '/').pop() ?? b.display;
    if (b.name.toUpperCase() === 'INBOX') plan.push({ name: b.name, display: 'Inbox', folder: 'inbox', label: null });
    else if (flag(b, '\\Sent') || /^(sent|sent items|sent mail|sent messages)$/i.test(leaf)) plan.push({ name: b.name, display: b.display, folder: 'sent', label: null });
    else if (flag(b, '\\Junk') || /^(spam|junk|junk e-?mail|bulk mail)$/i.test(leaf)) plan.push({ name: b.name, display: b.display, folder: 'spam', label: null });
    else if (flag(b, '\\Trash') || /^(trash|deleted|deleted items|deleted messages|bin)$/i.test(leaf)) plan.push({ name: b.name, display: b.display, folder: 'trash', label: null });
    else if (flag(b, '\\All') || flag(b, '\\Archive') || /^(all mail|archive)$/i.test(leaf)) plan.push({ name: b.name, display: b.display, folder: 'archive', label: null });
    else if (/^\[gmail\]$/i.test(b.name)) continue;
    else plan.push({ name: b.name, display: b.display, folder: 'archive', label: b.display.replace(/^INBOX[./]/i, '') });
  }
  // Inbox first (so mail in the inbox stays there), sent next, user folders, then the catch-alls.
  const rank = (p: Omit<PlannedFolder, 'total'>) => (p.folder === 'inbox' ? 0 : p.folder === 'sent' ? 1 : p.label ? 2 : p.folder === 'archive' ? 3 : 4);
  return plan.sort((a, b) => rank(a) - rank(b));
}

export async function startImapImport(userId: number, opts: ImapOptions): Promise<number> {
  // Check the connection and credentials now, so mistakes show up right away.
  const conn = await ImapConnection.open(opts);
  let folders: number;
  try {
    folders = (await conn.list()).length;
  } finally {
    await conn.close();
  }
  if (!folders) throw badRequest('The account has no folders to import');
  if (get(`SELECT 1 FROM jobs WHERE user_id = ? AND kind = 'imap_import' AND status IN ('queued','running')`, [userId])) throw badRequest('An import is already running');
  const state: ImapState = { index: 0, lastUid: 0, uidValidity: 0, imported: 0, duplicates: 0, failed: 0 };
  return createJob(userId, 'imap_import', encryptJson({ ...opts, label: `${opts.username} (${opts.host})` }), state);
}

const IMAP_BATCH = 25;
const STEP_BUDGET_MS = 20_000;

registerJob('imap_import', async (job: JobRow, state: ImapState) => {
  if (!job.config) throw new Error('Import credentials are missing');
  const cfg = decryptJson(job.config) as ImapOptions & { label: string };
  const conn = await ImapConnection.open(cfg);
  const started = now();
  const before = state.imported + state.duplicates + state.failed;
  try {
    if (!state.planned) {
      const plan = planFolders(await conn.list());
      state.planned = [];
      for (const p of plan) state.planned.push({ ...p, total: (await conn.status(p.name).catch(() => ({ messages: 0 }))).messages });
    }
    while (state.index < state.planned.length && now() - started < STEP_BUDGET_MS) {
      const f = state.planned[state.index];
      const sel = await conn.select(f.name);
      if (state.uidValidity && sel.uidValidity !== state.uidValidity) state.lastUid = 0; // folder was rebuilt; Message-IDs keep it safe
      state.uidValidity = sel.uidValidity;
      const uids = sel.exists ? await conn.uidsAfter(state.lastUid) : [];
      if (!uids.length) {
        state.index++;
        state.lastUid = 0;
        state.uidValidity = 0;
        continue;
      }
      for (let i = 0; i < uids.length && now() - started < STEP_BUDGET_MS; i += IMAP_BATCH) {
        const batch = uids.slice(i, i + IMAP_BATCH);
        for (const m of await conn.fetch(batch)) {
          try {
            const r = await importRawMessage(job.user_id, m.raw, {
              folder: f.folder,
              read: m.flags.some((x) => x.toLowerCase() === '\\seen'),
              starred: m.flags.some((x) => x.toLowerCase() === '\\flagged'),
              labels: f.label ? [f.label] : [],
              date: m.internalDate,
            });
            if (r === 'imported') state.imported++;
            else state.duplicates++;
          } catch (err) {
            if (err instanceof QuotaExceeded) throw err;
            state.failed++;
          }
        }
        state.lastUid = batch[batch.length - 1];
      }
    }
  } catch (err) {
    // Keep what this run already copied; the next run picks up from there (and hits the error again if it persists).
    if (state.imported + state.duplicates + state.failed === before) throw err;
    return { state, done: false, progress: imapProgress(cfg.label, state), delayMs: 30_000 };
  } finally {
    await conn.close();
  }
  const done = state.index >= (state.planned?.length ?? 0);
  if (done) run('UPDATE jobs SET config = NULL WHERE id = ?', [job.id]); // forget the password
  return { state, done, progress: imapProgress(cfg.label, state), delayMs: 500 };
});

function imapProgress(account: string, state: ImapState) {
  const folders = state.planned?.length ?? 0;
  return {
    account,
    imported: state.imported,
    duplicates: state.duplicates,
    failed: state.failed,
    total: (state.planned ?? []).reduce((n, f) => n + f.total, 0),
    folder: state.index < folders ? state.planned![state.index].display : null,
    folderIndex: Math.min(state.index + 1, folders),
    folders,
  };
}

// ── Export job (mbox) ───────────────────────────────────────────────────────

interface ExportState {
  afterId: number;
  parts: string[];
  messages: number;
  bytes: number;
}

const EXPORT_BATCH = 100;
const PART_BYTES = 4 * 1024 * 1024;
/** Stop a step after reading this much, so one run stays short. */
const EXPORT_STEP_BYTES = 32 * 1024 * 1024;
/** Finished exports are kept for a week. */
const EXPORT_KEEP_MS = 7 * 86_400_000;

function asctime(ts: number): string {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** mboxrd: a "From " line inside a message gets one more ">" so it can't split the file. */
export function mboxEntry(envelopeFrom: string, date: number, raw: string, extraHeaders: string): string {
  const body = raw.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
  return `From ${envelopeFrom || 'MAILER-DAEMON'} ${asctime(date)}\n${extraHeaders}${body}${body.endsWith('\n') ? '' : '\n'}\n`;
}

export function startExport(userId: number): number {
  if (get(`SELECT 1 FROM jobs WHERE user_id = ? AND kind = 'export' AND status IN ('queued','running')`, [userId])) throw badRequest('An export is already running');
  return createJob(userId, 'export', null, { afterId: 0, parts: [], messages: 0, bytes: 0 } satisfies ExportState);
}

const hexKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Drop X-Wren-* headers an earlier export added, so they aren't repeated. */
function stripWrenHeaders(raw: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  if (end < 0) return raw;
  return raw.slice(0, end).replace(/^X-Wren-(Folder|Labels|Flags):.*(\r?\n[ \t].*)*(\r?\n|$)/gim, '') + raw.slice(end);
}

registerJob('export', async (job: JobRow, state: ExportState) => {
  const rows = all<any>('SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', [job.user_id, state.afterId, EXPORT_BATCH]);
  let chunk = '';
  let processed = 0;
  let stepBytes = 0;
  for (const r of rows) {
    let raw: string;
    if (r.raw_blob) {
      raw = (await getBlob(r.raw_blob)).toString('latin1');
    } else {
      // Drafts and system notes have no stored original: rebuild one.
      await loadBody(r);
      raw = (
        await buildMime({
          from: { address: r.from_addr || 'unknown@localhost', name: r.from_name },
          to: JSON.parse(r.to_json),
          cc: JSON.parse(r.cc_json),
          subject: r.subject,
          html: r.html_body,
          text: r.text_body,
          messageId: r.message_id || undefined,
          date: new Date(r.date),
        })
      ).raw.toString('latin1');
    }
    const labels = all<{ name: string }>('SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?', [r.id]).map((l) => l.name);
    const flags = [r.is_read && 'seen', r.is_starred && 'starred', r.is_important && 'important'].filter(Boolean).join(' ');
    const extra =
      `X-Wren-Folder: ${r.folder}\n` +
      `X-Wren-Flags: ${flags}\n` +
      (labels.length ? `X-Wren-Labels: ${labels.map((l) => (l.includes(',') ? `"${l.replace(/"/g, '')}"` : l)).join(', ')}\n` : '');
    chunk += mboxEntry(r.from_addr, r.date, stripWrenHeaders(raw), extra);
    state.afterId = r.id;
    state.messages++;
    processed++;
    stepBytes += raw.length;
    if (chunk.length >= PART_BYTES) {
      state.parts.push(await writePart(chunk));
      state.bytes += chunk.length;
      chunk = '';
    }
    if (stepBytes >= EXPORT_STEP_BYTES) break;
  }
  if (chunk) {
    state.parts.push(await writePart(chunk));
    state.bytes += chunk.length;
  }
  const done = processed === rows.length && rows.length < EXPORT_BATCH;
  const total = get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?', [job.user_id])?.c ?? 0;
  return { state, done, progress: { messages: state.messages, total: Math.max(total, state.messages), bytes: state.bytes, parts: state.parts.length }, delayMs: 100 };
});

async function writePart(text: string): Promise<string> {
  const key = hexKey();
  // latin1 round-trips the original bytes exactly.
  await platform().blobs.put(key, Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
  return key;
}

/** Stream a finished export's parts as one mbox file. */
export function exportStream(job: JobRow): ReadableStream<Uint8Array> {
  const parts = (JSON.parse(job.state) as ExportState).parts;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= parts.length) return controller.close();
      const data = await platform().blobs.get(parts[i++]);
      if (!data) return controller.error(new Error('This export has expired. Start a new one.'));
      controller.enqueue(data);
    },
  });
}

/** Delete a job; an export's files go with it. */
export async function deleteJob(job: JobRow) {
  if (job.kind === 'export') {
    const parts = (JSON.parse(job.state || '{}') as Partial<ExportState>).parts ?? [];
    if (parts.length) await platform().blobs.delete(parts);
  }
  run('DELETE FROM jobs WHERE id = ?', [job.id]);
}

/** Exports older than a week and finished imports older than a month go away. */
export async function pruneJobs() {
  const ts = now();
  const old = all<JobRow>(
    `SELECT * FROM jobs WHERE (kind = 'export' AND created_at < ?) OR (status IN ('done','failed','cancelled') AND updated_at < ?)`,
    [ts - EXPORT_KEEP_MS, ts - 30 * 86_400_000],
  );
  for (const job of old) await deleteJob(job);
}
