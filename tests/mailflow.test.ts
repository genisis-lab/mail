import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, insert, now, openDb, run } from '../src/server/db/index';
import { nodeSqlDriver } from './sqlite';
import { withDurableObjectLimits } from './do-limits';
import { encryptJson, randomToken } from '../src/server/lib/crypto';
import { createUser, savePrefs, getPrefs } from '../src/server/services/users';
import { resolveRecipient } from '../src/server/services/routing';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { processQueue } from '../src/server/mail/outbound';
import { saveDraft, sendDraft, cancelSend, composeTemplate } from '../src/server/mail/send';
import { applyThreadAction, getThread, listThreads, counters } from '../src/server/mail/threads';
import { invalidateSettings } from '../src/server/settings';

let alice: number;
let bob: number;

async function inbound(opts: Parameters<typeof buildMime>[0], rcpt: string[]) {
  const { raw } = await buildMime(opts);
  return ingest(raw, { rcptTo: rcpt, source: 'test' });
}

beforeAll(async () => {
  openDb(withDurableObjectLimits(nodeSqlDriver(':memory:')));
  invalidateSettings();
  const ts = now();
  insert('INSERT INTO domains (name, verify_token, created_at) VALUES (?, ?, ?)', ['wren.test', 'tok', ts]);
  alice = await createUser({ email: 'alice@wren.test', name: 'Alice', password: 'correct horse battery', role: 'owner' });
  bob = await createUser({ email: 'bob@wren.test', name: 'Bob', password: 'another long password' });
});

describe('routing', () => {
  it('resolves mailboxes, plus-addressing, aliases, groups and catch-all', () => {
    const d = get<{ id: number }>('SELECT id FROM domains WHERE name = ?', ['wren.test'])!;
    insert(`INSERT INTO addresses (address, domain_id, kind, user_id, created_at) VALUES ('hello@wren.test', ?, 'alias', ?, ?)`, [d.id, alice, now()]);
    const g = insert(`INSERT INTO addresses (address, domain_id, kind, created_at) VALUES ('team@wren.test', ?, 'group', ?)`, [d.id, now()]);
    insert('INSERT INTO address_targets (address_id, user_id) VALUES (?, ?)', [g, alice]);
    insert('INSERT INTO address_targets (address_id, user_id) VALUES (?, ?)', [g, bob]);
    insert('INSERT INTO address_targets (address_id, external) VALUES (?, ?)', [g, 'partner@example.com']);

    expect(resolveRecipient('alice@wren.test').userIds).toEqual([alice]);
    expect(resolveRecipient('Alice+news@WREN.test').userIds).toEqual([alice]);
    expect(resolveRecipient('hello@wren.test').userIds).toEqual([alice]);
    const team = resolveRecipient('team@wren.test');
    expect(team.userIds.sort()).toEqual([alice, bob].sort());
    expect(team.external).toEqual(['partner@example.com']);
    expect(resolveRecipient('nobody@wren.test').userIds).toEqual([]);
    expect(resolveRecipient('x@other.test').reason).toBe('domain not hosted');

    run('UPDATE domains SET catch_all_user_id = ? WHERE id = ?', [bob, d.id]);
    expect(resolveRecipient('anything@wren.test').userIds).toEqual([bob]);
    run('UPDATE domains SET catch_all_user_id = NULL WHERE id = ?', [d.id]);
  });
});

