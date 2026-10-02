import { all, get, getMeta, run, setMeta, tx } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { platform } from '../platform.js';

/**
 * Content-addressed storage for raw messages and attachments.
 * Backed by R2 (or the Durable Object itself when no bucket is bound).
 */
export async function putBlob(data: Uint8Array): Promise<string> {
  const hash = sha256(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  await platform().blobs.put(hash, data);
  return hash;
}

export async function getBlob(hash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob id');
  const data = await platform().blobs.get(hash);
  if (!data) throw new Error(`Blob ${hash.slice(0, 12)}… is missing from storage`);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
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
