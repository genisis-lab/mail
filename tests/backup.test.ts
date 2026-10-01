import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/server/config';
import { get, insert, now, openDb, run } from '../src/server/db/index';
import { nodeSqlDriver } from './sqlite';
import { encrypt, encryptJson, randomToken } from '../src/server/lib/crypto';
import { platform, setPlatform } from '../src/server/platform';
import { createUser } from '../src/server/services/users';
import { continueSearchRebuild, exportStream, restoreExport, RestoreError, searchRebuildPending, verifyEncryptionKey } from '../src/server/services/backup';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { listThreads } from '../src/server/mail/threads';
import { invalidateSettings, setSettings, getSettings } from '../src/server/settings';
import { withDurableObjectLimits } from './do-limits';

let alice: number;

async function exportText(): Promise<string> {
  return new Response(exportStream()).text();
}

const streamOf = (text: string) => new Response(text).body!;

beforeAll(async () => {
  openDb(withDurableObjectLimits(nodeSqlDriver(':memory:')));
  invalidateSettings();
  verifyEncryptionKey();
  insert('INSERT INTO domains (name, verify_token, created_at) VALUES (?, ?, ?)', ['wren.test', 'tok', now()]);
  alice = await createUser({ email: 'alice@wren.test', name: 'Alice', password: 'correct horse battery', role: 'owner' });
  run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [encrypt('JBSWY3DPEHPK3PXP'), alice]);
  insert('INSERT INTO providers (name, type, config, inbound_token, created_at) VALUES (?, ?, ?, ?, ?)', ['Resend', 'resend', encryptJson({ apiKey: 're_x' }), randomToken(), now()]);
  setSettings({ 'instance.name': 'Fernhill Mail' });
  for (let i = 0; i < 3; i++) {
    const { raw } = await buildMime({ from: { address: `sender${i}@example.org` }, to: [{ address: 'alice@wren.test' }], subject: `Quarterly kumquat ${i}`, text: 'hello' });
    await ingest(raw, { rcptTo: ['alice@wren.test'], source: 'test' });
  }
});

describe('export and restore', () => {
  it('round-trips the database', async () => {
    const text = await exportText();
    const [header, ...rows] = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(header).toMatchObject({ format: 'wren-export', app: expect.any(String) });
    expect(rows.some((r) => r.t === 'users' && r.r.email === 'alice@wren.test')).toBe(true);
    expect(rows.some((r) => r.t === 'sessions')).toBe(false);

    // Change things after the export…
    run(`DELETE FROM messages WHERE subject = 'Quarterly kumquat 0'`);
    await createUser({ email: 'mallory@wren.test', name: 'M', password: 'another long password' });
    setSettings({ 'instance.name': 'Changed' });

    // …and restore.
    const r = await restoreExport(streamOf(text));
    expect(r.keyMismatch).toBe(false);
    expect(r.rows.messages).toBe(3);
    expect(get('SELECT 1 FROM users WHERE email = ?', ['mallory@wren.test'])).toBeUndefined();
    expect(getSettings()['instance.name']).toBe('Fernhill Mail');
    expect(get<{ totp_enabled: number }>('SELECT totp_enabled FROM users WHERE id = ?', [alice])!.totp_enabled).toBe(1);

    // Search comes back once the background rebuild has run.
    expect(searchRebuildPending()).toBe(true);
    while (continueSearchRebuild(2)) {
      /* keep going */
    }
    expect(listThreads(alice, { query: 'kumquat' }).total).toBe(3);
  });

  it('rejects files that are not Wren exports', async () => {
    await expect(restoreExport(streamOf('{"hello":1}\n'))).rejects.toBeInstanceOf(RestoreError);
    await expect(restoreExport(streamOf('not json'))).rejects.toThrow(/not a Wren export/);
  });

  it('handles an export made with a different encryption key', async () => {
    const text = await exportText();
    const original = config.secret;
    config.secret = 'a-completely-different-secret-value';
    try {
      await expect(restoreExport(streamOf(text))).rejects.toThrow('KEY_MISMATCH');
      const r = await restoreExport(streamOf(text), { allowKeyMismatch: true });
      expect(r.keyMismatch).toBe(true);
      expect(get<{ totp_enabled: number }>('SELECT totp_enabled FROM users WHERE id = ?', [alice])!.totp_enabled).toBe(0);
      expect(get<{ enabled: number; last_error: string }>('SELECT enabled, last_error FROM providers')).toMatchObject({ enabled: 0 });
    } finally {
      config.secret = original;
    }
  });

  it('uses point-in-time bookmarks and rolls back a failed restore on Workers', async () => {
    const node = platform();
    const restored: string[] = [];
    setPlatform({ ...node, pointInTime: { current: async () => 'bm-1', at: async () => 'bm-0', restore: async (b) => void restored.push(b) } });
    try {
      const text = await exportText();
      const ok = await restoreExport(streamOf(text));
      expect(ok.rows.users).toBe(1);
      expect(restored).toEqual([]);
      await expect(restoreExport(streamOf(text.trim() + '\n{broken'))).rejects.toThrow(/damaged/);
      expect(restored).toEqual(['bm-1']);
      // (The fake bookmark can't really roll back; put the data back for the next tests.)
      await restoreExport(streamOf(text));
    } finally {
      setPlatform(node);
    }
  });
});

describe('encryption key check', () => {
  it('detects a changed WREN_SECRET', () => {
    expect(verifyEncryptionKey()).toBe(true);
    const original = config.secret;
    config.secret = 'some-other-secret-1234567890';
    try {
      expect(verifyEncryptionKey()).toBe(false);
    } finally {
      config.secret = original;
    }
  });
});


describe('blob garbage collection', () => {
  it('keeps unreferenced files for the grace period before deleting them', async () => {
    const { collectGarbage, BLOB_GRACE_MS } = await import('../src/server/mail/blobs');
    const node = platform();
    const files = new Map<string, { size: number; uploaded: number }>([
      ['a'.repeat(64), { size: 10, uploaded: Date.now() - 2 * 3_600_000 }],
      ['b'.repeat(64), { size: 20, uploaded: Date.now() - 2 * 3_600_000 }],
    ]);
    const deleted: string[] = [];
    setPlatform({
      ...node,
      blobs: {
        put: async () => {},
        get: async () => null,
        delete: async (keys) => {
          for (const k of keys) {
            deleted.push(k);
            files.delete(k);
          }
        },
        async *list() {
          for (const [key, v] of files) yield { key, ...v };
        },
      },
    });
    try {
      const first = await collectGarbage();
      expect(first.removed).toBe(0);
      expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM blob_tombstones')!.c).toBe(2);

      // "b" becomes referenced again (e.g. restored from a backup); "a" ages past the grace period.
      run(`UPDATE messages SET body_blob = ? WHERE id = (SELECT MIN(id) FROM messages)`, ['b'.repeat(64)]);
      run('UPDATE blob_tombstones SET seen_at = ?', [Date.now() - BLOB_GRACE_MS - 1000]);
      const second = await collectGarbage();
      expect(second.removed).toBe(1);
      expect(deleted).toEqual(['a'.repeat(64)]);
      expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM blob_tombstones')!.c).toBe(0);
    } finally {
      setPlatform(node);
    }
  });
});