describe('inbound pipeline', () => {
  it('stores, threads replies, dedupes, and rejects unknown recipients', async () => {
    const r1 = await inbound(
      { from: { address: 'maya@northwind.io', name: 'Maya' }, to: [{ address: 'alice@wren.test' }], subject: 'Roadmap', text: 'first', messageId: 'r1@northwind.io' },
      ['alice@wren.test', 'ghost@wren.test'],
    );
    expect(r1.accepted).toEqual(['alice@wren.test']);
    expect(r1.rejected[0]).toMatchObject({ rcpt: 'ghost@wren.test' });
    const r2 = await inbound(
      { from: { address: 'maya@northwind.io', name: 'Maya' }, to: [{ address: 'alice@wren.test' }], subject: 'Re: Roadmap', text: 'second', messageId: 'r2@northwind.io', inReplyTo: 'r1@northwind.io', references: ['r1@northwind.io'] },
      ['alice@wren.test'],
    );
    expect(r2.delivered).toBe(1);
    const dup = await inbound({ from: { address: 'maya@northwind.io' }, to: [{ address: 'alice@wren.test' }], subject: 'Roadmap', text: 'first', messageId: 'r1@northwind.io' }, ['alice@wren.test']);
    expect(dup.delivered).toBe(0);

    const list = listThreads(alice, { view: 'inbox' });
    const t = list.threads.find((x) => x.subject === 'Roadmap')!;
    expect(t.count).toBe(2);
    expect(t.unread).toBe(true);
    expect((await getThread(alice, t.id))!.messages.map((m) => m.text?.trim())).toEqual(['first', 'second']);
  });

  it('sends obvious spam to the spam folder', async () => {
    await inbound(
      { from: { address: 'win@prize.example', name: 'WINNER' }, to: [{ address: 'alice@wren.test' }], subject: 'CONGRATULATIONS YOU ARE A WINNER!!!', text: 'Claim your prize. Wire transfer. Act now, 100% free. viagra casino' },
      ['alice@wren.test'],
    );
    expect(listThreads(alice, { view: 'spam' }).threads.map((t) => t.subject)).toContain('CONGRATULATIONS YOU ARE A WINNER!!!');
  });

  it('applies user filters (label + skip inbox)', async () => {
    const label = insert(`INSERT INTO labels (user_id, name, created_at) VALUES (?, 'Receipts', ?)`, [alice, now()]);
    insert(`INSERT INTO filters (user_id, criteria, actions, created_at) VALUES (?, ?, ?, ?)`, [alice, JSON.stringify({ from: 'stripe' }), JSON.stringify({ skipInbox: true, labelId: label, markRead: true }), now()]);
    await inbound({ from: { address: 'receipts@stripe.example' }, to: [{ address: 'alice@wren.test' }], subject: 'Your receipt', text: '$49' }, ['alice@wren.test']);
    expect(listThreads(alice, { view: 'inbox' }).threads.some((t) => t.subject === 'Your receipt')).toBe(false);
    const labelled = listThreads(alice, { labelId: label });
    expect(labelled.threads[0]).toMatchObject({ subject: 'Your receipt', unread: false });
  });

  it('delivers group mail to members and forwards to external members', async () => {
    await inbound({ from: { address: 'jordan@studio.example' }, to: [{ address: 'team@wren.test' }], subject: 'Logo concepts', text: 'hi team' }, ['team@wren.test']);
    expect(listThreads(bob, { view: 'inbox' }).threads.some((t) => t.subject === 'Logo concepts')).toBe(true);
    const fwd = get<any>(`SELECT * FROM outbox WHERE kind = 'forward' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(fwd.recipients)).toEqual(['partner@example.com']);
    expect(fwd.mail_from).toBe('team@wren.test');
  });

  it('sends a vacation auto-reply once per sender', async () => {
    const prefs = getPrefs(bob);
    prefs.vacation = { ...prefs.vacation, enabled: true, subject: 'Away', message: 'Back Monday' };
    savePrefs(bob, prefs);
    for (let i = 0; i < 2; i++) {
      await inbound({ from: { address: 'client@corp.example' }, to: [{ address: 'bob@wren.test' }], subject: `Question ${i}`, text: '?' }, ['bob@wren.test']);
    }
    await new Promise((r) => setTimeout(r, 50));
    const replies = all<any>(`SELECT * FROM outbox WHERE kind = 'autoreply' AND user_id = ?`, [bob]);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0].recipients)).toEqual(['client@corp.example']);
    // No auto-replies to mailing lists.
    await inbound({ from: { address: 'news@list.example' }, to: [{ address: 'bob@wren.test' }], subject: 'Digest', text: 'x', headers: { 'List-Id': '<news.list.example>' } }, ['bob@wren.test']);
    await new Promise((r) => setTimeout(r, 50));
    expect(all(`SELECT 1 FROM outbox WHERE kind = 'autoreply' AND user_id = ?`, [bob])).toHaveLength(1);
    prefs.vacation.enabled = false;
    savePrefs(bob, prefs);
  });
});

describe('sending', () => {
  it('delivers locally, sends externally via the default provider, and supports undo', async () => {
    insert('INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)', [
      'Log',
      'log',
      encryptJson({}),
      randomToken(),
      now(),
    ]);
    const draft = await saveDraft(alice, { to: 'Bob <bob@wren.test>, ext@example.com', subject: 'Welcome', html: '<p>Hi Bob</p>' });
    const res = await sendDraft(alice, draft, { undoSeconds: 0 });
    expect(res.undoUntil).not.toBeNull();
    await processQueue();
    const sent = get<any>('SELECT status, provider_message_id FROM messages WHERE id = ?', [draft]);
    expect(sent.status).toBe('sent');
    expect(sent.provider_message_id).toMatch(/^log-/);
    expect(listThreads(bob, { view: 'inbox' }).threads.some((t) => t.subject === 'Welcome')).toBe(true);
    expect(listThreads(alice, { view: 'sent' }).threads.some((t) => t.subject === 'Welcome')).toBe(true);

    // Undo before the queue runs turns it back into a draft.
    const d2 = await saveDraft(alice, { to: 'bob@wren.test', subject: 'Oops', html: '<p>wrong</p>' });
    await sendDraft(alice, d2, { undoSeconds: 30 });
    expect(cancelSend(alice, d2)).toBe(true);
    expect(get<any>('SELECT folder, status FROM messages WHERE id = ?', [d2])).toMatchObject({ folder: 'drafts', status: 'draft' });
  });

  it('threads replies with the original and builds reply-all recipients', async () => {
    const t = listThreads(alice, { view: 'inbox' }).threads.find((x) => x.subject === 'Roadmap')!;
    const last = (await getThread(alice, t.id))!.messages.at(-1)!;
    const tpl = await composeTemplate(alice, last.id, 'replyAll');
    expect(tpl.subject).toBe('Re: Roadmap');
    expect(tpl.to.map((a) => a.address)).toEqual(['maya@northwind.io']);
    const id = await saveDraft(alice, { ...tpl, attachments: [], html: '<p>Thanks!</p>' });
    expect(get<any>('SELECT thread_id, in_reply_to FROM messages WHERE id = ?', [id])).toMatchObject({ thread_id: t.id, in_reply_to: 'r2@northwind.io' });
  });

  it('bounces when no provider can send', async () => {
    run('UPDATE providers SET enabled = 0');
    const d = await saveDraft(alice, { to: 'someone@else.example', subject: 'Nowhere', html: '<p>x</p>' });
    await sendDraft(alice, d, { undoSeconds: 0 });
    run('UPDATE outbox SET next_attempt_at = 0 WHERE message_id = ?', [d]);
    await processQueue();
    expect(get<any>('SELECT status, last_error FROM messages WHERE id = ?', [d]).status).toBe('failed');
    const bounce = listThreads(alice, { view: 'inbox' }).threads.find((x) => x.subject === 'Nowhere');
    expect(bounce?.count).toBeGreaterThanOrEqual(1);
    run('UPDATE providers SET enabled = 1');
  });
});

describe('thread actions & search', () => {
  it('archives, snoozes, trashes and searches', async () => {
    const t = listThreads(alice, { view: 'inbox' }).threads.find((x) => x.subject === 'Roadmap')!;
    applyThreadAction(alice, [t.id], { type: 'archive' });
    expect(listThreads(alice, { view: 'inbox' }).threads.some((x) => x.id === t.id)).toBe(false);
    expect(listThreads(alice, { view: 'all' }).threads.some((x) => x.id === t.id)).toBe(true);
    applyThreadAction(alice, [t.id], { type: 'inbox' });
    applyThreadAction(alice, [t.id], { type: 'snooze', until: Date.now() + 3600_000 });
    expect(listThreads(alice, { view: 'snoozed' }).threads.some((x) => x.id === t.id)).toBe(true);
    expect(listThreads(alice, { view: 'inbox' }).threads.some((x) => x.id === t.id)).toBe(false);
    applyThreadAction(alice, [t.id], { type: 'unsnooze' });

    expect(listThreads(alice, { query: 'from:maya' }).threads.map((x) => x.id)).toContain(t.id);
    expect(listThreads(alice, { query: 'secon' }).threads.map((x) => x.id)).toContain(t.id);
    expect(listThreads(alice, { query: '-roadmap from:maya' }).threads).toHaveLength(0);

    applyThreadAction(alice, [t.id], { type: 'trash' });
    expect(listThreads(alice, { view: 'trash' }).threads.some((x) => x.id === t.id)).toBe(true);
    applyThreadAction(alice, [t.id], { type: 'delete' });
    // Only the unsent reply draft survives (drafts are never deleted by thread actions).
    expect((await getThread(alice, t.id))!.messages.map((m) => m.folder)).toEqual(['drafts']);
    expect(counters(alice).inbox).toBeGreaterThanOrEqual(0);
  });
});

describe('large data', () => {
  it('keeps very large bodies out of the database row', async () => {
    const big = `<p>needle-${'z'.repeat(10)}</p>` + '<p>' + 'lorem ipsum dolor sit amet '.repeat(40_000) + '</p>';
    await inbound({ from: { address: 'news@big.example' }, to: [{ address: 'bob@wren.test' }], subject: 'Huge newsletter', html: big }, ['bob@wren.test']);
    const row = get<{ thread_id: number; html_body: string | null; body_blob: string | null; text_body: string }>(
      `SELECT thread_id, html_body, body_blob, text_body FROM messages WHERE subject = 'Huge newsletter'`,
    )!;
    expect(row.html_body).toBeNull();
    expect(row.body_blob).toMatch(/^[a-f0-9]{64}$/);
    expect(row.text_body.length).toBeLessThanOrEqual(100_000);
    const t = (await getThread(bob, row.thread_id))!;
    expect(t.messages[0].html!.length).toBeGreaterThan(1_000_000);
    expect(listThreads(bob, { query: 'needle' }).threads.map((x) => x.id)).toContain(row.thread_id);

    // Replying quotes the whole message; the draft overflows the same way.
    const tpl = await composeTemplate(bob, t.messages[0].id, 'reply');
    const draftId = await saveDraft(bob, { ...tpl, attachments: [] });
    expect(get<{ body_blob: string | null }>('SELECT body_blob FROM messages WHERE id = ?', [draftId])!.body_blob).toBeTruthy();
    await sendDraft(bob, draftId, { undoSeconds: 0 });
    expect(get<{ status: string }>('SELECT status FROM messages WHERE id = ?', [draftId])!.status).toMatch(/queued|sent/);
  });

  it('applies bulk actions to more than 100 conversations at once', async () => {
    for (let i = 0; i < 130; i++) {
      await inbound({ from: { address: `bulk${i}@list.example` }, to: [{ address: 'alice@wren.test' }], subject: `Bulk ${i}`, text: 'x' }, ['alice@wren.test']);
    }
    const page = listThreads(alice, { query: 'subject:bulk', pageSize: 100 });
    expect(page.total).toBe(130);
    expect(page.threads).toHaveLength(100);
    const ids = all<{ id: number }>(`SELECT DISTINCT thread_id AS id FROM messages WHERE subject LIKE 'Bulk %'`).map((r) => r.id);
    expect(applyThreadAction(alice, ids, { type: 'archive' })).toBe(130);
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE subject LIKE 'Bulk %' AND folder = 'inbox'`)!.c).toBe(0);
  });
});
