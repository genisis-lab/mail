import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { DEFAULT_SETTINGS } from '../src/server/settings';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';

/** A friendly, well-formed message carrying one attachment. */
async function deliver(subject: string, filename: string) {
  const { raw } = await buildMime({
    from: { address: 'friend@example.org', name: 'Friend' },
    to: [{ address: 'admin@wren.test' }],
    subject,
    text: 'Here is the file.',
    attachments: [{ filename, contentType: 'application/octet-stream', content: Buffer.from('hello') }],
  });
  return ingest(raw, { rcptTo: ['admin@wren.test'], source: 'test' });
}
const message = (subject: string) => get<{ folder: string; spam_score: number | null }>('SELECT folder, spam_score FROM messages WHERE subject = ?', [subject]);
const logOf = (subject: string) => get<{ status: string; reason: string }>('SELECT status, reason FROM inbound_log WHERE subject = ? ORDER BY id DESC', [subject]);
const save = (values: Record<string, unknown>) => h.call('PUT', '/api/admin/settings', values);

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
});

describe('attachment policy', () => {
  it('defaults to the old executable list, adding to the spam score', async () => {
    const s = (await h.call('GET', '/api/admin/settings')).body.settings;
    expect(s['attachments.action']).toBe('score');
    expect(s['attachments.blockedTypes']).toEqual(['exe', 'scr', 'js', 'vbs', 'bat', 'cmd', 'jar', 'msi', 'com', 'pif']);

    await deliver('Plain report', 'report.pdf');
    await deliver('Sneaky report', 'invoice.pdf.EXE');
    expect(message('Plain report')!.folder).toBe('inbox');
    const sneaky = message('Sneaky report')!;
    expect(sneaky.folder).toBe('inbox');
    expect(sneaky.spam_score! - message('Plain report')!.spam_score!).toBe(4);
  });

  it('"spam" always routes such mail to Spam', async () => {
    expect((await save({ 'attachments.action': 'spam' })).status).toBe(200);
    await deliver('Setup file', 'setup.exe');
    await deliver('Notes file', 'notes.txt');
    expect(message('Setup file')!.folder).toBe('spam');
    expect(logOf('Setup file')).toEqual({ status: 'spam', reason: 'blocked attachment type' });
    expect(message('Notes file')!.folder).toBe('inbox');
  });

  it('"reject" refuses the message and logs why', async () => {
    await save({ 'attachments.action': 'reject' });
    const r = await deliver('Payload', 'payload.scr. ');
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([{ rcpt: 'admin@wren.test', reason: 'attachment type not allowed' }]);
    expect(message('Payload')).toBeUndefined();
    expect(logOf('Payload')!.status).toBe('rejected');
    expect(logOf('Payload')!.reason).toMatch(/^blocked attachment type: payload\.scr/);
  });

  it('uses a custom list instead of the defaults', async () => {
    await save({ 'attachments.blockedTypes': ['iso', 'lnk'] });
    expect((await deliver('Disk image', 'photos.ISO')).rejected).toHaveLength(1);
    expect((await deliver('Program', 'tool.exe')).delivered).toBe(1);
    expect(message('Program')!.folder).toBe('inbox');
  });

  it('validates and normalises the settings on save', async () => {
    const r = await save({ 'attachments.blockedTypes': ['.EXE', ' ..Lnk ', 'exe', ''] });
    expect(r.status).toBe(200);
    expect(r.body.settings['attachments.blockedTypes']).toEqual(['exe', 'lnk']);
    expect((await save({ 'attachments.blockedTypes': ['tar.gz'] })).status).toBe(400);
    expect((await save({ 'attachments.blockedTypes': ['a'.repeat(30)] })).status).toBe(400);
    expect((await save({ 'attachments.blockedTypes': 'exe' })).status).toBe(400);
    expect((await save({ 'attachments.blockedTypes': Array.from({ length: 101 }, (_, i) => `x${i}`) })).status).toBe(400);
    expect((await save({ 'attachments.action': 'delete' })).status).toBe(400);
    // Back to defaults is a plain save of the default values.
    await save({ 'attachments.blockedTypes': DEFAULT_SETTINGS['attachments.blockedTypes'], 'attachments.action': 'score' });
    const s = (await h.call('GET', '/api/admin/settings')).body.settings;
    expect(s['attachments.blockedTypes']).toEqual(DEFAULT_SETTINGS['attachments.blockedTypes']);
  });
});
