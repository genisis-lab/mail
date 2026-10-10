import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, run } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { purgeMessages } from '../src/server/mail/store';
import { createUser, getPrefs } from '../src/server/services/users';
import { sha256 } from '../src/server/lib/crypto';
import { closeStreams, encryptPayload, flushPush, validPushUrl } from '../src/server/jmap/push';
import { harness, outbox } from './harness';

const h = harness();
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse', 'urn:ietf:params:jmap:quota'];
let userId: number;
let account: string;
let appPassword: string;
let sendKey: string;

const basic = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
const auth = () => basic('admin@wren.test', appPassword);

async function jmap(methodCalls: [string, Record<string, unknown>, string][], using = USING) {
  const res = await h.app.request('/jmap/api', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ using, methodCalls }) });
  const body = (await res.json()) as any;
  return { status: res.status, body, responses: (body.methodResponses ?? []) as [string, any, string][] };
}

/** The arguments of the one response named `name` (the first, when several share a call id). */
async function call(name: string, args: Record<string, unknown>) {
  const { responses } = await jmap([[name, { accountId: account, ...args }, 'c']]);
  if (responses[0][0] === 'error') throw new Error(`${name}: ${JSON.stringify(responses[0][1])}`);
  return responses[0][1];
}

async function deliver(subject: string, text = 'Hello there') {
  const { raw } = await buildMime({ from: { address: 'grace@example.com', name: 'Grace Hopper' }, to: [{ address: 'admin@wren.test' }], subject, text });
  return ingest(raw, { rcptTo: ['admin@wren.test'], source: 'test' });
}

const idsIn = async (mailbox: string) => (await call('Email/query', { filter: { inMailbox: mailbox } })).ids as string[];

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  userId = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  account = `u${userId}`;
  // Start from an empty mailbox (setup leaves a welcome message).
  purgeMessages(all<{ id: number }>('SELECT id FROM messages').map((r) => r.id));
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => closeStreams());

describe('signing in', () => {
  it('is off until an admin turns it on', async () => {
    expect((await h.app.request('/jmap/session')).status).toBe(404);
    expect((await h.call('GET', '/api/account/mail-apps')).body.enabled).toBe(false);
    const refused = await h.call('POST', '/api/account/api-keys', { name: 'Phone', scope: 'mail' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/turned off/);

    expect((await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': true })).status).toBe(200);
    const created = await h.call('POST', '/api/account/api-keys', { name: 'Phone', scope: 'mail' });
    expect(created.body.scope).toBe('mail');
    appPassword = created.body.key;
    sendKey = (await h.call('POST', '/api/account/api-keys', { name: 'Website' })).body.key;
    const keys = (await h.call('GET', '/api/account/api-keys')).body.keys;
    expect(keys.map((k: any) => [k.name, k.scope]).sort()).toEqual([
      ['Phone', 'mail'],
      ['Website', 'send'],
    ]);
    expect((await h.call('GET', '/api/account/mail-apps')).body).toMatchObject({ enabled: true, username: 'admin@wren.test' });
  });

  it('takes app passwords, never the account password or a sending key', async () => {
    const none = await h.app.request('/jmap/session');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Basic realm="Wren"/);
    expect((await h.app.request('/jmap/session', { headers: basic('admin@wren.test', 'a very long password') })).status).toBe(401);
    expect((await h.app.request('/jmap/session', { headers: basic('admin@wren.test', sendKey) })).status).toBe(401);
    expect((await h.app.request('/jmap/session', { headers: { Authorization: `Bearer ${sendKey}` } })).status).toBe(401);
    expect((await h.app.request('/jmap/session', { headers: basic('someone@wren.test', appPassword) })).status).toBe(401);
    // The username is case-insensitive; Bearer works too.
    expect((await h.app.request('/jmap/session', { headers: basic('Admin@Wren.test', appPassword) })).status).toBe(200);
    expect((await h.app.request('/jmap/session', { headers: { Authorization: `Bearer ${appPassword}` } })).status).toBe(200);
  });

  it('describes the account in the session', async () => {
    const res = await h.app.request('/jmap/session', { headers: auth() });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const s = (await res.json()) as any;
    expect(Object.keys(s.capabilities)).toEqual(expect.arrayContaining(USING));
    expect(s.capabilities['urn:ietf:params:jmap:core']).toMatchObject({ maxCallsInRequest: 16, maxObjectsInGet: 500 });
    expect(s.accounts[account]).toMatchObject({ name: 'admin@wren.test', isPersonal: true, isReadOnly: false });
    expect(s.primaryAccounts['urn:ietf:params:jmap:mail']).toBe(account);
    expect(s.apiUrl).toMatch(/\/jmap\/api$/);
    expect(s.downloadUrl).toContain('{accountId}/{blobId}/{name}');
    expect(s.state).toMatch(/^\w{16}$/);

    const wellKnown = await h.app.request('/.well-known/jmap');
    expect(wellKnown.status).toBe(301);
    expect(wellKnown.headers.get('location')).toBe('/jmap/session');
  });

  it('slows down guessing', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < 20; i++) expect((await h.app.request('/jmap/session', { headers: { ...ip, ...basic('admin@wren.test', `wren_guess${i}`) } })).status).toBe(401);
    // Even the right password is refused from that address for a while.
    expect((await h.app.request('/jmap/session', { headers: { ...ip, ...auth() } })).status).toBe(429);
    expect((await h.app.request('/jmap/session', { headers: auth() })).status).toBe(200);
  });
});

