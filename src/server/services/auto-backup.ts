/**
 * Automatic backups: once a day, the portable export (see backup.ts) is
 * written to blob storage (R2) in parts, and the last N are kept. A backup
 * runs in steps from the Durable Object alarm, so a large database never
 * has to fit in one invocation. Admins can also back up on demand,
 * download any backup, and the owner can restore one.
 *
 * Message files (raw MIME, attachments) are already in R2 and are kept for
 * 30 days after nothing references them, so a restore finds them.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { logger } from '../lib/log.js';
import { platform } from '../platform.js';
import { getSettings } from '../settings.js';
import { raiseAlert, resolveAlert } from './alerts.js';
import { dataTables, exportHeader } from './backup.js';

const log = logger('auto-backup');
const PART_BYTES = 8 * 1024 * 1024;
/** Work per alarm, so other background jobs keep running. */
const STEP_MS = 10_000;
const HOUR = 3_600_000;

export interface BackupRow {
  id: number;
  kind: 'auto' | 'manual';
  status: 'running' | 'done' | 'failed';
  parts: string;
  state: string;
  rows: number;
  bytes: number;
  error: string | null;
  created_by: number | null;
  created_at: number;
  finished_at: number | null;
}

interface State {
  /** The header line has been written. */
  header?: boolean;
  /** Next table (by name, in case tables change between steps) and the last rowid written from it. */
  table?: string;
  after?: number;
}

export function backupDto(b: BackupRow) {
  return {
    id: b.id,
    kind: b.kind,
    status: b.status,
    rows: b.rows,
    bytes: b.bytes,
    parts: (JSON.parse(b.parts) as string[]).length,
    error: b.error,
    createdAt: b.created_at,
    finishedAt: b.finished_at,
    createdBy: b.created_by ? (get<{ email: string }>('SELECT email FROM users WHERE id = ?', [b.created_by])?.email ?? null) : null,
  };
}

export function listBackups(): BackupRow[] {
  return all<BackupRow>('SELECT * FROM backups ORDER BY id DESC LIMIT 100');
}

/** Start a backup (or return the one already running). */
export function startBackup(kind: 'auto' | 'manual', userId: number | null = null): BackupRow {
  const running = get<BackupRow>(`SELECT * FROM backups WHERE status = 'running' ORDER BY id LIMIT 1`);
  if (running) return running;
  const id = insert(`INSERT INTO backups (kind, status, created_by, created_at) VALUES (?, 'running', ?, ?)`, [kind, userId, now()]);
  platform().wake?.(now());
  return get<BackupRow>('SELECT * FROM backups WHERE id = ?', [id])!;
}

/** Today's scheduled time (UTC). */
function slot(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), getSettings()['backups.hour']);
}

/** The last automatic backup that counts for today: a failed one is retried after an hour. */
function lastAutoAt(ts: number): number {
  return get<{ t: number | null }>(`SELECT MAX(created_at) AS t FROM backups WHERE kind = 'auto' AND (status <> 'failed' OR created_at > ?)`, [ts - HOUR])?.t ?? 0;
}

/** When the next automatic backup is due (Infinity when they're off). */
export function nextBackupAt(ts = now()): number {
  if (get(`SELECT 1 FROM backups WHERE status = 'running'`)) return ts;
  if (!getSettings()['backups.enabled']) return Infinity;
  const today = slot(ts);
  const last = lastAutoAt(ts);
  if (last >= today) return get(`SELECT 1 FROM backups WHERE kind = 'auto' AND status = 'failed' AND created_at = ?`, [last]) ? last + HOUR : today + 24 * HOUR;
  return today;
}

/** Called from the alarm: start today's backup when due, and move a running one forward. */
export async function runBackups(ts = now()) {
  if (getSettings()['backups.enabled'] && ts >= nextBackupAt(ts) && !get(`SELECT 1 FROM backups WHERE status = 'running'`)) {
    startBackup('auto');
  }
  const b = get<BackupRow>(`SELECT * FROM backups WHERE status = 'running' ORDER BY id LIMIT 1`);
  if (b) await stepBackup(b);
}

