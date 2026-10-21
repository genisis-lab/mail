import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { all, get, run } from '../src/server/db/index';
import { blobName, isEncryptedBlob, sha256 } from '../src/server/lib/crypto';
import { blobEncryptionDue, blobEncryptionStatus, collectGarbage, continueBlobEncryption, getBlob, putBlob } from '../src/server/mail/blobs';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { platform, setPlatform } from '../src/server/platform';
import { startBackup, stepBackup, type BackupRow } from '../src/server/services/auto-backup';
import { runJobs } from '../src/server/services/jobs';
import { sqlBlobStore } from '../src/worker/storage';
import { harness } from './harness';
import { memoryBlobStore } from './test-platform';

const h = harness();
const enc = (s: string) => new TextEncoder().encode(s);
const stored = async (key: string) => Buffer.from((await platform().blobs.get(key))!);
const OTHER_SECRET = 'a-different-secret-0123456789';
const restartPass = () => run(`DELETE FROM _meta WHERE key = 'blob_encryption'`);

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  const { raw } = await buildMime({ from: { address: 'kim@example.org' }, to: [{ address: 'admin@wren.test' }], subject: 'Kumquat plans', text: 'The kumquat harvest is early.' });
  await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'resend' });
});

afterEach(() => vi.useRealTimers());

