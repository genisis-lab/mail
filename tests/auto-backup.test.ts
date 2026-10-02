import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, insert, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { collectGarbage, putBlob } from '../src/server/mail/blobs';
import { platform, setPlatform } from '../src/server/platform';
import { setSettings } from '../src/server/settings';
import { nextBackupAt, pruneBackups, runBackups, startBackup, stepBackup, type BackupRow } from '../src/server/services/auto-backup';
import { harness } from './harness';

const h = harness();
const HOUR = 3_600_000;
const backup = (id: number) => get<BackupRow>('SELECT * FROM backups WHERE id = ?', [id])!;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  for (let i = 0; i < 30; i++) {
    const { raw } = await buildMime({ from: { address: `sender${i}@example.org` }, to: [{ address: 'admin@wren.test' }], subject: `Message ${i}`, text: `Body ${i} `.repeat(40) });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'resend' });
  }
});

afterEach(() => vi.useRealTimers());

describe('automatic backups', () => {
  it('runs once a day at the chosen hour', async () => {
    setSettings({ 'backups.hour': 3 });
    const day = Date.UTC(2026, 9, 2);
    expect(nextBackupAt(day + 2 * HOUR)).toBe(day + 3 * HOUR);
    await runBackups(day + 2 * HOUR);
    expect(all('SELECT 1 FROM backups')).toHaveLength(0);

    vi.useFakeTimers({ now: day + 4 * HOUR, toFake: ['Date'] });
    await runBackups(Date.now());
    const [b] = all<BackupRow>('SELECT * FROM backups');
    expect(b).toMatchObject({ kind: 'auto', status: 'done' });
    expect(b.rows).toBeGreaterThan(30);
    expect(JSON.parse(b.parts).length).toBe(1);
    // Done for today; tomorrow at 3.
    expect(nextBackupAt(Date.now())).toBe(day + 27 * HOUR);
    await runBackups(Date.now());
    expect(all('SELECT 1 FROM backups')).toHaveLength(1);
    setSettings({ 'backups.enabled': false });
    expect(nextBackupAt(Date.now())).toBe(Infinity);
    setSettings({ 'backups.enabled': true });
  });

  it('writes a big backup in parts across several steps, and it restores', async () => {
    const before = {
      messages: get<{ c: number }>('SELECT COUNT(*) AS c FROM messages')!.c,
      users: get<{ c: number }>('SELECT COUNT(*) AS c FROM users')!.c,
    };
    const started = (await h.call('POST', '/api/admin/backups')).body.backup;
    expect(started).toMatchObject({ kind: 'manual', status: 'running', createdBy: 'admin@wren.test' });
    // Starting again while one runs returns the same backup.
    expect((await h.call('POST', '/api/admin/backups')).body.backup.id).toBe(started.id);

    let steps = 0;
    while (!(await stepBackup(backup(started.id), 0, 500))) steps++;
    expect(steps).toBeGreaterThan(3);
    const done = backup(started.id);
    expect(done.status).toBe('done');
    expect(JSON.parse(done.parts).length).toBeGreaterThanOrEqual(steps);

    const dl = await h.request(`/api/admin/backups/${started.id}/download`);
    expect(dl.headers.get('content-disposition')).toMatch(/wren-backup-.*\.jsonl/);
    const text = await dl.text();
    const lines = text.trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ format: 'wren-export' });
    // Every line is whole: parts end on line boundaries.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.filter((l) => l.startsWith('{"t":"messages"')).length).toBe(before.messages);
    expect(Buffer.byteLength(text)).toBe(done.bytes);

    // Change something, restore, and it's back.
    run(`DELETE FROM messages WHERE subject = 'Message 0'`);
    const r = await h.call('POST', `/api/admin/backups/${started.id}/restore`);
    expect(r.status).toBe(200);
    expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM messages')!.c).toBe(before.messages);
    expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM users')!.c).toBe(before.users);
    // The list of backups survives the restore.
    expect(get('SELECT 1 FROM backups WHERE id = ?', [started.id])).toBeTruthy();
  });

  it('keeps the newest automatic backups', async () => {
    await h.login('admin@wren.test', 'a very long password', 'admin'); // the restore signed everyone out
    setSettings({ 'backups.keep': 2 });
    run(`DELETE FROM backups WHERE kind = 'auto'`);
    const ids: number[] = [];
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      const key = await putBlob(new TextEncoder().encode(`part ${i}`));
      keys.push(key);
      ids.push(insert(`INSERT INTO backups (kind, status, parts, created_at, finished_at) VALUES ('auto', 'done', ?, ?, ?)`, [JSON.stringify([key]), Date.now() + i, Date.now() + i]));
    }
    await pruneBackups();
    expect(all<{ id: number }>(`SELECT id FROM backups WHERE kind = 'auto' ORDER BY id`).map((r) => r.id)).toEqual(ids.slice(2));
    expect(await platform().blobs.get(keys[0])).toBeNull();
    expect(await platform().blobs.get(keys[3])).not.toBeNull();
    // Manual backups stay until deleted.
    expect(all(`SELECT 1 FROM backups WHERE kind = 'manual'`)).toHaveLength(1);
    const list = (await h.call('GET', '/api/admin/backups')).body;
    expect(list.settings).toEqual({ enabled: true, keep: 2, hour: 3 });
    expect(list.backups[0]).toMatchObject({ kind: 'auto', status: 'done', parts: 1 });
    expect((await h.call('PUT', '/api/admin/settings', { 'backups.keep': 0 })).status).toBe(400);
    expect((await h.call('PUT', '/api/admin/settings', { 'backups.hour': 24 })).status).toBe(400);
  });

  it('raises an alert when an automatic backup fails, and clears it when one works', async () => {
    const original = platform();
    setPlatform({ ...original, blobs: { ...original.blobs, put: async () => Promise.reject(new Error('R2 is unavailable')) } });
    try {
      const b = startBackup('auto');
      await stepBackup(b);
      expect(backup(b.id)).toMatchObject({ status: 'failed', error: 'R2 is unavailable' });
    } finally {
      setPlatform(original);
    }
    const alert = get<any>(`SELECT * FROM alerts WHERE kind = 'backup' AND resolved_at IS NULL`);
    expect(alert).toMatchObject({ title: 'The automatic backup failed', detail: 'R2 is unavailable', link: '/admin/system' });
    // Retried an hour later rather than tomorrow.
    expect(nextBackupAt(Date.now())).toBeLessThanOrEqual(Date.now() + HOUR + 1000);
    await stepBackup(startBackup('auto'));
    expect(get(`SELECT 1 FROM alerts WHERE kind = 'backup' AND resolved_at IS NULL`)).toBeUndefined();
  });

  it('keeps backup files away from the garbage collector until the backup is deleted', async () => {
    const b = all<BackupRow>(`SELECT * FROM backups WHERE status = 'done' ORDER BY id DESC LIMIT 1`)[0];
    const parts: string[] = JSON.parse(b.parts);
    const stray = await putBlob(new TextEncoder().encode('nobody needs this'));
    vi.useFakeTimers({ now: Date.now() + 2 * HOUR, toFake: ['Date'] });
    await collectGarbage();
    const marked = new Set(all<{ key: string }>('SELECT key FROM blob_tombstones').map((r) => r.key));
    expect(marked.has(stray)).toBe(true);
    for (const p of parts) expect(marked.has(p)).toBe(false);
    vi.useRealTimers();

    expect((await h.call('DELETE', `/api/admin/backups/${b.id}`)).status).toBe(200);
    for (const p of parts) expect(await platform().blobs.get(p)).toBeNull();
  });
});
