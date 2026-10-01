import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/server/config';
import { all, get, insert, now, openDb, run } from '../src/server/db/index';
import { nodeSqlDriver } from '../src/server/db/node';
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
  openDb(nodeSqlDriver(':memory:'));
  invalidateSettings();
  const ts = now();
  insert('INSERT INTO domains (name, verify_token, created_at) VALUES (?, ?, ?)', ['acme.test', 'tok', ts]);
  alice = await createUser({ email: 'alice@acme.test', name: 'Alice', password: 'correct horse battery', role: 'owner' });
  bob = await createUser({ email: 'bob@acme.test', name: 'Bob', password: 'another long password' });
  expect(config.dataDir).toContain('wren-test');
});

describe('routing', () => {
  it('resolves mailboxes, plus-addressing, aliases, groups and catch-all', () => {
    const d = get<{ id: number }>('SELECT id FROM domains WHERE name = ?', ['acme.test'])!;
    insert(`INSERT INTO addresses (address, domain_id, kind, user_id, created_at) VALUES ('hello@acme.test', ?, 'alias', ?, ?)`, [d.id, alice, now()]);
    const g = insert(`INSERT INTO addresses (address, domain_id, kind, created_at) VALUES ('team@acme.test', ?, 'group', ?)`, [d.id, now()]);
    insert('INSERT INTO address_targets (address_id, user_id) VALUES (?, ?)', [g, alice]);
    insert('INSERT INTO address_targets (address_id, user_id) VALUES (?, ?)', [g, bob]);
    insert('INSERT INTO address_targets (address_id, external) VALUES (?, ?)', [g, 'partner@example.com']);

    expect(resolveRecipient('alice@acme.test').userIds).toEqual([alice]);
    expect(resolveRecipient('Alice+news@ACME.test').userIds).toEqual([alice]);
    expect(resolveRecipient('hello@acme.test').userIds).toEqual([alice]);
    const team = resolveRecipient('team@acme.test');
    expect(team.userIds.sort()).toEqual([alice, bob].sort());
    expect(team.external).toEqual(['partner@example.com']);
    expect(resolveRecipient('nobody@acme.test').userIds).toEqual([]);
    expect(resolveRecipient('x@other.test').reason).toBe('domain not hosted');

    run('UPDATE domains SET catch_all_user_id = ? WHERE id = ?', [bob, d.id]);
    expect(resolveRecipient('anything@acme.test').userIds).toEqual([bob]);
    run('UPDATE domains SET catch_all_user_id = NULL WHERE id = ?', [d.id]);
  });
});

