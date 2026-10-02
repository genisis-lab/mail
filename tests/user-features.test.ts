import { beforeAll, describe, expect, it } from 'vitest';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { harness } from './harness';

const h = harness();

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  await h.call('POST', '/api/admin/users', { email: 'ivy@wren.test', name: 'Ivy', password: 'ivy password 123' });
  await h.login('ivy@wren.test', 'ivy password 123', 'ivy');
});

describe('saved replies and searches', () => {
  it('creates, edits, lists and deletes', async () => {
    h.as('ivy');
    const r = (await h.call('POST', '/api/me/saved-replies', { name: 'Thanks', html: '<p>Thanks, got it!</p>' })).body.reply;
    await h.call('PUT', `/api/me/saved-replies/${r.id}`, { name: 'Thanks!', html: '<p>Thanks, got it.</p>' });
    expect((await h.call('GET', '/api/me/saved-replies')).body.replies).toMatchObject([{ name: 'Thanks!', html: '<p>Thanks, got it.</p>' }]);
    h.as('admin');
    expect((await h.call('GET', '/api/me/saved-replies')).body.replies).toEqual([]); // private
    expect((await h.call('DELETE', `/api/me/saved-replies/${r.id}`)).status).toBe(404);

    h.as('ivy');
    await h.call('POST', '/api/me/saved-searches', { name: 'Invoices', query: 'subject:invoice has:attachment' });
    await h.call('POST', '/api/me/saved-searches', { name: 'Unread', query: 'is:unread' });
    expect((await h.call('POST', '/api/me/saved-searches', { name: 'Again', query: 'is:unread' })).status).toBe(409);
    const list = (await h.call('GET', '/api/me/saved-searches')).body.searches;
    expect(list.map((s: any) => s.name)).toEqual(['Invoices', 'Unread']);
    await h.call('PUT', `/api/me/saved-searches/${list[1].id}`, { position: 0 });
    await h.call('PUT', `/api/me/saved-searches/${list[0].id}`, { position: 1 });
    expect((await h.call('GET', '/api/me/saved-searches')).body.searches.map((s: any) => s.name)).toEqual(['Unread', 'Invoices']);
    expect((await h.call('DELETE', `/api/me/saved-searches/${list[0].id}`)).status).toBe(200);
  });
});

describe('self-service aliases and signatures', () => {
  it('follows the admin policy and limit', async () => {
    h.as('ivy');
    expect((await h.call('POST', '/api/me/aliases', { localPart: 'ivy.shop' })).status).toBe(403);
    h.as('admin');
    await h.call('PUT', '/api/admin/settings', { 'aliases.selfService': true, 'aliases.maxPerUser': 2 });
    h.as('ivy');
    const a = await h.call('POST', '/api/me/aliases', { localPart: 'Ivy.Shop' });
    expect(a.body.alias.address).toBe('ivy.shop@wren.test');
    expect((await h.call('POST', '/api/me/aliases', { localPart: 'postmaster' })).status).toBe(409);
    expect((await h.call('POST', '/api/me/aliases', { localPart: 'admin' })).status).toBe(409);
    expect((await h.call('POST', '/api/me/aliases', { localPart: 'bad..name' })).status).toBe(400);
    await h.call('POST', '/api/me/aliases', { localPart: 'ivy-news' });
    expect((await h.call('POST', '/api/me/aliases', { localPart: 'ivy-three' })).body.error).toMatch(/up to 2/);
    // The alias receives mail and can be sent from.
    const me = (await h.call('GET', '/api/auth/me')).body.user;
    expect(me.identities.map((i: any) => i.address)).toContain('ivy.shop@wren.test');
    const { raw } = await buildMime({ from: { address: 'shop@store.example' }, to: [{ address: 'ivy.shop@wren.test' }], subject: 'Your order', text: 'Shipped' });
    expect((await ingest(raw, { rcptTo: ['ivy.shop@wren.test'], source: 'cloudflare-routing' })).delivered).toBe(1);
    // Per-address signature, only for own addresses.
    const prefs = (await h.call('PUT', '/api/account/prefs', { signatures: { 'Ivy.Shop@wren.test': '<p>Ivy’s shop</p>', 'admin@wren.test': '<p>nope</p>' } })).body.prefs;
    expect(prefs.signatures).toEqual({ 'ivy.shop@wren.test': '<p>Ivy’s shop</p>' });
    const list = (await h.call('GET', '/api/me/aliases')).body;
    expect(list.policy).toMatchObject({ enabled: true, limit: 2, used: 2, domain: 'wren.test' });
    expect(list.aliases[0]).toMatchObject({ kind: 'mailbox', own: false });
    const shop = list.aliases.find((a: any) => a.address === 'ivy.shop@wren.test');
    expect(shop).toMatchObject({ kind: 'alias', own: true, enabled: true, received: 1 });
    expect((await h.call('DELETE', `/api/me/aliases/${shop.id}`)).status).toBe(200);
  });
});

describe('contacts import and export', () => {
  it('upserts without wiping details, and exports vCard and CSV', async () => {
    h.as('ivy');
    await h.call('POST', '/api/contacts', { email: 'zoe@example.org', name: 'Zoë Q', phone: '+1 555 0100' });
    const r = await h.call('POST', '/api/contacts/import', {
      contacts: [
        { email: 'ZOE@example.org', name: '', company: 'Quartz, Inc.' },
        { email: 'max@example.org', name: 'Max Power', notes: 'met at "the" conf' },
        { email: 'not-an-email', name: 'Bad' },
      ],
    });
    expect(r.body).toEqual({ added: 1, updated: 1, skipped: 1 });
    const all = (await h.call('GET', '/api/contacts?saved=1')).body.contacts;
    expect(all.find((c: any) => c.email === 'zoe@example.org')).toMatchObject({ name: 'Zoë Q', phone: '+1 555 0100', company: 'Quartz, Inc.' });
    const vcf = await h.call('GET', '/api/contacts/export?format=vcf');
    expect(vcf.headers.get('content-type')).toMatch(/text\/vcard/);
    expect(vcf.body).toContain('FN:Zoë Q\r\nEMAIL;TYPE=INTERNET:zoe@example.org\r\nTEL:+1 555 0100\r\nORG:Quartz\\, Inc.');
    const csv = await h.call('GET', '/api/contacts/export?format=csv');
    expect(csv.body).toContain('Max Power,max@example.org,,,"met at ""the"" conf"');
  });
});

describe('new-mail polling', () => {
  it('returns unread inbox mail after a given id', async () => {
    h.as('ivy');
    const start = (await h.call('GET', '/api/mail/recent')).body;
    expect(start.messages).toEqual([]);
    const { raw } = await buildMime({ from: { address: 'pat@example.org', name: 'Pat' }, to: [{ address: 'ivy@wren.test' }], subject: 'Lunch?', text: 'Noon?' });
    await ingest(raw, { rcptTo: ['ivy@wren.test'], source: 'cloudflare-routing' });
    const next = (await h.call('GET', `/api/mail/recent?after=${start.latestId}`)).body;
    expect(next.messages).toMatchObject([{ subject: 'Lunch?', from: { address: 'pat@example.org', name: 'Pat' } }]);
    expect(next.latestId).toBeGreaterThan(start.latestId);
    expect((await h.call('GET', `/api/mail/recent?after=${next.latestId}`)).body.messages).toEqual([]);
  });
});
