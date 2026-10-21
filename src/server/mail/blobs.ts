import { config } from '../config.js';
import { all, get, getMeta, run, setMeta, tx } from '../db/index.js';
import { blobName, decryptBlob, encryptBlob, isEncryptedBlob } from '../lib/crypto.js';
import { logger } from '../lib/log.js';
import { platform } from '../platform.js';

const log = logger('blobs');

/**
 * Content-addressed storage for raw messages and attachments (and avatars,
 * backups and exports). Backed by R2 (or the Durable Object itself when no
 * bucket is bound). Every file is encrypted with a key derived from
 * WREN_SECRET and named by a keyed hash of its contents, so the bucket alone
 * shows neither what a file says nor whether a known file is there.
 * Backups and exports pass their own (random) name.
 */
export async function putBlob(data: Uint8Array, name = blobName(data)): Promise<string> {
  await platform().blobs.put(name, encryptBlob(data));
  return name;
}

export async function getBlob(hash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob id');
  const data = await loadBlob(hash);
  if (!data) throw new Error(`Blob ${hash.slice(0, 12)}… is missing from storage`);
  return data;
}

/** A stored file, decrypted, or null when it's missing. Files stored before encryption come back as they are. */
export async function loadBlob(name: string): Promise<Buffer | null> {
  const data = await platform().blobs.get(name);
  if (!data) return null;
  if (!isEncryptedBlob(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    return decryptBlob(data);
  } catch {
    throw new Error(`Stored file ${name.slice(0, 12)}… can’t be decrypted: it was saved with a different WREN_SECRET`);
  }
}

/** Unreferenced files are kept this long, so restoring a backup or a point in time finds them. */
export const BLOB_GRACE_MS = 30 * 86_400_000;

/**
 * Remove blobs no longer referenced by any message, attachment or outbox row.
 * A blob is first marked when found unreferenced and deleted only after the
 * grace period.
 */
export async function collectGarbage(): Promise<{ removed: number; bytes: number }> {
  const referenced = new Set<string>();
  for (const r of all<{ h: string }>(
    `SELECT raw_blob AS h FROM messages WHERE raw_blob IS NOT NULL
     UNION SELECT body_blob FROM messages WHERE body_blob IS NOT NULL
     UNION SELECT blob FROM attachments
     UNION SELECT raw_blob FROM outbox
     UNION SELECT avatar_blob FROM users WHERE avatar_blob IS NOT NULL
     UNION SELECT blob FROM avatar_cache WHERE blob IS NOT NULL
     UNION SELECT j.value FROM backups b, json_each(b.parts) j`,
  )) {
    referenced.add(r.h);
  }
  const marked = new Map(all<{ key: string; seen_at: number }>('SELECT key, seen_at FROM blob_tombstones').map((r) => [r.key, r.seen_at]));
  const ts = Date.now();
  const cutoff = ts - 60 * 60 * 1000; // leave fresh blobs alone (in-flight writes)
  const doomed: string[] = [];
  const mark: string[] = [];
  let bytes = 0;
  let kept = 0;
  const store = platform().blobs;
  for await (const b of store.list()) {
    if (referenced.has(b.key) || b.uploaded > cutoff) {
      kept += b.size;
      continue;
    }
    const seen = marked.get(b.key);
    if (seen !== undefined && ts - seen > BLOB_GRACE_MS) {
      doomed.push(b.key);
      bytes += b.size;
    } else {
      kept += b.size;
      if (seen === undefined) mark.push(b.key);
    }
  }
  await store.delete(doomed);
  tx(() => {
    for (const key of mark) run('INSERT OR IGNORE INTO blob_tombstones (key, seen_at) VALUES (?, ?)', [key, ts]);
    for (const key of doomed) run('DELETE FROM blob_tombstones WHERE key = ?', [key]);
    // Files that are referenced again (e.g. after a restore) lose their mark.
    for (const key of marked.keys()) if (referenced.has(key)) run('DELETE FROM blob_tombstones WHERE key = ?', [key]);
  });
  // The full listing doubles as the storage measurement shown in the admin panel.
  setMeta('blob_bytes', kept);
  return { removed: doomed.length, bytes };
}

/**
 * Bytes in blob storage. Measured by the daily garbage collection; until it
 * has run, estimated from the database (listing a large R2 bucket on every
 * admin page view would be slow).
 */
export function blobStoreSize(): number {
  const measured = getMeta('blob_bytes');
  if (measured !== null) return Number(measured);
  const est = get<{ n: number | null }>(
    `SELECT (SELECT COALESCE(SUM(size), 0) FROM messages WHERE raw_blob IS NOT NULL) + (SELECT COALESCE(SUM(size), 0) FROM attachments) AS n`,
  );
  return est?.n ?? 0;
}

// ── Encrypting files stored before encryption ───────────────────────────────

/** Where the pass is: the last name looked at (names are visited in order) and how many files were left to look at. */
interface EncryptionPass {
  after: string;
  left: number;
}

const passState = (): EncryptionPass | 'done' | null => {
  const v = getMeta('blob_encryption');
  return v === 'done' ? v : v ? (JSON.parse(v) as EncryptionPass) : null;
};

let encrypting = false;
let retryAt = 0;

/**
 * Files from before encryption remain, and the pass may run now. Never with a
 * changed WREN_SECRET: files would be encrypted with a key the owner may still
 * replace with the original.
 */
export const blobEncryptionDue = () => passState() !== 'done' && !config.keyMismatch && Date.now() >= retryAt;

/** For Admin → System: null once every stored file is encrypted, else how many are left (null count while still counting). */
export function blobEncryptionStatus(): { left: number | null } | null {
  const s = passState();
  return s === 'done' ? null : { left: s?.left ?? null };
}

/**
 * Encrypt files stored before encryption, in place under the same name so
 * every reference stays valid. A batch per run of the background work,
 * resuming after the last name it looked at; true while more remains.
 * Safe to interrupt and run again: encrypted files are skipped.
 */
export async function continueBlobEncryption(limit = 50, budgetMs = 5000): Promise<boolean> {
  if (encrypting || !blobEncryptionDue()) return false;
  encrypting = true;
  try {
    const store = platform().blobs;
    const state = passState();
    if (state === 'done') return false;
    if (!state) {
      // First run: count the files, for the progress shown to admins.
      let left = 0;
      for await (const _ of store.list()) left++;
      setMeta('blob_encryption', JSON.stringify({ after: '', left } satisfies EncryptionPass));
      return true;
    }
    const started = Date.now();
    let n = 0;
    for await (const b of store.list(state.after)) {
      if (n++ >= limit || Date.now() - started > budgetMs) return true;
      await encryptInPlace(b.key);
      setMeta('blob_encryption', JSON.stringify({ after: b.key, left: Math.max(0, state.left - n) } satisfies EncryptionPass));
    }
    setMeta('blob_encryption', 'done');
    log.info('Every stored mail file is encrypted');
    return false;
  } catch (err) {
    // Don't spin on a storage outage: try again in a few minutes.
    retryAt = Date.now() + 10 * 60_000;
    throw err;
  } finally {
    encrypting = false;
  }
}

/**
 * Overwrite a plaintext file with its encrypted copy, only once that copy is
 * known to decrypt to the original, and check the stored copy is that copy.
 * shortcut: holds a file about three times over while doing so; fine for
 * mail-sized files (25 MB attachments), stream it if files get much bigger.
 */
async function encryptInPlace(key: string) {
  const store = platform().blobs;
  const plain = await store.get(key);
  if (!plain || isEncryptedBlob(plain)) return; // deleted meanwhile, or already encrypted
  const sealed = encryptBlob(plain);
  if (!decryptBlob(sealed).equals(plain)) throw new Error('Encrypting a stored file failed its check');
  await store.put(key, sealed, true);
  const stored = await store.get(key);
  if (stored && !sealed.equals(stored)) {
    await store.put(key, plain, true);
    throw new Error(`Stored file ${key.slice(0, 12)}… didn’t read back correctly after encrypting, so it was left as it was`);
  }
}
