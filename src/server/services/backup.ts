/**
 * Portable backups: a newline-delimited JSON export of the database that works
 * the same on Cloudflare and on a self-hosted copy, and can be restored on either.
 *
 *   {"format":"wren-export","schema":2,…}        ← header
 *   {"t":"users","r":{"id":1,"email":…}}          ← one line per row
 *
 * Message files (raw MIME, attachments, large bodies) stay in blob storage (R2
 * or the data directory) and are not part of the export.
 */
import { APP_VERSION } from '../../shared/brand.js';
import { all, get, getMeta, run, setMeta, tx } from '../db/index.js';
import { migrations } from '../db/migrations.js';
import { encryptJson, secretFingerprint } from '../lib/crypto.js';
import { platform } from '../platform.js';
import { invalidateSettings } from '../settings.js';
import { indexMessage } from '../mail/store.js';

export const EXPORT_FORMAT = 'wren-export';

/** Never exported: sessions (everyone signs in again), rate-limit counters and internal state. */
const SKIP = new Set(['sessions', 'login_attempts', '_meta', '_blobs', 'blob_tombstones', 'webauthn_challenges', 'known_devices', 'backups']);

export interface ExportHeader {
  format: typeof EXPORT_FORMAT;
  app: string;
  schema: number;
  exportedAt: number;
  /** Identifies the encryption key (not the key itself). */
  keyFingerprint: string;
}

/** Tables in creation order, which is also foreign-key order. */
export function dataTables(): string[] {
  return all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid`)
    .map((r) => r.name)
    .filter((n) => !SKIP.has(n) && !n.startsWith('sqlite_') && !n.startsWith('_cf_') && !n.startsWith('messages_fts'));
}

function columns(table: string): Set<string> {
  return new Set(all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name));
}

export function exportHeader(): ExportHeader {
  return { format: EXPORT_FORMAT, app: APP_VERSION, schema: migrations.length, exportedAt: Date.now(), keyFingerprint: secretFingerprint() };
}

/** Stream the export a page at a time, so large databases never sit in memory. */
export function exportStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const tables = dataTables();
  let started = false;
  let ti = 0;
  let after = Number.MIN_SAFE_INTEGER;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(JSON.stringify(exportHeader()) + '\n'));
        return;
      }
      while (ti < tables.length) {
        const t = tables[ti];
        const rows = all<Record<string, unknown>>(`SELECT rowid AS "__rowid", * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 500`, [after]);
        if (!rows.length) {
          ti++;
          after = Number.MIN_SAFE_INTEGER;
          continue;
        }
        after = Number(rows[rows.length - 1].__rowid);
        let out = '';
        for (const r of rows) {
          delete r.__rowid;
          out += JSON.stringify({ t, r }) + '\n';
        }
        controller.enqueue(enc.encode(out));
        return;
      }
      controller.close();
    },
  });
}

export function exportFilename(): string {
  return `wren-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf.trim();
}

export class RestoreError extends Error {}

export interface RestoreResult {
  header: ExportHeader;
  rows: Record<string, number>;
  skipped: number;
  /** The backup was encrypted with a different key: 2FA was turned off and provider credentials must be re-entered. */
  keyMismatch: boolean;
}

/**
 * Replace all data with the contents of an export. On Workers the import is
 * applied in batches with a point-in-time bookmark taken first, so a failure
 * rolls the whole database back; elsewhere it runs in a single transaction.
 */
export async function restoreExport(body: ReadableStream<Uint8Array>, opts: { allowKeyMismatch?: boolean } = {}): Promise<RestoreResult> {
  const it = lines(body);
  const first = await it.next();
  let header: ExportHeader;
  try {
    header = JSON.parse(first.value ?? '');
  } catch {
    throw new RestoreError('This is not a Wren export file.');
  }
  if (header?.format !== EXPORT_FORMAT) throw new RestoreError('This is not a Wren export file.');
  if (header.schema > migrations.length) throw new RestoreError(`This export comes from a newer version of Wren (${header.app}). Update this instance first.`);
  const keyMismatch = header.keyFingerprint !== secretFingerprint();
  if (keyMismatch && !opts.allowKeyMismatch) {
    throw new RestoreError('KEY_MISMATCH');
  }

  const tables = dataTables();
  const known = new Map(tables.map((t) => [t, columns(t)]));
  const counts: Record<string, number> = {};
  let skipped = 0;

  const wipe = () => {
    run(`INSERT INTO messages_fts (messages_fts) VALUES ('delete-all')`);
    run('DELETE FROM sessions');
    run('DELETE FROM login_attempts');
    for (const t of [...tables].reverse()) run(`DELETE FROM "${t}"`);
  };
  const insertRow = (line: string) => {
    let rec: { t: string; r: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      throw new RestoreError('The export file is damaged (invalid line).');
    }
    const cols = known.get(rec.t);
    if (!cols) {
      skipped++;
      return;
    }
    const keys = Object.keys(rec.r).filter((k) => cols.has(k));
    try {
      run(`INSERT INTO "${rec.t}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => rec.r[k]));
      counts[rec.t] = (counts[rec.t] ?? 0) + 1;
    } catch {
      // A row whose parent was deleted while the export was being written.
      skipped++;
    }
  };
  const finish = () => {
    if (keyMismatch) {
      // Data encrypted with the other instance's key can't be read here.
      run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL');
      run(`UPDATE providers SET config = ?, enabled = 0, last_error = 'Re-enter the settings: this provider was restored from a backup made with a different encryption key.'`, [
        encryptJson({}),
      ]);
    }
    // Rebuild the search index in the background (see runDueWork).
    setMeta('fts_rebuild_after', 0);
  };

  const pit = platform().pointInTime;
  // Local `wrangler dev` has no point-in-time recovery; fall back to one transaction there.
  const bookmark = pit ? await pit.current().catch(() => null) : null;
  if (pit && bookmark) {
    try {
      tx(wipe);
      let batch: string[] = [];
      for await (const line of it) {
        batch.push(line);
        if (batch.length >= 500) {
          const b = batch;
          tx(() => b.forEach(insertRow));
          batch = [];
        }
      }
      tx(() => {
        batch.forEach(insertRow);
        finish();
      });
    } catch (err) {
      await pit.restore(bookmark);
      throw err;
    }
  } else {
    const rest: string[] = [];
    for await (const line of it) rest.push(line);
    tx(() => {
      wipe();
      rest.forEach(insertRow);
      finish();
    });
  }
  invalidateSettings();
  return { header, rows: counts, skipped, keyMismatch };
}

/** Compare the encryption key with the one recorded when the database was created. */
export function verifyEncryptionKey(): boolean {
  const fp = secretFingerprint();
  const stored = getMeta('key_fingerprint');
  if (stored === null) {
    setMeta('key_fingerprint', fp);
    return true;
  }
  return stored === fp;
}

/** Index up to `limit` messages after a restore. Returns true while work remains. */
export function continueSearchRebuild(limit = 2000): boolean {
  const after = getMeta('fts_rebuild_after');
  if (after === null) return false;
  const ids = all<{ id: number }>('SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT ?', [Number(after), limit]).map((r) => r.id);
  if (!ids.length) {
    run(`DELETE FROM _meta WHERE key = 'fts_rebuild_after'`);
    return false;
  }
  tx(() => ids.forEach(indexMessage));
  setMeta('fts_rebuild_after', ids[ids.length - 1]);
  return true;
}

export function searchRebuildPending(): boolean {
  return getMeta('fts_rebuild_after') !== null;
}

export function messageCount(): number {
  return get<{ c: number }>('SELECT COUNT(*) AS c FROM messages')?.c ?? 0;
}
