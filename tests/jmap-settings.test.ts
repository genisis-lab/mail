import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { getPrefs } from '../src/server/services/users';
import { harness } from './harness';

/** Settings a mail app can change: names and signatures (Identity/set), and Wren's Preferences. */
const h = harness();
const PW = 'a very long password';
const WREN = 'https://github.com/genisis-lab/mail/jmap';
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', WREN];
let userId: number;
let account: string;
let key: string;

async function call(name: string, args: Record<string, unknown>, using = USING) {
  const res = await h.app.request('/jmap/api', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using, methodCalls: [[name, { accountId: account, ...args }, 'c']] }),
  });
  const body = (await res.json()) as any;
  return body.methodResponses[0] as [string, any, string];
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW, 'admin');
  userId = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
  account = `u${userId}`;
  await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': true });
  // An alias to send from, besides the mailbox.
  expect((await h.call('POST', '/api/admin/addresses', { address: 'hello@wren.test', kind: 'alias', userId, name: 'Hello desk' })).status).toBe(200);
  key = (await h.call('POST', '/api/account/api-keys', { name: 'Mac', scope: 'mail' })).body.key;
});

describe('Identity/set', () => {
  it('changes the mailbox’s name, as Settings → Account does', async () => {
    const [, got] = await call('Identity/get', { ids: null });
    const me = got.list.find((i: any) => i.email === 'admin@wren.test');
    expect(me.kind).toBeUndefined();
    const [, r] = await call('Identity/set', { update: { [me.id]: { name: '  Ada Lovelace ' } } });
    expect(r.updated).toEqual({ [me.id]: null });
    expect(r.newState).not.toBe(r.oldState);
    expect(get<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId])!.name).toBe('Ada Lovelace');
    expect((await h.call('GET', '/api/auth/me')).body.user.name).toBe('Ada Lovelace');
  });

  it('leaves an alias’s name to an administrator', async () => {
    const [, got] = await call('Identity/get', { ids: null });
    const alias = got.list.find((i: any) => i.email === 'hello@wren.test');
    expect(alias.name).toBe('Hello desk');
    const [, r] = await call('Identity/set', { update: { [alias.id]: { name: 'Front desk' } } });
    expect(r.notUpdated[alias.id].type).toBe('forbidden');
    // Sending the name back unchanged is fine (apps send the whole object).
    expect((await call('Identity/set', { update: { [alias.id]: { name: 'Hello desk', replyTo: null, bcc: null, email: 'hello@wren.test' } } }))[1].updated).toEqual({ [alias.id]: null });
  });

  it('sets each address’s signature, which falls back to the default one when cleared', async () => {
    await h.call('PUT', '/api/account/prefs', { signature: '<p>Default sig</p>' });
    const [, got] = await call('Identity/get', { ids: null });
    const alias = got.list.find((i: any) => i.email === 'hello@wren.test');
    expect(alias.htmlSignature).toBe('<p>Default sig</p>');

    expect((await call('Identity/set', { update: { [alias.id]: { htmlSignature: '<p><b>Hello</b> desk</p>' } } }))[1].updated).toEqual({ [alias.id]: null });
    expect(getPrefs(userId).signatures).toEqual({ 'hello@wren.test': '<p><b>Hello</b> desk</p>' });
    const after = (await call('Identity/get', { ids: [alias.id] }))[1].list[0];
    expect(after).toMatchObject({ htmlSignature: '<p><b>Hello</b> desk</p>', textSignature: 'Hello desk' });

    // Plain text is turned into HTML (and escaped).
    await call('Identity/set', { update: { [alias.id]: { textSignature: 'Hi <there>\nBye' } } });
    expect(getPrefs(userId).signatures['hello@wren.test']).toBe('<p>Hi &lt;there&gt;<br>Bye</p>');

    await call('Identity/set', { update: { [alias.id]: { htmlSignature: '' } } });
    expect(getPrefs(userId).signatures).toEqual({});
    expect((await call('Identity/get', { ids: [alias.id] }))[1].list[0].htmlSignature).toBe('<p>Default sig</p>');
  });

  it('refuses what Wren doesn’t keep, and adding or removing addresses', async () => {
    const id = (await call('Identity/get', { ids: null }))[1].list[0].id;
    const [, r] = await call('Identity/set', {
      create: { k: { email: 'new@wren.test' } },
      update: { [id]: { replyTo: [{ email: 'x@example.com' }] }, I999999: { name: 'Nobody' } },
      destroy: [id],
    });
    expect(r.notCreated.k.type).toBe('forbidden');
    expect(r.notUpdated[id]).toMatchObject({ type: 'invalidProperties', properties: ['replyTo'] });
    expect(r.notUpdated.I999999.type).toBe('notFound');
    expect(r.notDestroyed[id].type).toBe('forbidden');
    expect((await call('Identity/set', { update: { [id]: { htmlSignature: 'x'.repeat(20_001) } } }))[1].notUpdated[id].type).toBe('invalidProperties');
    expect((await call('Identity/set', { ifInState: 'nope', update: {} }))[0]).toBe('error');
  });
});

