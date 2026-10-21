import { config } from '../config.js';
import { all, get, getMeta, run, setMeta, tx } from '../db/index.js';
import { blobName, decryptBlob, encryptBlob, isEncryptedBlob, sha256 } from '../lib/crypto.js';
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
 * While WREN_SECRET differs from the data's key, files are stored as they are,
 * so they read whichever key ends up in place (the encryption pass gets them later).
 */
export async function putBlob(data: Uint8Array, name = blobName(data)): Promise<string> {
  await platform().blobs.put(name, config.keyMismatch ? data : encryptBlob(data));
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
 * Remove blobs no longer referenced by any message, attachment, outbox row or private link.
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
     UNION SELECT body_blob FROM private_links WHERE body_blob IS NOT NULL
     UNION SELECT json_extract(j.value, '$.blob') FROM private_links p, json_each(p.attachments) j
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

/**
 * Where the pass is: the last name looked at (names are visited in order), how
 * many files were left to look at, the file being encrypted right now (still
 * set on the next run when that attempt never finished) and how many files
 * were left as they were.
 */
interface EncryptionPass {
  after: string;
  left: number;
  trying?: string;
  skipped?: number;
  done?: boolean;
}

const passState = (): EncryptionPass | null => {
  const v = getMeta('blob_encryption');
  return v === 'done' ? { after: '', left: 0, done: true } : v ? (JSON.parse(v) as EncryptionPass) : null;
};
const savePass = (s: EncryptionPass) => setMeta('blob_encryption', JSON.stringify(s));

/** Look at every stored file again, e.g. after files were stored unencrypted while WREN_SECRET was changed. */
export const restartBlobEncryption = () => run(`DELETE FROM _meta WHERE key = 'blob_encryption'`);

let encrypting = false;
let retryAt = 0;

/**
 * Files from before encryption remain, and the pass may run now. Never with a
 * changed WREN_SECRET: files would be encrypted with a key the owner may still
 * replace with the original.
 */
export const blobEncryptionDue = () => !passState()?.done && !config.keyMismatch && Date.now() >= retryAt;

/**
 * For Admin → System: null once every stored file is encrypted, else how many
 * are left (null while still counting) and how many were left unencrypted.
 */
export function blobEncryptionStatus(): { left: number | null; skipped: number; done: boolean } | null {
  const s = passState();
  if (s?.done && !s.skipped) return null;
  return { left: s?.left ?? null, skipped: s?.skipped ?? 0, done: !!s?.done };
}

/**
 * Encrypt files stored before encryption, in place under the same name so
 * every reference stays valid. A batch per run of the background work,
 * resuming after the last name it looked at; true while more remains.
 * Safe to interrupt and run again: encrypted files are skipped. A file whose
 * attempt failed or never finished (say it didn't fit in memory) is left as
 * it was on the next run, so one file can't hold up the pass.
 */
export async function continueBlobEncryption(limit = 50, budgetMs = 5000): Promise<boolean> {
  if (encrypting || !blobEncryptionDue()) return false;
  encrypting = true;
  try {
    const store = platform().blobs;
    const state = passState();
    if (state?.done) return false;
    if (!state) {
      // First run: count the files, for the progress shown to admins.
      let left = 0;
      for await (const _ of store.list()) left++;
      savePass({ after: '', left });
      return true;
    }
    const started = Date.now();
    let { after, left, skipped = 0 } = state;
    let n = 0;
    for await (const b of store.list(state.after)) {
      if (n++ >= limit || Date.now() - started > budgetMs) return true;
      if (b.key === state.trying) {
        log.warn(`Left stored file ${b.key.slice(0, 12)}… unencrypted: encrypting it failed or didn’t finish last time`);
        skipped++;
      } else {
        // Saved first: if this attempt brings the whole object down, the next run moves past the file.
        savePass({ after, left, skipped, trying: b.key });
        await encryptInPlace(b.key);
      }
      after = b.key;
      left = Math.max(0, left - 1);
      savePass({ after, left, skipped });
    }
    savePass({ after, left: 0, skipped, done: true });
    log.info(skipped ? `Every stored mail file is encrypted, except ${skipped} left as they were` : 'Every stored mail file is encrypted');
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
 * Overwrite a plaintext file with its encrypted copy, then check the stored
 * copy is that copy, putting the original back if not. Holds the file twice
 * at most (a raw message with a 25 MB attachment is about 34 MB).
 */
async function encryptInPlace(key: string) {
  const store = platform().blobs;
  const plain = await store.get(key);
  if (!plain || isEncryptedBlob(plain)) return; // deleted meanwhile, or already encrypted
  let sealed: Buffer | null = encryptBlob(plain);
  const digest = sha256(sealed);
  await store.put(key, sealed, true);
  sealed = null; // let go of it before reading the stored copy back
  const stored = await store.get(key);
  if (stored && sha256(stored) !== digest) {
    await store.put(key, plain, true);
    throw new Error(`Stored file ${key.slice(0, 12)}… didn’t read back correctly after encrypting, so it was left as it was`);
  }
}
