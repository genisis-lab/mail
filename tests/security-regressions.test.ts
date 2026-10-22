import { beforeEach, expect, it } from 'vitest';
import { harness } from './harness';
import { get, run } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { totpCode } from '../src/server/lib/crypto';
import { remoteImages } from '../src/server/services/image-proxy';

const PW = 'a very long password';
let h: ReturnType<typeof harness>;
beforeEach(async () => {
  h = harness();
  await h.setup();
  await h.login('admin@wren.test', PW, 'owner');
  await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
});

it('keeps messages readable when HTML contains invalid numeric entities', async () => {
  const { raw } = await buildMime({ from: { address: 'outsider@example.org' }, to: [{ address: 'admin@wren.test' }], subject: 'audit malformed entity', html: '<p>&#x110000; &#1114112; &#99999999999999999999999999999; &#xD800; &#0;</p><img src="https://example.org/a?x=1&#38;y=2">' });
  await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' });
  expect(remoteImages('<img src="https://example.org/a?x=1&#38;y=2">')).toEqual(['https://example.org/a?x=1&y=2']);
  const m = get<any>('SELECT id, thread_id FROM messages WHERE subject = ?', ['audit malformed entity'])!;
  expect((await h.call('GET', `/api/mail/messages/${m.id}`)).status).toBe(200);
  expect((await h.call('GET', `/api/mail/threads/${m.thread_id}`)).status).toBe(200);
});

it.each(['mfa', 'password'] as const)('enforces %s readiness for account mutations and existing send tokens', async (policy) => {
  const user = await h.call('POST', '/api/admin/users', { email: 'audit@wren.test', name: 'Audit', password: PW });
  await h.login('audit@wren.test', PW, 'audit');
  const key = await h.call('POST', '/api/account/api-keys', { name: 'before-policy', scope: 'send' });
  expect(key.status).toBe(200);
  h.as('owner');
  if (policy === 'mfa') {
    expect((await h.call('PUT', '/api/admin/settings', { 'security.require2fa': 'all' })).status).toBe(200);
  } else {
    expect((await h.call('POST', `/api/admin/users/${user.body.id}/password`, { password: PW, mustChange: true })).status).toBe(200);
    await h.login('audit@wren.test', PW, 'audit');
  }
  h.as('audit');
  const code = policy === 'mfa' ? 'mfa_setup_required' : 'password_change_required';
  expect((await h.call('GET', '/api/mail/counters')).body.code).toBe(code);
  expect((await h.call('PUT', '/api/account/prefs', { forwarding: { enabled: true, to: 'outsider@example.org', keep: 'inbox' } })).body.code).toBe(code);
  for (const scope of ['send', 'mail']) {
    expect((await h.call('POST', '/api/account/api-keys', { name: 'blocked', scope })).body.code).toBe(code);
  }
  const message = { to: [{ address: 'outsider@example.org' }], subject: 'readiness', text: 'hello' };
  const authorization = `Bearer ${key.body.key}`;
  expect((await h.call('POST', '/api/v1/send', message, { authorization })).body.code).toBe(code);
  if (policy === 'mfa') {
    const setup = await h.call('POST', '/api/account/2fa/setup');
    expect(setup.status).toBe(200);
    expect((await h.call('POST', '/api/account/2fa/enable', { code: totpCode(setup.body.secret, Math.floor(Date.now() / 30_000)) })).status).toBe(200);
  } else {
    expect((await h.call('POST', '/api/account/password/required', { next: 'a new long password' })).status).toBe(200);
  }
  expect((await h.call('GET', '/api/mail/counters')).status).toBe(200);
  expect((await h.call('POST', '/api/v1/send', message, { authorization })).status).toBe(202);
});

it('rejects forged calendar updates but applies organizer cancellations', async () => {
  const send = async (method: string, from: string, sequence: number, verdicts?: Record<string, string>) => {
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:audit-known-meeting', 'DTSTAMP:20261022T120000Z', 'DTSTART:20261025T120000Z', 'DTEND:20261025T130000Z', 'ORGANIZER;SENT-BY="mailto:outsider@example.org":mailto:organizer@example.org', 'ATTENDEE:mailto:admin@wren.test', 'SUMMARY:Legitimate meeting', `SEQUENCE:${sequence}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const { raw } = await buildMime({ from: { address: from }, to: [{ address: 'admin@wren.test' }], subject: `${method} audit meeting`, text: 'Meeting', calendar: { method, content: ics } });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing', verdicts });
  };
  const path = `/api/calendar?from=${Date.parse('2026-10-24')}&to=${Date.parse('2026-10-27')}`;
  await send('REQUEST', 'organizer@example.org', 0);
  const before = await h.call('GET', path);
  expect(before.body.events.find((e: any) => e.title === 'Legitimate meeting').invite.cancelled).toBe(false);
  await send('REQUEST', 'outsider@example.org', 98);
  const forged = get<any>("SELECT id FROM messages WHERE from_addr = 'outsider@example.org'")!;
  expect((await h.call('GET', `/api/mail/messages/${forged.id}/invite`)).body.invite.canReply).toBe(false);
  expect((await h.call('POST', `/api/mail/messages/${forged.id}/invite/reply`, { response: 'accepted' })).status).toBe(400);
  await send('CANCEL', 'outsider@example.org', 99);
  await send('CANCEL', 'organizer@example.org', 100, { dmarc: 'fail' });
  run("UPDATE messages SET folder = 'inbox' WHERE subject = 'CANCEL audit meeting'");
  const after = await h.call('GET', path);
  expect(after.body.events).toHaveLength(1);
  expect(after.body.events[0].invite.cancelled).toBe(false);
  await send('CANCEL', 'organizer@example.org', 1);
  expect((await h.call('GET', path)).body.events[0].invite.cancelled).toBe(true);
});