describe('requests', () => {
  it('reports request and method errors', async () => {
    expect((await jmap([['Mailbox/get', { accountId: account }, '0']], ['urn:example:nope'])).body.type).toBe('urn:ietf:params:jmap:error:unknownCapability');
    const notJson = await h.app.request('/jmap/api', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{nope' });
    expect(((await notJson.json()) as any).type).toBe('urn:ietf:params:jmap:error:notJSON');
    const { responses } = await jmap([
      ['Mailbox/get', { accountId: 'u999' }, 'a'],
      ['Nope/get', { accountId: account }, 'b'],
      ['Email/get', { accountId: account, '#ids': { resultOf: 'zz', name: 'Email/query', path: '/ids' } }, 'c'],
      ['Email/get', { accountId: account, properties: ['bogus'], ids: [] }, 'd'],
    ]);
    expect(responses.map(([n, r, id]) => [n, r.type, id])).toEqual([
      ['error', 'accountNotFound', 'a'],
      ['error', 'unknownMethod', 'b'],
      ['error', 'invalidResultReference', 'c'],
      ['error', 'invalidArguments', 'd'],
    ]);
  });
});

describe('reading mail', () => {
  beforeAll(async () => {
    await deliver('Quarterly invoice', 'Your invoice for the quarter is attached.');
    await deliver('Garden party', 'Bring a hat.');
  });

  it('lists the folders as mailboxes, with counts', async () => {
    const { list } = await call('Mailbox/get', { ids: null });
    const byRole = Object.fromEntries(list.map((m: any) => [m.role, m]));
    expect(Object.keys(byRole).sort()).toEqual(['archive', 'drafts', 'inbox', 'junk', 'sent', 'trash']);
    expect(byRole.inbox).toMatchObject({ id: 'inbox', name: 'Inbox', totalEmails: 2, unreadEmails: 2, totalThreads: 2, unreadThreads: 2 });
    expect(byRole.inbox.myRights).toMatchObject({ mayReadItems: true, mayAddItems: true });
    expect(byRole.junk.name).toBe('Spam');
  });

  it('queries and reads email, following result references', async () => {
    const { responses } = await jmap([
      ['Email/query', { accountId: account, filter: { inMailbox: 'inbox' }, sort: [{ property: 'receivedAt', isAscending: false }], calculateTotal: true }, 'q'],
      [
        'Email/get',
        {
          accountId: account,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['subject', 'from', 'keywords', 'mailboxIds', 'threadId', 'preview', 'textBody', 'bodyValues', 'receivedAt'],
          fetchTextBodyValues: true,
        },
        'g',
      ],
      ['Thread/get', { accountId: account, '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
    ]);
    const [, query] = responses[0];
    expect(query.total).toBe(2);
    const [, got] = responses[1];
    const invoice = got.list.find((e: any) => e.subject === 'Quarterly invoice');
    expect(invoice.from).toEqual([{ name: 'Grace Hopper', email: 'grace@example.com' }]);
    expect(invoice.mailboxIds).toEqual({ inbox: true });
    expect(invoice.keywords).toEqual({});
    expect(invoice.preview).toMatch(/invoice for the quarter/);
    expect(invoice.bodyValues[invoice.textBody[0].partId].value).toMatch(/Your invoice for the quarter is attached/);
    const [, threads] = responses[2];
    expect(threads.list).toHaveLength(2);
    expect(threads.list.find((t: any) => t.id === invoice.threadId).emailIds).toEqual([invoice.id]);
  });

  it('searches and highlights', async () => {
    const ids = (await call('Email/query', { filter: { text: 'invoice' } })).ids;
    expect(ids).toHaveLength(1);
    expect((await call('Email/query', { filter: { from: 'grace' } })).ids).toHaveLength(2);
    expect((await call('Email/query', { filter: { operator: 'NOT', conditions: [{ subject: 'garden' }] } })).ids).toEqual(ids);
    const { list } = await call('SearchSnippet/get', { filter: { text: 'invoice' }, emailIds: ids });
    expect(list[0].subject).toContain('<mark>');
  });

  it('serves headers in the forms apps ask for', async () => {
    const [id] = (await call('Email/query', { filter: { subject: 'garden' } })).ids;
    const { list } = await call('Email/get', { ids: [id], properties: ['header:Subject:asText', 'header:From:asAddresses', 'messageId'] });
    expect(list[0]['header:Subject:asText']).toBe('Garden party');
    expect(list[0]['header:From:asAddresses']).toEqual([{ name: 'Grace Hopper', email: 'grace@example.com' }]);
    expect(list[0].messageId[0]).toMatch(/@/);
  });
});

describe('changes', () => {
  it('follows changes made anywhere, including the web app', async () => {
    const before = (await call('Email/get', { ids: [] })).state;
    const boxState = (await call('Mailbox/get', { ids: [] })).state;
    await deliver('Train tickets');
    await deliver('Bus tickets');
    const [ticket] = (await call('Email/query', { filter: { subject: 'train' } })).ids;
    const [bus] = (await call('Email/query', { filter: { subject: 'bus' } })).ids;

    // A page at a time, when asked.
    const paged = await call('Email/changes', { sinceState: before, maxChanges: 1 });
    expect(paged).toMatchObject({ created: [ticket], hasMoreChanges: true });
    expect(await call('Email/changes', { sinceState: paged.newState })).toMatchObject({ created: [bus], hasMoreChanges: false });

    let changes = await call('Email/changes', { sinceState: before });
    expect(changes).toMatchObject({ created: [ticket, bus], updated: [], destroyed: [], hasMoreChanges: false });

    // Archive it in the web app.
    const threadId = get<{ thread_id: number }>(`SELECT thread_id FROM messages WHERE subject = 'Train tickets'`)!.thread_id;
    h.as('admin');
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [threadId], action: { type: 'archive' } })).status).toBe(200);
    changes = await call('Email/changes', { sinceState: changes.newState });
    expect(changes).toMatchObject({ created: [], updated: [ticket], destroyed: [] });
    const got = await call('Email/get', { ids: [ticket], properties: ['mailboxIds'] });
    expect(got.list[0].mailboxIds).toEqual({ archive: true });

    const boxes = await call('Mailbox/changes', { sinceState: boxState });
    expect(boxes.updated).toEqual(expect.arrayContaining(['inbox', 'archive']));
    expect(boxes.updatedProperties).toEqual(['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']);

    expect((await call('Email/changes', { sinceState: changes.newState })).updated).toEqual([]);
    expect((await call('Thread/changes', { sinceState: before })).created).toHaveLength(2);
  });

  it('refuses old states after a rollback or restore, so apps start over', async () => {
    const state = (await call('Email/get', { ids: [] })).state;
    const { modseq } = get<{ modseq: number }>('SELECT modseq FROM jmap_modseq WHERE user_id = ?', [userId])!;
    await deliver('Before the rollback');
    const ahead = (await call('Email/get', { ids: [] })).state;
    // Point-in-time recovery to the moment of `state`: the log after it is gone…
    run('DELETE FROM jmap_changes WHERE user_id = ? AND modseq > ?', [userId, modseq]);
    run('UPDATE jmap_modseq SET modseq = ? WHERE user_id = ?', [modseq, userId]);
    // …and something else happens instead, reaching the same counter.
    await deliver('After the rollback');
    expect((await call('Email/get', { ids: [] })).state).not.toBe(ahead);
    const { responses } = await jmap([['Email/changes', { accountId: account, sinceState: ahead }, 'x']]);
    expect(responses[0]).toEqual(['error', expect.objectContaining({ type: 'cannotCalculateChanges' }), 'x']);
    // A state from before the rollback point still works.
    expect((await call('Email/changes', { sinceState: state })).created).toHaveLength(1);

    // Restoring a backup clears the log (as backup.finish does).
    run('DELETE FROM jmap_changes');
    run('DELETE FROM jmap_modseq');
    await deliver('After the restore');
    const again = await jmap([['Email/changes', { accountId: account, sinceState: state }, 'y']]);
    expect(again.responses[0][1].type).toBe('cannotCalculateChanges');
    const bad = await jmap([['Email/changes', { accountId: account, sinceState: 'garbage' }, 'z']]);
    expect(bad.responses[0][1].type).toBe('cannotCalculateChanges');
  });
});

