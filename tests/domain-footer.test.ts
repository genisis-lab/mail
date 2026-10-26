import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, now, run } from '../src/server/db/index';
import { getBlob } from '../src/server/mail/blobs';
import { saveDraft, sendDraft, storeUpload } from '../src/server/mail/send';
import { harness, outbox, processQueue } from './harness';

const h = harness();
const PW = 'a very long password';
const FOOTER = 'Confidential <b>& "private"</b>\nAcme Ltd, 1 Main St';
let wrenId = 0;
let otherId = 0;
let oli = 0;

/** The decoded message that went out for a sent message. */
async function sentRaw(messageId: number) {
  const o = get<{ raw_blob: string }>('SELECT raw_blob FROM outbox WHERE message_id = ? ORDER BY id DESC LIMIT 1', [messageId])!;
  const raw = (await getBlob(o.raw_blob)).toString('utf8');
  return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, x) => String.fromCharCode(parseInt(x, 16)));
}
const count = (s: string, part: string) => s.split(part).length - 1;
const send = async (input: Record<string, unknown>) => {
  const r = await h.call('POST', '/api/compose/send', { to: [{ address: 'kim@ext.example' }], ...input });
  expect(r.status).toBe(200);
  return r.body.id as number;
};

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
  otherId = (await h.call('POST', '/api/admin/domains', { name: 'other.test' })).body.id;
  wrenId = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!.id;
  oli = (await h.call('POST', '/api/admin/users', { email: 'oli@other.test', name: 'Oli', password: PW })).body.id;
});

