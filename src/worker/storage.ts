import type { BlobStore, SqlDriver } from '../server/platform.js';

/** SQL driver backed by a SQLite Durable Object (synchronous API). */
export function doSqlDriver(storage: DurableObjectStorage): SqlDriver {
  const sql = storage.sql;
  const conv = (params: unknown[]) =>
    params.map((v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v));
  return {
    all: (q, params) => sql.exec(q, ...conv(params)).toArray(),
    run: (q, params) => {
      sql.exec(q, ...conv(params)).toArray();
      const r = sql.exec<{ c: number; id: number }>('SELECT changes() AS c, last_insert_rowid() AS id').one();
      return { changes: Number(r.c), lastInsertRowid: Number(r.id) };
    },
    exec: (q) => {
      sql.exec(q).toArray();
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}

/** Blob store on R2 — the recommended option for message bodies and attachments. */
export function r2BlobStore(bucket: R2Bucket, prefix = 'blobs/'): BlobStore {
  return {
    async put(key, data, replace) {
      if (!replace && (await bucket.head(prefix + key))) return;
      await bucket.put(prefix + key, data);
    },
    async get(key) {
      const obj = await bucket.get(prefix + key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000).map((k) => prefix + k));
    },
    async *list(after) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, startAfter: after && prefix + after, limit: 1000 });
        for (const o of page.objects) yield { key: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded.getTime() };
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

const CHUNK = 1024 * 1024; // Durable Object SQLite values are limited to 2 MB.

/** Fallback blob store inside the Durable Object's own SQLite (no R2 needed). */
export function sqlBlobStore(storage: DurableObjectStorage): BlobStore {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS _blobs (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, uploaded INTEGER NOT NULL, PRIMARY KEY (key, idx))`).toArray();
  return {
    async put(key, data, replace) {
      if (!replace && sql.exec('SELECT 1 FROM _blobs WHERE key = ? AND idx = 0', key).toArray().length) return;
      const ts = Date.now();
      storage.transactionSync(() => {
        if (replace) sql.exec('DELETE FROM _blobs WHERE key = ?', key).toArray();
        for (let i = 0, idx = 0; i < Math.max(data.length, 1); i += CHUNK, idx++) {
          // A Buffer's slice() is a view into a possibly larger (shared) ArrayBuffer: copy exactly this part's bytes.
          const part = data.subarray(i, i + CHUNK);
          sql.exec('INSERT INTO _blobs (key, idx, data, size, uploaded) VALUES (?, ?, ?, ?, ?)', key, idx, part.buffer.slice(part.byteOffset, part.byteOffset + part.length), part.length, ts).toArray();
        }
      });
    },
    async get(key) {
      const rows = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM _blobs WHERE key = ? ORDER BY idx', key).toArray();
      if (!rows.length) return null;
      const parts = rows.map((r) => new Uint8Array(r.data));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    },
    async delete(keys) {
      for (const key of keys) sql.exec('DELETE FROM _blobs WHERE key = ?', key).toArray();
    },
    // A page of 1,000 keys at a time, like R2, so a batch doesn't read every remaining key.
    async *list(after = '') {
      for (;;) {
        const rows = sql
          .exec<{ key: string; size: number; uploaded: number }>('SELECT key, SUM(size) AS size, MIN(uploaded) AS uploaded FROM _blobs WHERE key > ? GROUP BY key ORDER BY key LIMIT 1000', after)
          .toArray();
        for (const r of rows) yield { key: r.key, size: Number(r.size), uploaded: Number(r.uploaded) };
        if (rows.length < 1000) return;
        after = rows[rows.length - 1].key;
      }
    },
  };
}