describe('inbound pipeline', () => {
  it('stores, threads replies, dedupes, and rejects unknown recipients', async () => {
    const r1 = await inbound(
      { from: { address: 'maya@northwind.io', name: 'Maya' }, to: [{ address: 'alice@acme.test' }], subject: 'Roadmap', text: 'first', messageId: 'r1@northwind.io' },
      ['alice@acme.test', 'ghost@acme.test'],
    );
    expect(r1.accepted).toEqual(['alice@acme.test']);
    expect(r1.rejected[0]).toMatchObject({ rcpt: 'ghost@acme.test' });
    const r2 = await inbound(
      { from: { address: 'maya@northwind.io', name: 'Maya' }, to: [{ address: 'alice@acme.test' }], subject: 'Re: Roadmap', text: 'second', messageId: 'r2@northwind.io', inReplyTo: 'r1@northwind.io', references: ['r1@northwind.io'] },
      ['alice@acme.test'],
    );
    expect(r2.delivered).toBe(1);
    const dup = await inbound({ from: { address: 'maya@northwind.io' }, to: [{ address: 'alice@acme.test' }], subject: 'Roadmap', text: 'first', messageId: 'r1@northwind.io' }, ['alice@acme.test']);
    expect(dup.delivered).toBe(0);

    const list = listThreads(alice, { view: 'inbox' });
    const t = list.threads.find((x) => x.subject === 'Roadmap')!;
    expect(t.count).toBe(2);
    expect(t.unread).toBe(true);
    expect(getThread(alice, t.id)!.messages.map((m) => m.text?.trim())).toEqual(['first', 'second']);
  });

  it('sends obvious spam to the spam folder', async () => {
    await inbound(
      { from: { address: 'win@prize.example', name: 'WINNER' }, to: [{ address: 'alice@acme.test' }], subject: 'CONGRATULATIONS YOU ARE A WINNER!!!', text: 'Claim your prize. Wire transfer. Act now, 100% free. viagra casino' },
      ['alice@acme.test'],
    );
    expect(listThreads(alice, { view: 'spam' }).threads.map((t) => t.subject)).toContain('CONGRATULATIONS YOU ARE A WINNER!!!');
  });

  it('applies user filters (label + skip inbox)', async () => {
    const label = insert(`INSERT INTO labels (user_id, name, created_at) VALUES (?, 'Receipts', ?)`, [alice, now()]);
    insert(`INSERT INTO filters (user_id, criteria, actions, created_at) VALUES (?, ?, ?, ?)`, [alice, JSON.stringify({ from: 'stripe' }), JSON.stringify({ skipInbox: true, labelId: label, markRead: true }), now()]);
    await inbound({ from: { address: 'receipts@stripe.example' }, to: [{ address: 'alice@acme.test' }], subject: 'Your receipt', text: '$49' }, ['alice@acme.test']);
    expect(listThreads(alice, { view: 'inbox' }).threads.some((t) => t.subject === 'Your receipt')).toBe(false);
    const labelled = listThreads(alice, { labelId: label });
    expect(labelled.threads[0]).toMatchObject({ subject: 'Your receipt', unread: false });
  });

  it('delivers group mail to members and forwards to external members', async () => {
    await inbound({ from: { address: 'jordan@studio.example' }, to: [{ address: 'team@acme.test' }], subject: 'Logo concepts', text: 'hi team' }, ['team@acme.test']);
    expect(listThreads(bob, { view: 'inbox' }).threads.some((t) => t.subject === 'Logo concepts')).toBe(true);
    const fwd = get<any>(`SELECT * FROM outbox WHERE kind = 'forward' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(fwd.recipients)).toEqual(['partner@example.com']);
    expect(fwd.mail_from).toBe('team@acme.test');
  });

  it('sends a vacation auto-reply once per sender', async () => {
    const prefs = getPrefs(bob);
    prefs.vacation = { ...prefs.vacation, enabled: true, subject: 'Away', message: 'Back Monday' };
    savePrefs(bob, prefs);
    for (let i = 0; i < 2; i++) {
      await inbound({ from: { address: 'client@corp.example' }, to: [{ address: 'bob@acme.test' }], subject: `Question ${i}`, text: '?' }, ['bob@acme.test']);
    }
    await new Promise((r) => setTimeout(r, 50));
    const replies = all<any>(`SELECT * FROM outbox WHERE kind = 'autoreply' AND user_id = ?`, [bob]);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0].recipients)).toEqual(['client@corp.example']);
    // No auto-replies to mailing lists.
    await inbound({ from: { address: 'news@list.example' }, to: [{ address: 'bob@acme.test' }], subject: 'Digest', text: 'x', headers: { 'List-Id': '<news.list.example>' } }, ['bob@acme.test']);
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
    const draft = saveDraft(alice, { to: 'Bob <bob@acme.test>, ext@example.com', subject: 'Welcome', html: '<p>Hi Bob</p>' });
    const res = await sendDraft(alice, draft, { undoSeconds: 0 });
    expect(res.undoUntil).not.toBeNull();
    await processQueue();
    const sent = get<any>('SELECT status, provider_message_id FROM messages WHERE id = ?', [draft]);
    expect(sent.status).toBe('sent');
    expect(sent.provider_message_id).toMatch(/^log-/);
    expect(listThreads(bob, { view: 'inbox' }).threads.some((t) => t.subject === 'Welcome')).toBe(true);
    expect(listThreads(alice, { view: 'sent' }).threads.some((t) => t.subject === 'Welcome')).toBe(true);

    // Undo before the queue runs turns it back into a draft.
    const d2 = saveDraft(alice, { to: 'bob@acme.test', subject: 'Oops', html: '<p>wrong</p>' });
    await sendDraft(alice, d2, { undoSeconds: 30 });
    expect(cancelSend(alice, d2)).toBe(true);
    expect(get<any>('SELECT folder, status FROM messages WHERE id = ?', [d2])).toMatchObject({ folder: 'drafts', status: 'draft' });
  });

  it('threads replies with the original and builds reply-all recipients', async () => {
    const t = listThreads(alice, { view: 'inbox' }).threads.find((x) => x.subject === 'Roadmap')!;
    const last = getThread(alice, t.id)!.messages.at(-1)!;
    const tpl = composeTemplate(alice, last.id, 'replyAll');
    expect(tpl.subject).toBe('Re: Roadmap');
    expect(tpl.to.map((a) => a.address)).toEqual(['maya@northwind.io']);
    const id = saveDraft(alice, { ...tpl, attachments: [], html: '<p>Thanks!</p>' });
    expect(get<any>('SELECT thread_id, in_reply_to FROM messages WHERE id = ?', [id])).toMatchObject({ thread_id: t.id, in_reply_to: 'r2@northwind.io' });
  });

  it('bounces when no provider can send', async () => {
    run('UPDATE providers SET enabled = 0');
    const d = saveDraft(alice, { to: 'someone@else.example', subject: 'Nowhere', html: '<p>x</p>' });
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
    expect(getThread(alice, t.id)!.messages.map((m) => m.folder)).toEqual(['drafts']);
    expect(counters(alice).inbox).toBeGreaterThanOrEqual(0);
  });
});
