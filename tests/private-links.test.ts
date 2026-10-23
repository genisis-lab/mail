import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, now, run } from '../src/server/db/index';
import { sha256 } from '../src/server/lib/crypto';
import { collectGarbage } from '../src/server/mail/blobs';
import { runMaintenance } from '../src/server/jobs';
import { harness, outbox, processQueue } from './harness';

const h = harness();
const PW = 'a very long password';
const DAY = 86_400_000;
const deliverNow = async () => {
  run(`UPDATE outbox SET next_attempt_at = 0 WHERE status = 'queued'`);
  await processQueue();
};
const tokenIn = (text: string) => /\/p\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];
/** A request from someone who isn't signed in. */
const anon = (path: string) => h.app.request(path);
const link = (messageId: number) => get<any>('SELECT * FROM private_links WHERE message_id = ?', [messageId]);

async function upload(name: string, content: string, inline = false) {
  const fd = new FormData();
  fd.append(inline ? 'inline' : 'file', new File([content], name, { type: inline ? 'image/png' : 'application/pdf' }));
  const res = await h.request('/api/compose/uploads', { method: 'POST', body: fd });
  return ((await res.json()) as any).attachments[0] as { id: number; contentId: string | null };
}

/** Send a private message as the admin; returns its id and the link token once delivered. */
async function sendPrivate(subject: string, secret: string, extra: Record<string, unknown> = {}) {
  const file = await upload(`${secret}.pdf`, `file-${secret}`);
  const r = await h.call('POST', '/api/compose/send', {
    to: [{ address: 'kim@ext.example' }, { address: 'bob@wren.test' }],
    subject,
    html: `<p>The secret is ${secret}</p>`,
    attachments: [file.id],
    privateDays: 7,
    ...extra,
  });
  expect(r.status).toBe(200);
  return { id: r.body.id as number, file };
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
  await h.call('POST', '/api/admin/users', { email: 'bob@wren.test', name: 'Bob', password: PW });
});

afterEach(() => {
  vi.restoreAllMocks();
  h.as('admin@wren.test');
});

