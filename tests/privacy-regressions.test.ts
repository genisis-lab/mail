import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { get, run } from '../src/server/db/index';
import { sha256 } from '../src/server/lib/crypto';
import { continueBlobEncryption, getBlob, putBlob } from '../src/server/mail/blobs';
import { retryOutbox } from '../src/server/mail/outbound';
import { pruneLinks } from '../src/server/mail/private';
import { platform, setPlatform } from '../src/server/platform';
import { exportStream, restoreExport } from '../src/server/services/backup';
import { harness, processQueue } from './harness';
import { testPlatform } from './test-platform';

let h: ReturnType<typeof harness>;
const DAY = 86_400_000;
const due = async () => {
  run("UPDATE outbox SET next_attempt_at = 0 WHERE status = 'queued'");
  await processQueue();
};
const row = (id: number) => get<any>('SELECT * FROM messages WHERE id = ?', [id])!;

beforeEach(async () => {
  setPlatform(testPlatform());
  h = harness();
  await h.setup();
  await h.login('admin@wren.test', 'a very long password');
});
afterEach(() => vi.restoreAllMocks());

describe('stored content integrity', () => {
  it('rejects plaintext replacement and a valid ciphertext copied from another name', async () => {
    const a = await putBlob(Buffer.from('original attachment'));
    const b = await putBlob(Buffer.from('different attachment'));
    const original = (await platform().blobs.get(a))!;
    for (const replacement of [Buffer.from('forged plaintext'), (await platform().blobs.get(b))!]) {
      await platform().blobs.put(a, replacement, true);
      await expect(getBlob(a)).rejects.toThrow(/integrity check/);
      await expect(putBlob(Buffer.from('original attachment'))).rejects.toThrow(/integrity check/);
    }
    await platform().blobs.put(a, original, true);
    expect((await getBlob(a)).toString()).toBe('original attachment');
  });

  it('enrolls legacy files on upgrade and retains their integrity when encrypted in place', async () => {
    const data = Buffer.from('legacy content');
    const key = sha256(data);
    await platform().blobs.put(key, data);
    while (await continueBlobEncryption());
    expect(get('SELECT encrypted FROM blob_integrity WHERE key = ?', [key])).toMatchObject({ encrypted: 1 });
    expect((await getBlob(key)).equals(data)).toBe(true);
    await platform().blobs.put(key, data, true);
    await expect(getBlob(key)).rejects.toThrow(/integrity check/);
  });

  it('retains trusted file digests when restoring an earlier portable database backup', async () => {
    const backup = await new Response(exportStream()).text();
    const key = await putBlob(Buffer.from('file written after the backup'));
    await restoreExport(new Response(backup).body!);
    expect((await getBlob(key)).toString()).toBe('file written after the backup');
    await platform().blobs.put(key, Buffer.from('replacement'), true);
    await expect(getBlob(key)).rejects.toThrow(/integrity check/);
  });

  it.each(['missing', 'wrong key', 'outage'] as const)('never edits or sends the search prefix when the full body is unreadable: %s', async (failure) => {
    const html = `<p>${'full content '.repeat(30_000)}FINAL SENTINEL</p>`;
    const saved = await h.call('POST', '/api/compose/drafts', { to: [{ address: 'kim@ext.example' }], html });
    expect(saved.status).toBe(200);
    const id = saved.body.id;
    const original = row(id);
    expect(original.body_blob).toBeTruthy();
    const data = (await platform().blobs.get(original.body_blob))!;
    const secret = config.secret;
    const storage = platform().blobs;
    if (failure === 'missing') await storage.delete([original.body_blob]);
    else if (failure === 'wrong key') config.secret = 'a-different-secret-0123456789';
    else vi.spyOn(storage, 'get').mockRejectedValue(new Error('storage offline'));
    try {
      for (const [method, path, body] of [
        ['GET', `/api/compose/drafts/${id}`, undefined],
        ['PUT', `/api/compose/drafts/${id}`, { text: original.text_body }],
        ['POST', '/api/compose/send', { draftId: id, text: original.text_body, to: [{ address: 'kim@ext.example' }] }],
        ['POST', `/api/compose/drafts/${id}/send`, {}],
      ] as const) {
        const response = await h.call(method, path, body);
        expect(response.status).toBe(503);
        expect(response.body.code).toBe('body_unavailable');
        expect(row(id)).toEqual(original);
      }
      expect(get('SELECT 1 FROM outbox WHERE message_id = ?', [id])).toBeUndefined();
    } finally {
      config.secret = secret;
      vi.restoreAllMocks();
      await storage.put(original.body_blob, data, true);
    }
    const reopened = await h.call('GET', `/api/compose/drafts/${id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.html).toBe(html);
  });
});

describe('private delivery failures', () => {
  async function send(to: string[]) {
    const fd = new FormData();
    fd.append('file', new File(['original file'], 'secret.pdf', { type: 'application/pdf' }));
    const upload = await h.request('/api/compose/uploads', { method: 'POST', body: fd });
    const attachment = ((await upload.json()) as any).attachments[0];
    const sent = await h.call('POST', '/api/compose/send', {
      to: to.map((address) => ({ address })), html: '<p>original secret</p>', attachments: [attachment.id], privateDays: 1,
    });
    expect(sent.status).toBe(200);
    await due();
    return { id: sent.body.id as number, attachment };
  }
  const link = (id: number) => get<any>('SELECT * FROM private_links WHERE message_id = ?', [id])!;

  it('keeps the original through failed delivery and expiry maintenance, then starts expiry on successful retry', async () => {
    const { id, attachment } = await send(['kim@ext.example']); // no outbound provider
    expect(row(id).status).toBe('failed');
    expect(link(id)).toMatchObject({ expires_at: null });
    expect(link(id).token_hash).toBeTruthy();
    const later = Date.now() + 3 * DAY;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    pruneLinks();
    expect(link(id)).toBeTruthy();
    expect(row(id).html_body).toBe('<p>original secret</p>');
    expect(get('SELECT 1 FROM attachments WHERE id = ? AND message_id = ?', [attachment.id, id])).toBeTruthy();
    expect(await (await h.request(`/api/attachments/${attachment.id}`)).text()).toBe('original file');
    await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
    expect(retryOutbox(get<any>('SELECT id FROM outbox WHERE message_id = ?', [id])!.id)).toBe(true);
    await due();
    expect(row(id).status).toBe('sent');
    expect(link(id).expires_at).toBe(later + DAY);
    expect(row(id).html_body).not.toContain('original secret');
    expect(get('SELECT 1 FROM attachments WHERE message_id = ?', [id])).toBeUndefined();
    expect(link(id).html_body).toBe('<p>original secret</p>');
  });

  it('starts expiry on local acceptance even if external delivery fails, without extending it on retry', async () => {
    await h.call('POST', '/api/admin/users', { email: 'bob@wren.test', name: 'Bob', password: 'a very long password' });
    const { id } = await send(['bob@wren.test', 'kim@ext.example']);
    const expiry = link(id).expires_at;
    expect(expiry).toBeGreaterThan(Date.now());
    expect(row(id).html_body).not.toContain('original secret');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
    run("UPDATE outbox SET status = 'failed' WHERE message_id = ?", [id]);
    expect(retryOutbox(get<any>('SELECT id FROM outbox WHERE message_id = ?', [id])!.id)).toBe(true);
    await due();
    expect(row(id).status).toBe('sent');
    expect(link(id).expires_at).toBe(expiry);
  });
});