describe('encrypted mail files', () => {
  it('stores files encrypted, under a keyed name that still deduplicates', async () => {
    const data = enc('Quarterly kumquat report');
    const name = await putBlob(data);
    expect(name).toMatch(/^[a-f0-9]{64}$/);
    // Holding the file isn't enough to find it in the bucket.
    expect(name).not.toBe(sha256(Buffer.from(data)));
    expect(await putBlob(data)).toBe(name);
    const raw = await stored(name);
    expect(isEncryptedBlob(raw)).toBe(true);
    expect(raw.includes(Buffer.from('kumquat'))).toBe(false);
    expect((await getBlob(name)).toString()).toBe('Quarterly kumquat report');

    // Larger than one encryption step, and empty.
    const big = crypto.randomBytes(2.5 * 1024 * 1024);
    expect((await getBlob(await putBlob(big))).equals(big)).toBe(true);
    expect((await getBlob(await putBlob(new Uint8Array(0)))).length).toBe(0);

    // Messages coming in are stored the same way.
    const msg = get<{ raw_blob: string }>(`SELECT raw_blob FROM messages WHERE subject = 'Kumquat plans'`)!;
    expect(isEncryptedBlob(await stored(msg.raw_blob))).toBe(true);
    expect((await getBlob(msg.raw_blob)).toString()).toContain('The kumquat harvest is early.');
  });

  it('reads files stored before encryption as they are, and never decrypts with the wrong key', async () => {
    const plain = enc('an old attachment');
    const old = sha256(Buffer.from(plain));
    await platform().blobs.put(old, plain);
    expect((await getBlob(old)).toString()).toBe('an old attachment');

    const name = await putBlob(enc('secret'));
    const original = config.secret;
    config.secret = OTHER_SECRET;
    try {
      await expect(getBlob(name)).rejects.toThrow(/different WREN_SECRET/);
      expect(blobName(enc('secret'))).not.toBe(name);
    } finally {
      config.secret = original;
    }
    const tampered = await stored(name);
    tampered[tampered.length - 1] ^= 1;
    await platform().blobs.put(name, tampered, true);
    await expect(getBlob(name)).rejects.toThrow(/can’t be decrypted/);
  });

  it('encrypts files stored before encryption in place, in batches, and running it again changes nothing', async () => {
    const original = platform();
    setPlatform({ ...original, blobs: memoryBlobStore() });
    try {
      const legacy = new Map<string, Buffer>();
      for (let i = 0; i < 7; i++) {
        const data = Buffer.from(`old message ${i}`);
        legacy.set(sha256(data), data);
        await platform().blobs.put(sha256(data), data);
      }
      const fresh = await putBlob(enc('new message'));
      restartPass();
      expect(blobEncryptionStatus()).toEqual({ left: null });

      // Paused while WREN_SECRET differs from the data's key.
      config.keyMismatch = true;
      try {
        expect(blobEncryptionDue()).toBe(false);
        expect(await continueBlobEncryption()).toBe(false);
      } finally {
        config.keyMismatch = false;
      }
      expect(blobEncryptionStatus()).toEqual({ left: null });

      expect(await continueBlobEncryption(3)).toBe(true); // counts the files first
      expect(blobEncryptionStatus()).toEqual({ left: 8 });
      expect(await continueBlobEncryption(3)).toBe(true);
      expect(blobEncryptionStatus()).toEqual({ left: 5 });
      // Stopped part-way, every file still reads.
      for (const [key, data] of legacy) expect((await getBlob(key)).equals(data)).toBe(true);

      while (await continueBlobEncryption(3));
      expect(blobEncryptionStatus()).toBeNull();
      expect(blobEncryptionDue()).toBe(false);
      for (const [key, data] of legacy) {
        expect(isEncryptedBlob(await stored(key))).toBe(true);
        expect((await getBlob(key)).equals(data)).toBe(true);
      }
      expect((await getBlob(fresh)).toString()).toBe('new message');

      const snapshot = async () => {
        const out = new Map<string, Buffer>();
        for await (const b of platform().blobs.list()) out.set(b.key, await stored(b.key));
        return out;
      };
      const before = await snapshot();
      restartPass();
      while (await continueBlobEncryption(3));
      expect(await snapshot()).toEqual(before);
    } finally {
      setPlatform(original);
    }
  });

  it('keeps stored backups encrypted; downloading and restoring read them, a different key stops the restore', async () => {
    const b = startBackup('manual');
    while (!(await stepBackup(get<BackupRow>('SELECT * FROM backups WHERE id = ?', [b.id])!, 0, 2000)));
    const parts: string[] = JSON.parse(get<BackupRow>('SELECT * FROM backups WHERE id = ?', [b.id])!.parts);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const raw = await stored(p);
      expect(isEncryptedBlob(raw)).toBe(true);
      expect(raw.includes(Buffer.from('admin@wren.test'))).toBe(false);
    }
    const text = await (await h.request(`/api/admin/backups/${b.id}/download`)).text();
    expect(JSON.parse(text.split('\n')[0])).toMatchObject({ format: 'wren-export' });
    expect(text).toContain('admin@wren.test');

    const count = () => get<{ c: number }>('SELECT COUNT(*) AS c FROM messages')!.c;
    const messages = count();
    run(`DELETE FROM messages WHERE subject = 'Kumquat plans'`);
    const original = config.secret;
    config.secret = OTHER_SECRET;
    try {
      const r = await h.call('POST', `/api/admin/backups/${b.id}/restore`);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/different WREN_SECRET/);
    } finally {
      config.secret = original;
    }
    expect(count()).toBe(messages - 1); // untouched

    expect((await h.call('POST', `/api/admin/backups/${b.id}/restore`)).status).toBe(200);
    expect(count()).toBe(messages);
    await h.login('admin@wren.test', 'a very long password', 'admin'); // the restore signed everyone out
  });

  it('keeps mail exports encrypted in storage and downloads them readable', async () => {
    const start = await h.call('POST', '/api/me/export');
    expect(start.status).toBe(200);
    for (let i = 0; i < 20 && get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [start.body.job.id])!.status !== 'done'; i++) {
      run('UPDATE jobs SET next_run_at = 0 WHERE id = ?', [start.body.job.id]);
      await runJobs();
    }
    const job = get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', [start.body.job.id])!;
    for (const p of JSON.parse(job.state).parts as string[]) expect(isEncryptedBlob(await stored(p))).toBe(true);
    const mbox = await (await h.request(`/api/me/export/${start.body.job.id}/download`)).text();
    expect(mbox).toContain('The kumquat harvest is early.');
  });

  it('collects garbage by name as before', async () => {
    const stray = await putBlob(enc('nobody needs this'));
    const raw = get<{ raw_blob: string }>(`SELECT raw_blob FROM messages WHERE subject = 'Kumquat plans'`)!.raw_blob;
    vi.useFakeTimers({ now: Date.now() + 2 * 3_600_000, toFake: ['Date'] });
    await collectGarbage();
    const marked = new Set(all<{ key: string }>('SELECT key FROM blob_tombstones').map((r) => r.key));
    expect(marked.has(stray)).toBe(true);
    expect(marked.has(raw)).toBe(false);
  });

  it('stores exact bytes in the Durable Object fallback store, including Buffer views', async () => {
    const db = new DatabaseSync(':memory:');
    const toSql = (p: unknown) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p);
    const storage = {
      sql: { exec: (q: string, ...params: unknown[]) => ({ toArray: () => db.prepare(q).all(...(params.map(toSql) as never[])) }) },
      transactionSync: <T>(fn: () => T) => {
        db.exec('BEGIN');
        try {
          const r = fn();
          db.exec('COMMIT');
          return r;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      },
    } as unknown as DurableObjectStorage;
    const store = sqlBlobStore(storage);
    const small = Buffer.from('hello'); // a view into Node's shared Buffer pool
    const big = crypto.randomBytes(2.5 * 1024 * 1024).subarray(1); // a view spanning several 1 MB rows
    await store.put('b', small);
    await store.put('a', big);
    expect(Buffer.from((await store.get('b'))!).equals(small)).toBe(true);
    expect(Buffer.from((await store.get('a'))!).equals(big)).toBe(true);
    await store.put('b', Buffer.from('ignored'));
    expect(Buffer.from((await store.get('b'))!).toString()).toBe('hello');
    await store.put('b', Buffer.from('replaced'), true);
    expect(Buffer.from((await store.get('b'))!).toString()).toBe('replaced');
    const keys = async (after?: string) => {
      const out: string[] = [];
      for await (const b of store.list(after)) out.push(b.key);
      return out;
    };
    expect(await keys()).toEqual(['a', 'b']);
    expect(await keys('a')).toEqual(['b']);
  });

  // Last: a failure makes the pass wait ten minutes.
  it('never loses a file when encrypting it goes wrong, and tries again later', async () => {
    const original = platform();
    const store = memoryBlobStore();
    const data = Buffer.from('precious old file');
    const key = sha256(data);
    await store.put(key, data);
    let mangle = true;
    // Storage that cuts the encrypted copy short.
    setPlatform({ ...original, blobs: { ...store, put: (k, d, replace) => store.put(k, mangle && isEncryptedBlob(d) ? d.subarray(0, d.length - 1) : d, replace) } });
    try {
      restartPass();
      expect(await continueBlobEncryption()).toBe(true);
      await expect(continueBlobEncryption()).rejects.toThrow(/didn’t read back correctly/);
      expect(Buffer.from((await store.get(key))!).equals(data)).toBe(true);
      expect(blobEncryptionStatus()).toEqual({ left: 1 });
      expect(blobEncryptionDue()).toBe(false);

      mangle = false;
      vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
      expect(blobEncryptionDue()).toBe(true);
      expect(await continueBlobEncryption()).toBe(false);
      expect(blobEncryptionStatus()).toBeNull();
      expect((await getBlob(key)).equals(data)).toBe(true);
      expect(isEncryptedBlob((await store.get(key))!)).toBe(true);
    } finally {
      setPlatform(original);
    }
  });
});