describe('organizing', () => {
  it('sets keywords and moves between mailboxes', async () => {
    const [id] = await idsIn('inbox');
    const res = await call('Email/set', { update: { [id]: { 'keywords/$seen': true, 'keywords/$flagged': true, 'keywords/$forwarded': true } } });
    expect(res.updated).toEqual({ [id]: null });
    const row = get<any>('SELECT is_read, is_starred, keywords FROM messages WHERE id = ?', [Number(/^M(\d+)/.exec(id)![1])]);
    expect(row).toMatchObject({ is_read: 1, is_starred: 1 });
    expect(JSON.parse(row.keywords)).toEqual(['$forwarded']);
    expect((await call('Email/get', { ids: [id], properties: ['keywords'] })).list[0].keywords).toEqual({ $seen: true, $flagged: true, $forwarded: true });

    await call('Email/set', { update: { [id]: { mailboxIds: { trash: true } } } });
    expect((await call('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ trash: true });
    await call('Email/set', { update: { [id]: { mailboxIds: { inbox: true } } } });

    // Two folders at once can't be.
    const twice = await call('Email/set', { update: { [id]: { mailboxIds: { inbox: true, archive: true } } } });
    expect(twice.notUpdated[id].type).toBe('invalidProperties');
  });

  it('turns labels into mailboxes', async () => {
    const created = await call('Mailbox/set', { create: { r: { name: 'Receipts' } } });
    const box = created.created.r.id as string;
    expect(box).toMatch(/^L\d+C\d+$/);
    const [id] = await idsIn('inbox');
    await call('Email/set', { update: { [id]: { [`mailboxIds/${box}`]: true } } });
    expect(await idsIn(box)).toEqual([id]);
    expect((await call('Mailbox/get', { ids: [box] })).list[0]).toMatchObject({ name: 'Receipts', role: null, totalEmails: 1 });

    // Taking it out of the inbox, leaving only the label, archives it.
    await call('Email/set', { update: { [id]: { 'mailboxIds/inbox': null } } });
    expect((await call('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ archive: true, [box]: true });

    const forbidden = await call('Mailbox/set', { destroy: ['inbox'], update: { inbox: { name: 'Mine' } } });
    expect(forbidden.notDestroyed.inbox.type).toBe('forbidden');
    expect(forbidden.notUpdated.inbox.type).toBe('forbidden');
    expect((await call('Mailbox/set', { destroy: [box] })).notDestroyed[box].type).toBe('mailboxHasEmail');
    expect((await call('Mailbox/set', { destroy: [box], onDestroyRemoveEmails: true })).destroyed).toEqual([box]);
    // The email itself stays (labels aren't where mail lives).
    expect((await call('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ archive: true });
  });
});

describe('writing and sending', () => {
  it('saves a draft and sends it, moving it to Sent', async () => {
    const identities = await call('Identity/get', { ids: null });
    const me = identities.list.find((i: any) => i.email === 'admin@wren.test');
    expect(me).toMatchObject({ name: 'Ada Admin', mayDelete: false });

    const { responses } = await jmap([
      [
        'Email/set',
        {
          accountId: account,
          create: {
            draft: {
              mailboxIds: { drafts: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: 'admin@wren.test', name: 'Ada Admin' }],
              to: [{ name: 'Grace', email: 'grace@example.com' }],
              subject: 'Lunch?',
              textBody: [{ partId: 'body', type: 'text/plain' }],
              bodyValues: { body: { value: 'Noon at the usual place?' } },
            },
          },
        },
        'd',
      ],
      [
        'EmailSubmission/set',
        {
          accountId: account,
          create: { send: { identityId: me.id, emailId: '#draft' } },
          onSuccessUpdateEmail: { '#send': { 'mailboxIds/drafts': null, 'mailboxIds/sent': true, 'keywords/$draft': null } },
        },
        's',
      ],
    ]);
    expect(responses.map(([n, , id]) => [n, id])).toEqual([
      ['Email/set', 'd'],
      ['EmailSubmission/set', 's'],
      ['Email/set', 's'],
    ]);
    const draft = responses[0][1].created.draft;
    expect(responses[1][1].created.send).toMatchObject({ undoStatus: 'final' });
    expect(Object.keys(responses[2][1].updated)).toEqual([draft.id]);

    const [job] = await outbox('user');
    expect(job.to).toEqual(['grace@example.com']);
    expect(job.raw).toMatch(/^Subject: Lunch\?/m);
    expect(job.text).toContain('Noon at the usual place?');
    const got = await call('Email/get', { ids: [draft.id], properties: ['mailboxIds', 'keywords'] });
    expect(got.list[0]).toMatchObject({ mailboxIds: { sent: true }, keywords: { $seen: true } });

    const subs = await call('EmailSubmission/get', { ids: null });
    expect(subs.list[0]).toMatchObject({ emailId: draft.id, identityId: me.id, undoStatus: 'final' });
  });

  it('only creates drafts with Email/set', async () => {
    const res = await call('Email/set', { create: { x: { mailboxIds: { inbox: true }, subject: 'Sneaky' } } });
    expect(res.notCreated.x.type).toBe('invalidProperties');
  });

  it('keeps the vacation reply in step with Settings', async () => {
    await call('VacationResponse/set', { update: { singleton: { isEnabled: true, subject: 'Away', textBody: 'Back on Monday.' } } });
    const { list } = await call('VacationResponse/get', { ids: null });
    expect(list[0]).toMatchObject({ id: 'singleton', isEnabled: true, subject: 'Away', textBody: 'Back on Monday.' });
    expect(getPrefs(userId).vacation).toMatchObject({ enabled: true, subject: 'Away' });
    await call('VacationResponse/set', { update: { singleton: { isEnabled: false } } });
  });

  it('reports the storage quota', async () => {
    const { list } = await call('Quota/get', { ids: null });
    expect(list[0]).toMatchObject({ id: 'mail', resourceType: 'octets', scope: 'account', types: ['Email'] });
    expect(list[0].used).toBeGreaterThan(0);
  });
});

describe('blobs', () => {
  it('uploads, imports and downloads', async () => {
    const { raw } = await buildMime({ from: { address: 'linus@example.net', name: 'Linus' }, to: [{ address: 'admin@wren.test' }], subject: 'Imported from elsewhere', text: 'An old message' });
    const up = await h.app.request(`/jmap/upload/${account}/`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'message/rfc822' }, body: new Uint8Array(raw) as BodyInit });
    expect(up.status).toBe(201);
    const blob = (await up.json()) as any;
    expect(blob).toMatchObject({ accountId: account, type: 'message/rfc822', size: raw.length });

    const imported = await call('Email/import', { emails: { i: { blobId: blob.blobId, mailboxIds: { archive: true }, keywords: { $seen: true }, receivedAt: '2024-01-02T03:04:05Z' } } });
    const email = imported.created.i;
    expect(email.id).toMatch(/^M/);
    const got = (await call('Email/get', { ids: [email.id], properties: ['subject', 'mailboxIds', 'keywords', 'receivedAt', 'blobId'] })).list[0];
    expect(got).toMatchObject({ subject: 'Imported from elsewhere', mailboxIds: { archive: true }, keywords: { $seen: true }, receivedAt: '2024-01-02T03:04:05Z' });
    const twice = await call('Email/import', { emails: { i: { blobId: blob.blobId, mailboxIds: { archive: true } } } });
    expect(twice.notCreated.i).toMatchObject({ type: 'alreadyExists', existingId: email.id });

    const down = await h.app.request(`/jmap/download/${account}/${got.blobId}/old.eml?accept=message/rfc822`, { headers: auth() });
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('message/rfc822');
    expect(down.headers.get('content-disposition')).toMatch(/^attachment; filename="old.eml"/);
    expect(down.headers.get('content-security-policy')).toContain('sandbox');
    expect(await down.text()).toMatch(/^Subject: Imported from elsewhere/m);

    expect((await h.app.request(`/jmap/download/u999/${got.blobId}/old.eml`, { headers: auth() })).status).toBe(404);
    expect((await h.app.request(`/jmap/download/${account}/R1C1/x.eml`, { headers: auth() })).status).toBe(404);
  });

  it('attaches uploaded files to drafts', async () => {
    const up = await h.app.request(`/jmap/upload/${account}/`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'text/csv' }, body: 'a,b\n1,2\n' });
    const blob = (await up.json()) as any;
    const res = await call('Email/set', {
      create: {
        d: {
          mailboxIds: { drafts: true },
          subject: 'Numbers',
          to: [{ email: 'grace@example.com' }],
          textBody: [{ partId: '1', type: 'text/plain' }],
          bodyValues: { '1': { value: 'See attached' } },
          attachments: [{ blobId: blob.blobId, type: 'text/csv', name: 'numbers.csv' }],
        },
      },
    });
    const id = res.created.d.id;
    const got = (await call('Email/get', { ids: [id], properties: ['attachments', 'hasAttachment'] })).list[0];
    expect(got.hasAttachment).toBe(true);
    expect(got.attachments[0]).toMatchObject({ name: 'numbers.csv', type: 'text/csv', size: 8 });
    const file = await h.app.request(`/jmap/download/${account}/${got.attachments[0].blobId}/numbers.csv`, { headers: auth() });
    expect(await file.text()).toBe('a,b\n1,2\n');

    // Editing the draft in the web app gives it a new id and a new raw blob (JMAP emails never change).
    const state = (await call('Email/get', { ids: [] })).state;
    const raw1 = (await call('Email/get', { ids: [id], properties: ['blobId'] })).list[0].blobId;
    const dbId = Number(/^M(\d+)/.exec(id)![1]);
    const attachment = get<{ id: number }>('SELECT id FROM attachments WHERE message_id = ?', [dbId])!.id;
    h.as('admin');
    expect((await h.call('PUT', `/api/compose/drafts/${dbId}`, { to: 'grace@example.com', subject: 'Numbers, again', html: '<p>See attached</p>', attachments: [attachment] })).status).toBe(200);
    const changes = await call('Email/changes', { sinceState: state });
    expect(changes.destroyed).toEqual([id]);
    expect(changes.created).toHaveLength(1);
    const edited = changes.created[0];
    expect(edited).toMatch(new RegExp(`^M${dbId}T\\d+C\\d+V1$`));
    const now = (await call('Email/get', { ids: [id, edited], properties: ['subject', 'blobId'] }));
    expect(now.notFound).toEqual([id]);
    expect(now.list[0].subject).toBe('Numbers, again');
    expect(now.list[0].blobId).not.toBe(raw1);
    expect((await h.app.request(`/jmap/download/${account}/${raw1}/d.eml`, { headers: auth() })).status).toBe(404);
    expect(await (await h.app.request(`/jmap/download/${account}/${now.list[0].blobId}/d.eml`, { headers: auth() })).text()).toMatch(/^Subject: Numbers, again/m);

    const destroyed = await call('Email/set', { destroy: [edited] });
    expect(destroyed.destroyed).toEqual([edited]);
  });
});

// ── Push ──────────────────────────────────────────────────────────────────────

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** RFC 8291 decryption, as a push service's user agent does it. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, uaPublic: Uint8Array, authSecret: Uint8Array) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const asKey = await crypto.subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as EcdhKeyDeriveParams, ua.privateKey, 256));
  const enc = new TextEncoder();
  const join = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const ikm = await hmac(await hmac(authSecret, shared), join(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, join(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, body.slice(21 + idLen) as BufferSource));
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

describe('push', () => {
  it('only pushes to public https addresses', () => {
    expect(validPushUrl('https://push.example.com/abc')).toBe(true);
    for (const bad of ['http://push.example.com/abc', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://printer.local/x', 'https://intranet/x', 'https://u:p@push.example.com/x']) {
      expect(validPushUrl(bad)).toBe(false);
    }
  });

  it('encrypts so only the app can read it', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPayload(new TextEncoder().encode('{"hello":1}'), Buffer.from(uaPublic).toString('base64url'), Buffer.from(secret).toString('base64url'));
    expect(await decrypt(body, ua, uaPublic, secret)).toEqual({ hello: 1 });
  });

  it('verifies a subscription, then pushes state changes and new mail', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: init.body as Uint8Array });
      return new Response(null, { status: 201 });
    });

    const bad = await jmap([['PushSubscription/set', { create: { p: { deviceClientId: 'phone', url: 'https://10.0.0.1/hook' } } }, 'p']]);
    expect(bad.responses[0][1].notCreated.p.type).toBe('invalidProperties');

    const keys = { p256dh: Buffer.from(uaPublic).toString('base64url'), auth: Buffer.from(secret).toString('base64url') };
    const { responses } = await jmap([['PushSubscription/set', { create: { p: { deviceClientId: 'phone', url: 'https://push.example.com/abc', keys, types: ['Email', 'EmailDelivery'] } } }, 'p']]);
    const sub = responses[0][1].created.p;
    expect(sub.id).toMatch(/^P\d+$/);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('content-encoding')).toBe('aes128gcm');
    const verification = await decrypt(seen[0].body, ua, uaPublic, secret);
    expect(verification).toMatchObject({ '@type': 'PushVerification', pushSubscriptionId: sub.id });

    // Nothing is pushed until the app proves it got the code.
    await deliver('Unverified');
    await flushPush();
    expect(seen).toHaveLength(1);
    const wrong = await jmap([['PushSubscription/set', { update: { [sub.id]: { verificationCode: 'nope' } } }, 'v']]);
    expect(wrong.responses[0][1].notUpdated[sub.id].type).toBe('invalidProperties');
    await jmap([['PushSubscription/set', { update: { [sub.id]: { verificationCode: verification.verificationCode } } }, 'v']]);
    await flushPush();
    seen.length = 0;

    await deliver('Pushed');
    await flushPush();
    expect(seen.map((s) => s.url)).toEqual(['https://push.example.com/abc']);
    const change = await decrypt(seen[0].body, ua, uaPublic, secret);
    expect(change['@type']).toBe('StateChange');
    // Only the types the app asked for.
    expect(Object.keys(change.changed[account]).sort()).toEqual(['Email', 'EmailDelivery']);
    expect(change.changed[account].Email).toBe((await call('Email/get', { ids: [] })).state);

    // A change made by the app itself is pushed too, but isn't a delivery.
    seen.length = 0;
    const [id] = await idsIn('inbox');
    await call('Email/set', { update: { [id]: { 'keywords/$seen': true } } });
    await flushPush();
    expect(Object.keys((await decrypt(seen[0].body, ua, uaPublic, secret)).changed[account])).toEqual(['Email']);

    const list = await jmap([['PushSubscription/get', { ids: null }, 'g']]);
    expect(list.responses[0][1].list).toEqual([expect.objectContaining({ id: sub.id, deviceClientId: 'phone', url: null, keys: null })]);

    // The push service says the subscription is gone: it's dropped.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 410 }));
    await deliver('Gone');
    await flushPush();
    expect(all('SELECT id FROM jmap_push')).toEqual([]);
  });

  it('streams changes over EventSource', async () => {
    const res = await h.app.request('/jmap/eventsource?types=*&closeafter=no&ping=0', { headers: auth() });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: state\ndata: /);
    expect(JSON.parse(first.split('data: ')[1]).changed[account].Email).toBe((await call('Email/get', { ids: [] })).state);

    await deliver('Live');
    await flushPush();
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(next.split('data: ')[1]).changed[account]).toHaveProperty('EmailDelivery');
    await reader.cancel();

    // Long polling: wait for the next change, then end the response.
    const poll = await h.app.request('/jmap/eventsource?types=Email&closeafter=state&ping=0', { headers: auth() });
    await deliver('Long poll');
    await flushPush();
    const text = await poll.text();
    expect(text.match(/event: state/g)).toHaveLength(1);
    expect(Object.keys(JSON.parse(text.split('data: ')[1]).changed[account])).toEqual(['Email']);
  });
});

