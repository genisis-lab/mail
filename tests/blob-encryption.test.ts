import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { all, get, getMeta, run, setMeta } from '../src/server/db/index';
import { blobName, encrypt, isEncryptedBlob, secretFingerprint, sha256, totpCode } from '../src/server/lib/crypto';
import { blobEncryptionDue, blobEncryptionStatus, collectGarbage, continueBlobEncryption, getBlob, putBlob, restartBlobEncryption } from '../src/server/mail/blobs';
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
      const counting = { left: null, skipped: 0, done: false };
      expect(blobEncryptionStatus()).toEqual(counting);

      // Paused while WREN_SECRET differs from the data's key.
      config.keyMismatch = true;
      try {
        expect(blobEncryptionDue()).toBe(false);
        expect(await continueBlobEncryption()).toBe(false);
      } finally {
        config.keyMismatch = false;
      }
      expect(blobEncryptionStatus()).toEqual(counting);

      expect(await continueBlobEncryption(3)).toBe(true); // counts the files first
      expect(blobEncryptionStatus()).toEqual({ left: 8, skipped: 0, done: false });
      expect(await continueBlobEncryption(3)).toBe(true);
      expect(blobEncryptionStatus()).toEqual({ left: 5, skipped: 0, done: false });
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

  it('stores files unencrypted while WREN_SECRET is changed, so either key reads them, and encrypts them once that’s sorted out', async () => {
    const original = platform();
    setPlatform({ ...original, blobs: memoryBlobStore() });
    try {
      while (await continueBlobEncryption());
      expect(blobEncryptionStatus()).toBeNull();
      config.keyMismatch = true;
      let name: string;
      try {
        name = await putBlob(enc('saved while the key was changed'));
        expect(isEncryptedBlob(await stored(name))).toBe(false);
        // What startup does on finding the changed key.
        restartBlobEncryption();
        expect(await continueBlobEncryption()).toBe(false);
      } finally {
        config.keyMismatch = false;
      }
      const secret = config.secret;
      config.secret = OTHER_SECRET;
      try {
        expect((await getBlob(name)).toString()).toBe('saved while the key was changed');
      } finally {
        config.secret = secret;
      }

      // The key is back: the pass looks at every file again and encrypts this one.
      while (await continueBlobEncryption());
      expect(blobEncryptionStatus()).toBeNull();
      expect(isEncryptedBlob(await stored(name))).toBe(true);
      expect((await getBlob(name)).toString()).toBe('saved while the key was changed');
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

  it('stores exact bytes in the Durable Object fallback store, including Buffer views, and lists it a page at a time', async () => {
    const db = new DatabaseSync(':memory:');
    const toSql = (p: unknown) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p);
    let mostRows = 0;
    const storage = {
      sql: {
        exec: (q: string, ...params: unknown[]) => ({
          toArray: () => {
            const rows = db.prepare(q).all(...(params.map(toSql) as never[]));
            mostRows = Math.max(mostRows, rows.length);
            return rows;
          },
        }),
      },
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

    const many = Array.from({ length: 2500 }, (_, i) => `k${String(i).padStart(4, '0')}`);
    for (const k of many) await store.put(k, Buffer.from(k));
    mostRows = 0;
    expect(await keys()).toEqual(['a', 'b', ...many]);
    expect(await keys('k0999')).toEqual(many.slice(1000));
    expect(mostRows).toBe(1000);
  });

  // Last: a failure makes the pass wait ten minutes.
  it('never loses a file when encrypting it goes wrong, and moves past it next time so one file can’t stall the pass', async () => {
    const original = platform();
    const store = memoryBlobStore();
    const files = new Map(['precious old file', 'another old file'].map((t) => [sha256(Buffer.from(t)), Buffer.from(t)]));
    for (const [key, data] of files) await store.put(key, data);
    const [bad, good] = [...files.keys()].sort();
    let tryingWhileStoring: string | undefined;
    // Storage that cuts the encrypted copy of the first file short.
    const put: typeof store.put = (k, d, replace) => {
      if (isEncryptedBlob(d)) tryingWhileStoring ??= JSON.parse(getMeta('blob_encryption')!).trying;
      return store.put(k, k === bad && isEncryptedBlob(d) ? d.subarray(0, d.length - 1) : d, replace);
    };
    setPlatform({ ...original, blobs: { ...store, put } });
    try {
      restartPass();
      expect(await continueBlobEncryption()).toBe(true);
      await expect(continueBlobEncryption()).rejects.toThrow(/didn’t read back correctly/);
      expect(Buffer.from((await store.get(bad))!).equals(files.get(bad)!)).toBe(true);
      // Noted before the file was touched, so a run that dies part-way (say, out of memory) moves past it too.
      expect(tryingWhileStoring).toBe(bad);
      expect(blobEncryptionStatus()).toEqual({ left: 2, skipped: 0, done: false });
      expect(blobEncryptionDue()).toBe(false);

      vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
      expect(blobEncryptionDue()).toBe(true);
      expect(await continueBlobEncryption()).toBe(false);
      expect(blobEncryptionStatus()).toEqual({ left: 0, skipped: 1, done: true });
      expect(blobEncryptionDue()).toBe(false);
      expect(isEncryptedBlob((await store.get(bad))!)).toBe(false);
      expect((await getBlob(bad)).equals(files.get(bad)!)).toBe(true);
      expect(isEncryptedBlob((await store.get(good))!)).toBe(true);
      expect((await getBlob(good)).equals(files.get(good)!)).toBe(true);
    } finally {
      setPlatform(original);
    }
  });
});

describe('the encryption key in Admin → System', () => {
  const PW = 'a very long password';
  const owner = () => get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  const freshAttempts = () => run(`DELETE FROM login_attempts WHERE key LIKE 'owner-confirm:%'`);
  const audited = (action: string) => all('SELECT target FROM audit_log WHERE action = ?', [action]);

  beforeAll(async () => {
    h.as('admin');
    await h.call('POST', '/api/admin/users', { email: 'deputy@wren.test', name: 'Deputy', password: PW, role: 'admin' });
    await h.login('deputy@wren.test', PW, 'deputy');
    h.as('admin');
  });

  it('shows the generated key only to the owner, after their password and 2-step code', async () => {
    freshAttempts();
    const show = (body: object) => h.call('POST', '/api/admin/encryption-key', body);
    h.as('deputy');
    expect((await show({ password: PW })).status).toBe(403);
    h.as('admin');
    expect((await show({ password: 'not the password' })).status).toBe(401);
    // A key from WREN_SECRET was set by the owner and isn't shown.
    expect((await show({ password: PW })).status).toBe(400);

    setMeta('secret', config.secret); // as when Wren generated the key
    try {
      const r = await show({ password: PW });
      expect(r.status).toBe(200);
      expect(r.body.key).toBe(config.secret);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      expect(audited('admin.encryption_key_viewed')).toHaveLength(1);
      expect(JSON.stringify(all('SELECT * FROM audit_log'))).not.toContain(config.secret);
      expect(await (await h.request('/api/admin/export')).text()).not.toContain(config.secret);

      freshAttempts();
      run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt('JBSWY3DPEHPK3PXP'), owner()]);
      expect((await show({ password: PW })).status).toBe(400);
      expect((await show({ password: PW, code: '000000' })).status).toBe(401);
      expect((await show({ password: PW, code: totpCode('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30_000)) })).body.key).toBe(config.secret);
    } finally {
      run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [owner()]);
      run(`DELETE FROM _meta WHERE key = 'secret'`);
    }
  });

  it('lets the owner keep a changed key, after their password', async () => {
    freshAttempts();
    const use = (body: object) => h.call('POST', '/api/admin/encryption-key/use-current', body);
    expect((await use({ password: PW })).status).toBe(400); // nothing to do
    setMeta('key_fingerprint', 'from-the-old-key');
    config.keyMismatch = true;
    try {
      h.as('deputy');
      expect((await use({ password: PW })).status).toBe(403);
      h.as('admin');
      expect((await use({ password: 'not the password' })).status).toBe(401);
      expect(config.keyMismatch).toBe(true);
      expect((await use({ password: PW })).status).toBe(200);
      expect(config.keyMismatch).toBe(false);
      expect(getMeta('key_fingerprint')).toBe(secretFingerprint());
      expect(audited('admin.encryption_key_adopted')).toHaveLength(1);
      expect((await h.call('GET', '/api/admin/system')).body.keyMismatch).toBe(false);
    } finally {
      config.keyMismatch = false;
      setMeta('key_fingerprint', secretFingerprint());
    }
  });
});