describe('private links', () => {
  let id: number;
  let token: string;
  let fileId: number;
  let picture: { id: number; contentId: string | null };

  it('emails a link, made when the message goes out, instead of the content', async () => {
    picture = await upload('chart.png', 'png-bytes-4242', true);
    fileId = (await upload('offer.pdf', 'offer-file-4242')).id;
    const r = await h.call('POST', '/api/compose/send', {
      to: [{ address: 'kim@ext.example' }, { address: 'bob@wren.test' }],
      subject: 'Salary review',
      html: `<p>The secret is S3CRET-4242</p><img src="cid:${picture.contentId}">`,
      attachments: [picture.id, fileId],
      privateDays: 7,
    });
    id = r.body.id;

    // Waiting to go out (undo send): no link yet, and the content isn't in the outbox.
    expect(link(id)).toMatchObject({ days: 7, token_hash: null, expires_at: null });
    expect((await h.call('GET', `/api/mail/messages/${id}`)).body.privateLink).toEqual({ days: 7, expiresAt: null });
    const queued = (await outbox('user')).find((o) => o.subject === 'Salary review')!;
    expect(queued.text).not.toContain('S3CRET-4242');
    expect(queued.text).not.toContain('offer.pdf');

    await deliverNow();
    const out = (await outbox('user')).find((o) => o.subject === 'Salary review')!;
    expect(out.status).toBe('sent');
    expect(out.text).toContain('Ada Admin sent you a private message');
    expect(out.text).toContain('This link stops working 7 days after delivery');
    expect(out.text).toContain('Subject: Salary review');
    token = tokenIn(out.text)!;
    expect(token).toBeTruthy();

    const row = link(id);
    expect(row.token_hash).toBe(sha256(token));
    expect(row.expires_at).toBeGreaterThan(now() + 7 * DAY - 60_000);
    expect(row.expires_at).toBeLessThanOrEqual(now() + 7 * DAY);
    expect(JSON.parse(row.attachments).map((a: any) => a.filename)).toEqual(['chart.png', 'offer.pdf']);
    expect(all('SELECT 1 FROM attachments WHERE message_id = ?', [id])).toHaveLength(0);

    // The sender's Sent copy is the notice; bob (on this server) got the notice too.
    const mine = (await h.call('GET', `/api/mail/messages/${id}`)).body;
    expect(mine.html).toContain('sent you a private message');
    expect(mine.html).not.toContain('S3CRET-4242');
    expect(mine.attachments).toEqual([]);
    expect(mine.privateLink).toEqual({ days: 7, expiresAt: row.expires_at });
    const bobs = get<any>(`SELECT m.* FROM messages m JOIN users u ON u.id = m.user_id WHERE u.email = 'bob@wren.test' AND m.subject = 'Salary review'`);
    expect(bobs.text_body).toContain(`/p/${token}`);
    expect(bobs.text_body).not.toContain('S3CRET-4242');
    expect(bobs.has_attachments).toBe(0);
  });

  it('the notice carries nothing of the message', async () => {
    const out = (await outbox('user')).find((o) => o.subject === 'Salary review')!;
    for (const leak of ['S3CRET-4242', 'offer.pdf', 'chart.png', Buffer.from('offer-file-4242').toString('base64'), 'Content-Disposition']) expect(out.raw).not.toContain(leak);
  });

  it('shows the content to anyone with the link, with no caching or referrer', async () => {
    const res = await anon(`/api/private/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ subject: 'Salary review', from: { address: 'admin@wren.test', name: 'Ada Admin' } });
    expect(body.html).toContain('S3CRET-4242');
    expect(body.attachments.map((a: any) => a.filename)).toEqual(['chart.png', 'offer.pdf']);
    expect(JSON.stringify(body)).not.toMatch(/"blob"/);

    const file = await anon(`/api/private/${token}/attachments/${fileId}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(file.headers.get('Cache-Control')).toBe('no-store');
    expect(await file.text()).toBe('offer-file-4242');
    expect((await anon(`/api/private/${token}/attachments/${picture.id}?inline=1`)).headers.get('Content-Disposition')).toMatch(/^inline/);
    // Attachments only with the right token, and only this message's.
    expect((await anon(`/api/private/${'x'.repeat(43)}/attachments/${fileId}`)).status).toBe(404);
    expect((await anon(`/api/private/${token}/attachments/999999`)).status).toBe(404);
  });

  it('gives expired, withdrawn and unknown links the same answer', async () => {
    const answers: unknown[] = [];
    const ask = async (t: string) => {
      const res = await anon(`/api/private/${t}`);
      answers.push({ status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') });
    };
    await ask('A'.repeat(43));
    await ask('not-a-token');
    run('UPDATE private_links SET expires_at = ? WHERE message_id = ?', [now() - 1, id]);
    await ask(token);
    expect((await anon(`/api/private/${token}/attachments/${fileId}`)).status).toBe(404);
    expect((await h.call('GET', `/api/mail/messages/${id}/private`)).status).toBe(404);
    run('UPDATE private_links SET expires_at = ? WHERE message_id = ?', [now() + DAY, id]);
    expect((await anon(`/api/private/${token}`)).status).toBe(200);

    // Only the sender can stop sharing.
    await h.login('bob@wren.test', PW);
    expect((await h.call('DELETE', `/api/mail/messages/${id}/private`)).status).toBe(404);
    expect((await h.call('GET', `/api/mail/messages/${id}/private`)).status).toBe(404);
    expect((await h.call('GET', `/api/mail/messages/${id}/private/attachments/${fileId}`)).status).toBe(404);
    expect((await anon(`/api/private/${token}`)).status).toBe(200);
    h.as('admin@wren.test');
    const own = await h.call('GET', `/api/mail/messages/${id}/private`);
    expect(own.body.html).toContain('S3CRET-4242');
    const ownFile = await h.request(`/api/mail/messages/${id}/private/attachments/${fileId}`);
    expect(ownFile.headers.get('Cache-Control')).toBe('no-store');
    expect(await ownFile.text()).toBe('offer-file-4242');
    expect((await h.call('DELETE', `/api/mail/messages/${id}/private`)).status).toBe(200);
    expect(link(id)).toBeUndefined();
    expect((await h.call('GET', `/api/mail/messages/${id}`)).body.privateLink).toBeNull();
    expect((await h.call('DELETE', `/api/mail/messages/${id}/private`)).status).toBe(404);
    await ask(token);

    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, body: { error: 'This message has expired or was withdrawn', code: 'gone' }, cache: 'no-store' });
  });

  it('deletes expired links in maintenance, and their files then go', async () => {
    const { id: mid } = await sendPrivate('Old secret', 'EXPIRING-77');
    await deliverNow();
    const blob = JSON.parse(link(mid).attachments)[0].blob as string;
    // Past the hour fresh files are left alone.
    const later = Date.now() + 2 * 3_600_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await collectGarbage();
    expect(get('SELECT 1 FROM blob_tombstones WHERE key = ?', [blob])).toBeUndefined();

    run('UPDATE private_links SET expires_at = ? WHERE message_id = ?', [later - 1, mid]);
    runMaintenance();
    expect(link(mid)).toBeUndefined();
    await collectGarbage();
    expect(get('SELECT 1 FROM blob_tombstones WHERE key = ?', [blob])).toBeTruthy();
  });

  it('works with undo and scheduled send', async () => {
    // Undo: the draft is back with its content and still marked private.
    const { id: mid } = await sendPrivate('Second thoughts', 'UNDO-55', { privateDays: 1 });
    expect((await h.call('POST', `/api/compose/messages/${mid}/cancel`)).status).toBe(200);
    const draft = (await h.call('GET', `/api/compose/drafts/${mid}`)).body;
    expect(draft.html).toContain('UNDO-55');
    expect(draft.attachments).toHaveLength(1);
    expect(draft.privateLink).toEqual({ days: 1, expiresAt: null });
    // Turned off in the draft, it's a normal message again.
    await h.call('PUT', `/api/compose/drafts/${mid}`, { to: [{ address: 'kim@ext.example' }], subject: 'Second thoughts', html: '<p>x</p>', privateDays: null });
    expect(link(mid)).toBeUndefined();

    // Scheduled: the link is made when it goes out, and the expiry counts from then.
    const { id: sid } = await sendPrivate('Later', 'SCHEDULED-66', { privateDays: 1, sendAt: now() + 3 * 3_600_000 });
    await processQueue();
    expect(link(sid).token_hash).toBeNull();
    await deliverNow();
    expect(link(sid).expires_at).toBeGreaterThan(now() + DAY - 60_000);
    expect(link(sid).expires_at).toBeLessThanOrEqual(now() + DAY);

    // Once its link is made it can't be called back, even while delivery is retried.
    run(`UPDATE outbox SET status = 'queued' WHERE message_id = ?`, [sid]);
    run(`UPDATE messages SET status = 'queued' WHERE id = ?`, [sid]);
    expect((await h.call('POST', `/api/compose/messages/${sid}/cancel`)).status).toBe(400);
  });
});