describe('other people’s mail', () => {
  it('stays out of reach', async () => {
    const bob = await createUser({ email: 'bob@wren.test', name: 'Bob', password: 'another long password' });
    run(`INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, 'Bob phone', 'wren_bob', ?, 'mail', ?)`, [bob, sha256('wren_bobkey'), Date.now()]);
    const bobAuth = basic('bob@wren.test', 'wren_bobkey');
    expect((await h.app.request('/jmap/session', { headers: basic('admin@wren.test', 'wren_bobkey') })).status).toBe(401);

    const mine = await idsIn('inbox');
    const req = async (methodCalls: unknown[]) =>
      (await (await h.app.request('/jmap/api', { method: 'POST', headers: { ...bobAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ using: USING, methodCalls }) })).json()) as any;
    const asAccount = await req([['Email/get', { accountId: account, ids: mine }, 'a']]);
    expect(asAccount.methodResponses[0][1].type).toBe('accountNotFound');
    const own = await req([
      ['Email/get', { accountId: `u${bob}`, ids: mine }, 'b'],
      ['Email/set', { accountId: `u${bob}`, update: { [mine[0]]: { 'keywords/$flagged': true } }, destroy: [mine[0]] }, 'c'],
    ]);
    expect(own.methodResponses[0][1]).toMatchObject({ list: [], notFound: mine });
    expect(own.methodResponses[1][1].notUpdated[mine[0]].type).toBe('notFound');
    expect(own.methodResponses[1][1].notDestroyed[mine[0]].type).toBe('notFound');

    const [blob] = (await call('Email/get', { ids: [mine[0]], properties: ['blobId'] })).list.map((e: any) => e.blobId);
    expect((await h.app.request(`/jmap/download/u${bob}/${blob}/x.eml`, { headers: bobAuth })).status).toBe(404);
    expect((await h.app.request(`/jmap/download/${account}/${blob}/x.eml`, { headers: bobAuth })).status).toBe(404);
  });
});

describe('turning it off', () => {
  it('locks mail apps out again', async () => {
    h.as('admin');
    await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': false });
    expect((await h.app.request('/jmap/session', { headers: auth() })).status).toBe(404);
    expect((await h.app.request('/.well-known/jmap')).status).toBe(404);
  });
});
