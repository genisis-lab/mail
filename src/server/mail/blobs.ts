import { all } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { platform } from '../platform.js';

/**
 * Content-addressed storage for raw messages and attachments.
 * Backed by the filesystem on Node and by R2 on Cloudflare Workers.
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

/** Remove blobs no longer referenced by any message, attachment or outbox row. */
export async function collectGarbage(): Promise<{ removed: number; bytes: number }> {
  const referenced = new Set<string>();
  for (const r of all<{ h: string }>(
    `SELECT raw_blob AS h FROM messages WHERE raw_blob IS NOT NULL
     UNION SELECT blob FROM attachments
     UNION SELECT raw_blob FROM outbox`,
  )) {
    referenced.add(r.h);
  }
  let removed = 0;
  let bytes = 0;
  const cutoff = Date.now() - 60 * 60 * 1000; // leave fresh blobs alone (in-flight writes)
  const store = platform().blobs;
  for await (const b of store.list()) {
    if (referenced.has(b.key) || b.uploaded > cutoff) continue;
    await store.delete(b.key);
    removed++;
    bytes += b.size;
  }
  return { removed, bytes };
}

export async function blobStoreSize(): Promise<number> {
  let total = 0;
  for await (const b of platform().blobs.list()) total += b.size;
  return total;
}
