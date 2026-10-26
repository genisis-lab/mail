import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { runMaintenance } from '../src/server/jobs';
import { emailId } from '../src/server/jmap/ids';
import { closeStreams } from '../src/server/jmap/push';
import { harness } from './harness';

const h = harness();
const ids: Record<string, number> = {};
const GENERIC = /This mailbox can’t be permanently deleted right now/;
let appPassword: string;

/** Mail for `who`, already in `folder` (trash/spam long past retention). Returns the message id. */
async function deliver(who: string, subject: string, folder: 'inbox' | 'trash' | 'spam' = 'inbox') {
  const { raw } = await buildMime({ from: { address: 'pat@example.org' }, to: [{ address: `${who}@wren.test` }], subject, text: 'Keep this' });
  await ingest(raw, { rcptTo: [`${who}@wren.test`], source: 'test' });
  const m = get<{ id: number }>('SELECT id FROM messages WHERE user_id = ? AND subject = ?', [ids[who], subject])!;
  if (folder !== 'inbox') run('UPDATE messages SET folder = ?, trashed_at = ?, date = 0 WHERE id = ?', [folder, folder === 'trash' ? 1 : null, m.id]);
  return m.id;
}
const exists = (id: number) => !!get('SELECT 1 FROM messages WHERE id = ?', [id]);
const threadOf = (id: number) => get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', [id])!.thread_id;
const hold = (on: boolean, note?: string) => h.call('PUT', `/api/admin/users/${ids.hal}/legal-hold`, { hold: on, note });