describe('domain footer', () => {
  it('is set in the domain editor, limited, and audited', async () => {
    expect((await h.call('PUT', `/api/admin/domains/${wrenId}`, { footerText: 'x'.repeat(2001) })).status).toBe(400);
    expect((await h.call('PUT', `/api/admin/domains/${wrenId}`, { footerText: `  ${FOOTER.replace('\n', '\r\n')}\n` })).status).toBe(200);
    expect((await h.call('GET', `/api/admin/domains/${wrenId}`)).body.domain.footerText).toBe(FOOTER);
    expect((await h.call('GET', `/api/admin/domains/${otherId}`)).body.domain.footerText).toBe('');
    const a = get<{ details: string }>(`SELECT details FROM audit_log WHERE action = 'admin.domain_updated' ORDER BY id DESC LIMIT 1`)!;
    expect(JSON.parse(a.details).footerText).toBe(FOOTER);
  });

  it('is added once to the text and HTML parts, escaped, and kept in the Sent copy', async () => {
    const id = await send({ subject: 'With footer', html: '<p>Hello there</p>' });
    const raw = await sentRaw(id);
    expect(raw).toContain('Hello there');
    expect(raw).toContain(`\r\n\r\n${FOOTER.replace('\n', '\r\n')}`);
    expect(raw).toContain('Confidential &lt;b&gt;&amp; &quot;private&quot;&lt;/b&gt;<br>Acme Ltd, 1 Main St</div>');
    expect(raw.slice(raw.indexOf('text/html'))).not.toContain('<b>&'); // only the text part has it as written
    expect(count(raw, 'Acme Ltd')).toBe(2);
    const m = get<any>('SELECT html_body, text_body, footer_text FROM messages WHERE id = ?', [id]);
    expect(m.html_body).toMatch(/^<p>Hello there<\/p><hr [^>]*><div [^>]*>Confidential &lt;b&gt;/);
    expect(m.text_body.endsWith(`\n\n${FOOTER}`)).toBe(true);
    expect(m.footer_text).toBe(FOOTER);
  });

  it('comes off again on undo send, so a re-send has it once', async () => {
    const id = await send({ subject: 'Undo me', html: '<p>Draft text</p>', sendAt: now() + 3_600_000 });
    expect(count(await sentRaw(id), 'Acme Ltd')).toBe(2); // a scheduled send has it too
    expect((await h.call('POST', `/api/compose/messages/${id}/cancel`)).status).toBe(200);
    expect(get<any>('SELECT folder, html_body, text_body, footer_text FROM messages WHERE id = ?', [id])).toEqual({
      folder: 'drafts',
      html_body: '<p>Draft text</p>',
      text_body: 'Draft text',
      footer_text: null,
    });
    expect((await h.call('POST', `/api/compose/drafts/${id}/send`, {})).status).toBe(200);
    expect(count(await sentRaw(id), 'Acme Ltd')).toBe(2);
    expect(count(get<any>('SELECT html_body FROM messages WHERE id = ?', [id]).html_body, 'Acme Ltd')).toBe(1);
  });

  it('wraps a whole HTML document inside its body', async () => {
    const id = await send({ subject: 'Document', html: '<html><body><p>Doc</p></body></html>' });
    expect(await sentRaw(id)).toMatch(/<p>Doc<\/p><hr [^>]*><div [^>]*>Confidential[^]*<\/div><\/body><\/html>/);
  });

  it('skips PGP-signed and PGP-encrypted messages', async () => {
    const enc = await send({ subject: 'Secret', text: '-----BEGIN PGP MESSAGE-----\n\nwcBMA0\n-----END PGP MESSAGE-----\n' });
    const signed = await send({ subject: 'Signed', pgpSign: true, text: '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nHi\n-----BEGIN PGP SIGNATURE-----\n\nwsB\n-----END PGP SIGNATURE-----\n' });
    for (const id of [enc, signed]) {
      expect(await sentRaw(id)).not.toContain('Acme Ltd');
      expect(get<any>('SELECT footer_text FROM messages WHERE id = ?', [id]).footer_text).toBeNull();
    }
    // PGP/MIME: the draft carries an encrypted part.
    const admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
    const part = await storeUpload(admin, { filename: 'encrypted.asc', contentType: 'application/pgp-encrypted', content: Buffer.from('Version: 1\n') });
    const mime = await saveDraft(admin, { to: 'kim@ext.example', subject: 'PGP/MIME', html: '<p>x</p>', attachments: [part.id] });
    await sendDraft(admin, mime);
    expect(await sentRaw(mime)).not.toContain('Acme Ltd');
  });

  it('skips system mail and private-link notices', async () => {
    const before = all('SELECT id FROM outbox').length;
    const r = await h.call('POST', `/api/admin/users/${oli}/setup-link`, { sendTo: 'oli.home@ext.example' });
    expect(r.status).toBe(200);
    const notices = (await outbox()).filter((o) => o.to.includes('oli.home@ext.example'));
    expect(notices.length).toBe(1);
    expect(notices[0].raw).not.toContain('Acme Ltd');
    expect(all('SELECT id FROM outbox').length).toBe(before + 1);

    const id = await send({ subject: 'Private', html: '<p>The secret</p>', privateDays: 7 });
    run(`UPDATE outbox SET next_attempt_at = 0 WHERE status = 'queued'`);
    await processQueue();
    expect(await sentRaw(id)).not.toContain('Acme Ltd');
    expect(get<any>('SELECT html_body FROM private_links WHERE message_id = ?', [id]).html_body).not.toContain('Acme Ltd');
  });

  it('leaves other domains alone, and an empty footer turns it off', async () => {
    const d = await saveDraft(oli, { to: 'kim@ext.example', subject: 'From other', html: '<p>Other</p>' });
    await sendDraft(oli, d);
    expect(await sentRaw(d)).not.toContain('Acme Ltd');

    expect((await h.call('PUT', `/api/admin/domains/${wrenId}`, { footerText: '   ' })).status).toBe(200);
    expect(get<any>('SELECT footer_text FROM domains WHERE id = ?', [wrenId]).footer_text).toBeNull();
    const id = await send({ subject: 'No footer', html: '<p>Plain</p>' });
    const raw = await sentRaw(id);
    expect(raw).not.toContain('Acme Ltd');
    expect(raw).not.toContain('<hr');
  });
});