describe('Preferences', () => {
  it('shows the default From and signatures', async () => {
    const [name, r] = await call('Preferences/get', { ids: null });
    expect(name).toBe('Preferences/get');
    expect(r.list).toEqual([{ id: 'singleton', defaultFrom: '', signature: '<p>Default sig</p>', signatures: {}, signatureOnReplies: true }]);
    // Settings that guard the account aren't here.
    expect(r.list[0].forwarding).toBeUndefined();
    expect(r.list[0].signInAlerts).toBeUndefined();
  });

  it('needs the Wren capability', async () => {
    const [name, r] = await call('Preferences/get', { ids: null }, USING.slice(0, 3));
    expect([name, r.type]).toEqual(['error', 'unknownMethod']);
  });

  it('changes them, as the web app’s Settings do', async () => {
    const [, r] = await call('Preferences/set', {
      update: { singleton: { defaultFrom: 'Hello@wren.test', signature: '<p>New default</p>', signatureOnReplies: false, 'signatures/hello@wren.test': '<p>Desk</p>' } },
    });
    expect(r.updated).toEqual({ singleton: null });
    const p = getPrefs(userId);
    expect(p).toMatchObject({ defaultFrom: 'hello@wren.test', signature: '<p>New default</p>', signatureOnReplies: false, signatures: { 'hello@wren.test': '<p>Desk</p>' } });
    // The web app sees the same.
    expect((await h.call('GET', '/api/auth/me')).body.user.prefs).toMatchObject({ defaultFrom: 'hello@wren.test', signatureOnReplies: false });

    await call('Preferences/set', { update: { singleton: { 'signatures/hello@wren.test': null } } });
    expect(getPrefs(userId).signatures).toEqual({});
    await call('Preferences/set', { update: { singleton: { signatures: { 'admin@wren.test': '<p>Mine</p>', 'hello@wren.test': ' ' } } } });
    expect(getPrefs(userId).signatures).toEqual({ 'admin@wren.test': '<p>Mine</p>' });
  });

  it('takes only the person’s own addresses, and nothing that guards the account', async () => {
    const bad = async (patch: Record<string, unknown>) => (await call('Preferences/set', { update: { singleton: patch } }))[1].notUpdated?.singleton?.type;
    expect(await bad({ defaultFrom: 'someone@example.com' })).toBe('invalidProperties');
    expect(await bad({ 'signatures/someone@example.com': '<p>x</p>' })).toBe('invalidProperties');
    expect(await bad({ signatures: { 'someone@example.com': '<p>x</p>' } })).toBe('invalidProperties');
    expect(await bad({ forwarding: { enabled: true, to: 'thief@example.com' } })).toBe('invalidProperties');
    expect(await bad({ signInAlerts: false })).toBe('invalidProperties');
    expect(await bad({ signatureOnReplies: 'yes' })).toBe('invalidProperties');
    expect(getPrefs(userId).forwarding.enabled).toBe(false);
    expect(getPrefs(userId).signInAlerts).toBe(true);
    const [, r] = await call('Preferences/set', { create: { x: {} }, destroy: ['singleton'] });
    expect(r.notCreated.x.type).toBe('singleton');
    expect(r.notDestroyed.singleton.type).toBe('singleton');
  });
});