async function jmapDestroy(id: number) {
  const row = get<any>('SELECT * FROM messages WHERE id = ?', [id]);
  const res = await h.app.request('/jmap/api', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`hal@wren.test:${appPassword}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Email/set', { accountId: `u${ids.hal}`, destroy: [emailId(row)] }, 'c']] }),
  });
  const body = (await res.json()) as any;
  return { jid: emailId(row), result: body.methodResponses[0][1] };
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  for (const name of ['hal', 'una']) ids[name] = (await h.call('POST', '/api/admin/users', { email: `${name}@wren.test`, name, password: `${name} password 123` })).body.id;
  await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': true });
  await h.login('hal@wren.test', 'hal password 123', 'hal');
  appPassword = (await h.call('POST', '/api/account/api-keys', { name: 'Phone', scope: 'mail' })).body.key;
});
afterAll(() => closeStreams());

describe('legal hold', () => {
  it('is placed by an admin only, with an optional note, and audited', async () => {
    h.as('hal');
    expect((await hold(true)).status).toBe(403);
    h.as('admin');
    const r = await hold(true, '  Case 2026-114  ');
    expect(r.status).toBe(200);
    expect(r.body.legalHold).toMatchObject({ note: 'Case 2026-114' });
    const d = (await h.call('GET', `/api/admin/users/${ids.hal}/detail`)).body;
    expect(d.user.legalHold).toMatchObject({ since: expect.any(Number), note: 'Case 2026-114' });
    const list = (await h.call('GET', '/api/admin/users')).body.users;
    expect(list.find((u: any) => u.id === ids.hal).legalHold).toBe(true);
    expect(list.find((u: any) => u.id === ids.una).legalHold).toBe(false);
    const entry = get<{ target: string; details: string }>(`SELECT target, details FROM audit_log WHERE action = 'admin.user_legal_hold_placed'`)!;
    expect(entry.target).toBe('hal@wren.test');
    expect(JSON.parse(entry.details)).toEqual({ note: 'Case 2026-114' });
  });

  it('keeps old trash and spam from the retention purge, for that mailbox only', async () => {
    const trash = await deliver('hal', 'Old trash', 'trash');
    const spam = await deliver('hal', 'Old spam', 'spam');
    const other = await deliver('una', 'Una old trash', 'trash');
    runMaintenance();
    expect(exists(trash)).toBe(true);
    expect(exists(spam)).toBe(true);
    expect(exists(other)).toBe(false);
  });

  it('refuses Delete forever and Empty trash with a generic message, but still moves mail to Trash', async () => {
    h.as('hal');
    const inbox = await deliver('hal', 'Still here');
    expect((await h.call('POST', `/api/mail/messages/${inbox}/actions`, { type: 'trash' })).status).toBe(200);
    const one = await h.call('POST', `/api/mail/messages/${inbox}/actions`, { type: 'delete' });
    expect(one.status).toBe(403);
    expect(one.body.error).toMatch(GENERIC);
    expect(one.body.error).not.toMatch(/hold/i);
    const thread = await h.call('POST', '/api/mail/threads/actions', { threadIds: [threadOf(inbox)], action: { type: 'delete' } });
    expect(thread.status).toBe(403);
    const empty = await h.call('POST', '/api/mail/threads/bulk', { view: 'trash', action: { type: 'delete' } });
    expect(empty.status).toBe(403);
    expect(empty.body.error).toMatch(GENERIC);
    expect(exists(inbox)).toBe(true);
  });

  it('refuses JMAP Email/set destroy', async () => {
    const id = await deliver('hal', 'From a phone', 'trash');
    const { jid, result } = await jmapDestroy(id);
    expect(result.destroyed).toEqual([]);
    expect(result.notDestroyed[jid]).toMatchObject({ type: 'forbidden', description: expect.stringMatching(GENERIC) });
    expect(exists(id)).toBe(true);
  });

  it('keeps a private link’s content when it expires or is withdrawn, while the link stops working', async () => {
    const expired = await deliver('hal', 'Private, expired');
    const live = await deliver('hal', 'Private, live');
    const ins = 'INSERT INTO private_links (user_id, message_id, days, token_hash, expires_at, text_body, created_at) VALUES (?, ?, 7, ?, ?, ?, 0)';
    run(ins, [ids.hal, expired, 'hash-expired', 1, 'the original']);
    run(ins, [ids.hal, live, 'hash-live', Date.now() + 86_400_000, 'the original']);
    runMaintenance();
    expect(get('SELECT 1 FROM private_links WHERE message_id = ?', [expired])).toBeTruthy();
    h.as('hal');
    expect((await h.call('DELETE', `/api/mail/messages/${live}/private`)).status).toBe(200);
    const kept = get<{ expires_at: number; text_body: string }>('SELECT expires_at, text_body FROM private_links WHERE message_id = ?', [live])!;
    expect(kept.text_body).toBe('the original');
    expect(kept.expires_at).toBeLessThanOrEqual(Date.now());
    // Withdrawn already: a second try says so.
    expect((await h.call('DELETE', `/api/mail/messages/${live}/private`)).status).toBe(404);
  });

  it('refuses deleting your own account, without saying why', async () => {
    h.as('hal');
    expect((await h.call('GET', '/api/account/delete')).body.blocked).toMatch(GENERIC);
    const r = await h.call('POST', '/api/account/delete', { password: 'hal password 123' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(GENERIC);
    expect(get('SELECT 1 FROM users WHERE id = ?', [ids.hal])).toBeTruthy();
  });

  it('refuses an admin deleting the user until the hold is released', async () => {
    h.as('admin');
    const r = await h.call('DELETE', `/api/admin/users/${ids.hal}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/legal hold.*Release the hold/);
    const bulk = (await h.call('POST', '/api/admin/users/bulk', { ids: [ids.hal], action: 'delete' })).body.results;
    expect(bulk[0]).toMatchObject({ ok: false, error: expect.stringMatching(/legal hold/) });
    expect(get('SELECT 1 FROM users WHERE id = ?', [ids.hal])).toBeTruthy();
  });

  it('once released, everything works as before', async () => {
    h.as('admin');
    const r = await hold(false);
    expect(r.body.legalHold).toBeNull();
    expect(get(`SELECT 1 FROM audit_log WHERE action = 'admin.user_legal_hold_released' AND target = 'hal@wren.test'`)).toBeTruthy();
    expect(get<{ legal_hold_note: string | null }>('SELECT legal_hold_note FROM users WHERE id = ?', [ids.hal])!.legal_hold_note).toBeNull();

    const oldTrash = get<{ id: number }>(`SELECT id FROM messages WHERE user_id = ? AND subject = 'Old trash'`, [ids.hal])!.id;
    runMaintenance();
    expect(exists(oldTrash)).toBe(false);
    expect(get(`SELECT 1 FROM private_links WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND subject = 'Private, expired')`, [ids.hal])).toBeUndefined();

    h.as('hal');
    const one = await deliver('hal', 'Delete me', 'trash');
    expect((await h.call('POST', `/api/mail/messages/${one}/actions`, { type: 'delete' })).status).toBe(200);
    expect(exists(one)).toBe(false);
    const viaJmap = await deliver('hal', 'Delete me too', 'trash');
    const { jid, result } = await jmapDestroy(viaJmap);
    expect(result.destroyed).toEqual([jid]);
    expect((await h.call('POST', '/api/mail/threads/bulk', { view: 'trash', action: { type: 'delete' } })).status).toBe(200);
    expect((await h.call('GET', '/api/account/delete')).body.blocked).toBeNull();

    h.as('admin');
    expect((await h.call('DELETE', `/api/admin/users/${ids.hal}`)).status).toBe(200);
    expect(get('SELECT 1 FROM users WHERE id = ?', [ids.hal])).toBeUndefined();
  });
});