/** Write the next stretch of a backup. Returns true when it finished. */
export async function stepBackup(b: BackupRow, budgetMs = STEP_MS, partBytes = PART_BYTES): Promise<boolean> {
  const started = Date.now();
  const parts: string[] = JSON.parse(b.parts);
  const state: State = JSON.parse(b.state || '{}');
  let rows = b.rows;
  let bytes = b.bytes;
  try {
    const tables = dataTables();
    let ti = state.table ? Math.max(0, tables.indexOf(state.table)) : 0;
    if (state.table && !tables.includes(state.table)) ti = tables.length; // table gone (schema changed): carry on
    let after = state.after ?? Number.MIN_SAFE_INTEGER;
    let text = state.header ? '' : JSON.stringify(exportHeader()) + '\n';
    const enc = new TextEncoder();
    const flush = async () => {
      if (!text) return;
      const data = enc.encode(text);
      const key = randomKey();
      await platform().blobs.put(key, data);
      parts.push(key);
      bytes += data.length;
      text = '';
      // Progress is saved after every part, so a crash resumes here.
      run('UPDATE backups SET parts = ?, state = ?, rows = ?, bytes = ? WHERE id = ?', [
        JSON.stringify(parts),
        JSON.stringify({ header: true, table: tables[ti], after } satisfies State),
        rows,
        bytes,
        b.id,
      ]);
    };
    while (ti < tables.length) {
      const t = tables[ti];
      const page = all<Record<string, unknown>>(`SELECT rowid AS "__rowid", * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 500`, [after]);
      if (!page.length) {
        ti++;
        after = Number.MIN_SAFE_INTEGER;
        continue;
      }
      after = Number(page[page.length - 1].__rowid);
      for (const r of page) {
        delete r.__rowid;
        text += JSON.stringify({ t, r }) + '\n';
      }
      rows += page.length;
      if (text.length >= partBytes) {
        await flush();
        if (Date.now() - started >= budgetMs) return false;
      }
    }
    await flush();
    run(`UPDATE backups SET status = 'done', finished_at = ?, rows = ?, bytes = ?, parts = ?, state = '{}' WHERE id = ?`, [now(), rows, bytes, JSON.stringify(parts), b.id]);
    log.info(`Backup ${b.id} finished: ${rows} rows, ${bytes} bytes`);
    if (b.kind === 'auto') resolveAlert('backup', 'auto');
    await pruneBackups();
    return true;
  } catch (err) {
    const message = (err as Error).message || String(err);
    log.warn(`Backup ${b.id} failed`, err);
    run(`UPDATE backups SET status = 'failed', error = ?, finished_at = ?, parts = '[]' WHERE id = ?`, [message.slice(0, 500), now(), b.id]);
    if (parts.length) await platform().blobs.delete(parts).catch(() => {});
    if (b.kind === 'auto') {
      await raiseAlert({ kind: 'backup', key: 'auto', severity: 'warn', title: 'The automatic backup failed', detail: message, link: '/admin/system' }).catch(() => {});
    }
    return true;
  }
}

function randomKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keep the newest N automatic backups (manual ones stay until deleted), and clear out failed ones after a week. */
export async function pruneBackups() {
  const keep = Math.max(1, getSettings()['backups.keep']);
  const old = all<BackupRow>(`SELECT * FROM backups WHERE kind = 'auto' AND status = 'done' ORDER BY id DESC LIMIT -1 OFFSET ?`, [keep]);
  const failed = all<BackupRow>(`SELECT * FROM backups WHERE status = 'failed' AND created_at < ?`, [now() - 7 * 24 * HOUR]);
  for (const b of [...old, ...failed]) await deleteBackup(b);
}

export async function deleteBackup(b: BackupRow) {
  const parts: string[] = JSON.parse(b.parts);
  if (parts.length) await platform().blobs.delete(parts);
  run('DELETE FROM backups WHERE id = ?', [b.id]);
}

/** A finished backup as one export file. */
export function backupStream(b: BackupRow): ReadableStream<Uint8Array> {
  const parts: string[] = JSON.parse(b.parts);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= parts.length) return controller.close();
      const data = await platform().blobs.get(parts[i++]);
      if (!data) return controller.error(new Error('Part of this backup is missing from storage'));
      controller.enqueue(data);
    },
  });
}

export function lastSuccessfulBackup(): BackupRow | undefined {
  return get<BackupRow>(`SELECT * FROM backups WHERE status = 'done' ORDER BY finished_at DESC LIMIT 1`);
}
