import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { all, get, insert, now, run } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { buildMime } from '../src/server/mail/compose';
import { platform, setPlatform } from '../src/server/platform';
import { runAlertChecks } from '../src/server/services/alerts';
import { autoCheckDomains, dnsRegressions, type DnsReport } from '../src/server/services/dns';
import { harness, outbox, processQueue } from './harness';

const h = harness();
let adminId = 0;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  adminId = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (items: any[], id: string) => items.find((i) => i.id === id);

describe('setup checklist and round-trip test', () => {
  it('reflects real state and completes after mail goes out and comes back', async () => {
    let list = (await h.call('GET', '/api/admin/checklist')).body;
    expect(item(list.items, 'domain').status).toBe('done');
    expect(item(list.items, 'provider').status).toBe('todo');
    expect(item(list.items, 'roundtrip').action).toBeUndefined(); // no provider yet
    expect(list.complete).toBe(false);

    await h.call('POST', '/api/admin/providers', { name: 'Log', type: 'log', isDefault: true, config: {} });
    list = (await h.call('GET', '/api/admin/checklist')).body;
    expect(item(list.items, 'provider').status).toBe('done');
    expect(item(list.items, 'roundtrip').action.api).toBe('/api/admin/checklist/roundtrip');

    expect((await h.call('POST', '/api/admin/checklist/roundtrip')).status).toBe(200);
    await processQueue();
    // The test leaves through the provider, not local delivery.
    const log = all<{ event: string; detail: string }>(`SELECT l.event, l.detail FROM delivery_log l JOIN outbox o ON o.id = l.outbox_id WHERE o.kind = 'test'`);
    expect(log.map((l) => l.event)).toEqual(['sent']);
    expect(item((await h.call('GET', '/api/admin/checklist')).body.items, 'roundtrip').status).toBe('pending');

    // Email Routing delivers it back.
    const [sent] = await outbox('test');
    await ingest(Buffer.from(sent.raw), { rcptTo: ['admin@wren.test'], mailFrom: 'admin@wren.test', source: 'cloudflare-routing' });
    list = (await h.call('GET', '/api/admin/checklist')).body;
    expect(item(list.items, 'roundtrip').status).toBe('done');
    expect(item(list.items, 'receive').status).toBe('done');
    expect(get<{ verified_at: number | null }>(`SELECT verified_at FROM domains WHERE name = 'wren.test'`)!.verified_at).toBeTruthy();
  });

  const latest = () => get<{ token: string; outbox_id: number; sent_at: number }>('SELECT token, outbox_id, sent_at FROM roundtrip_tests ORDER BY sent_at DESC, rowid DESC LIMIT 1')!;
  const roundtrip = async () => item((await h.call('GET', '/api/admin/checklist')).body.items, 'roundtrip');

  it('recognises a test a provider delivered without the marker header (body code)', async () => {
    await h.call('POST', '/api/admin/checklist/roundtrip');
    await processQueue();
    const { token } = latest();
    // What a header-dropping JSON API delivers: same message, no X-Wren-Roundtrip.
    const [sent] = (await outbox('test')).slice(-1);
    const parsed = await (await import('../src/server/mail/parse')).parseMail(Buffer.from(sent.raw));
    expect(parsed.text).toContain(`Delivery test code: ${token}`);
    const { raw } = await buildMime({ from: { address: 'admin@wren.test', name: 'Ada' }, to: [{ address: 'admin@wren.test' }], subject: parsed.subject, html: parsed.html ?? '' });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'resend' });
    expect(await roundtrip()).toMatchObject({ status: 'done' });
    // It doesn't clutter the inbox.
    const back = get<{ folder: string; is_read: number }>(`SELECT folder, is_read FROM messages WHERE subject = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`, [parsed.subject])!;
    expect(back).toEqual({ folder: 'archive', is_read: 1 });
  });

  it('recognises a test that came back with no marker at all, from its subject and sender', async () => {
    await h.call('POST', '/api/admin/checklist/roundtrip');
    await processQueue();
    const { raw } = await buildMime({ from: { address: 'admin@wren.test' }, to: [{ address: 'admin@wren.test' }], subject: 'Fernhill delivery test', text: 'rewritten by the provider' });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'resend' });
    expect(await roundtrip()).toMatchObject({ status: 'done' });
  });

  it('explains a failed send right away, and a test that never arrived', async () => {
    await h.call('POST', '/api/admin/checklist/roundtrip');
    const { outbox_id } = latest();
    run(`UPDATE outbox SET status = 'failed', last_error = '403 The from address domain is not verified' WHERE id = ?`, [outbox_id]);
    let r = await roundtrip();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/couldn’t be sent.*domain is not verified/);
    expect(r.action.label).toBe('Try again');

    await h.call('POST', '/api/admin/checklist/roundtrip');
    await processQueue();
    expect((await roundtrip()).status).toBe('pending');
    // Six minutes pass.
    run('UPDATE roundtrip_tests SET sent_at = sent_at - 6 * 60000');
    run('UPDATE messages SET created_at = created_at - 6 * 60000');
    run('UPDATE inbound_log SET created_at = created_at - 6 * 60000');
    r = await roundtrip();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/nothing has arrived for admin@wren.test since/);
    expect(r.action.api).toBe('/api/admin/checklist/roundtrip');
  });
});

describe('alerts', () => {
  it('raises once per problem, notifies admins in their inbox, and resolves when fixed', async () => {
    const pid = get<{ id: number }>(`SELECT id FROM providers WHERE type = 'log'`)!.id;
    for (let i = 0; i < 3; i++) insert(`INSERT INTO delivery_log (provider_id, event, recipients, detail, created_at) VALUES (?, 'deferred', 'x@example.com', 'Log: 503 busy', ?)`, [pid, now()]);
    await runAlertChecks();
    await runAlertChecks();
    let alerts = (await h.call('GET', '/api/admin/alerts')).body;
    expect(alerts.open).toHaveLength(1);
    expect(alerts.open[0]).toMatchObject({ kind: 'provider', severity: 'critical' });
    expect(alerts.open[0].detail).toMatch(/503 busy/);
    const notices = all(`SELECT subject FROM messages WHERE user_id = ? AND subject LIKE '[Alert]%'`, [adminId]);
    expect(notices).toHaveLength(1);

    insert(`INSERT INTO delivery_log (provider_id, event, recipients, detail, created_at) VALUES (?, 'sent', 'x@example.com', 'ok', ?)`, [pid, now()]);
    await runAlertChecks();
    alerts = (await h.call('GET', '/api/admin/alerts')).body;
    expect(alerts.open).toHaveLength(0);
    expect(alerts.recent[0].resolvedAt).toBeTruthy();
  });

  it('watches the queue and storage quotas', async () => {
    for (let i = 0; i < 55; i++) insert(`INSERT INTO outbox (kind, mail_from, recipients, raw_blob, status, next_attempt_at, created_at, updated_at) VALUES ('notice', 'a@wren.test', '[]', 'x', 'queued', ?, ?, ?)`, [now() - 1000, now(), now()]);
    run('UPDATE users SET quota_bytes = 1000, used_bytes = 950 WHERE id = ?', [adminId]);
    await runAlertChecks();
    const kinds = (await h.call('GET', '/api/admin/alerts')).body.open.map((a: any) => a.kind).sort();
    expect(kinds).toEqual(['queue', 'quota']);
    run(`DELETE FROM outbox WHERE raw_blob = 'x'`);
    run('UPDATE users SET quota_bytes = NULL WHERE id = ?', [adminId]);
    await runAlertChecks();
    expect((await h.call('GET', '/api/admin/alerts')).body.open).toHaveLength(0);
  });
});

describe('automatic DNS checks', () => {
  const report = (mx: string[], dkim: boolean): DnsReport => ({
    checkedAt: 0,
    verification: { ok: false, expected: '', found: [] },
    mx: { ok: mx.length > 0, records: mx.map((exchange) => ({ exchange, priority: 10 })), hint: '' },
    spf: { ok: true, record: 'v=spf1 ~all', includesProvider: null, expectedInclude: null },
    dkim: [{ selector: 'cf2024-1', found: dkim, value: null }],
    dmarc: { ok: false, record: null, policy: null },
    errors: [],
  });

  it('spots regressions', () => {
    expect(dnsRegressions(report(['route1.mx.cloudflare.net'], true), report(['route1.mx.cloudflare.net'], true))).toEqual([]);
    expect(dnsRegressions(report(['route1.mx.cloudflare.net'], true), report([], false))).toEqual(['MX records are gone, so the domain can’t receive mail', 'DKIM key cf2024-1 disappeared']);
    expect(dnsRegressions(report(['route1.mx.cloudflare.net'], false), report(['mx.other.example'], false))).toEqual(['MX no longer points to Cloudflare Email Routing']);
  });

  it('checks stale domains and alerts when MX disappears', async () => {
    const original = platform();
    let mx = [{ exchange: 'route1.mx.cloudflare.net', priority: 10 }];
    setPlatform({ ...original, dns: { txt: async () => [], cname: async () => [], mx: async () => mx } });
    try {
      run('UPDATE domains SET dns_checked_at = NULL');
      expect(await autoCheckDomains()).toBe(1);
      mx = [];
      run('UPDATE domains SET dns_checked_at = 1');
      await autoCheckDomains();
      const open = (await h.call('GET', '/api/admin/alerts')).body.open;
      expect(open.map((a: any) => a.kind)).toEqual(['dns']);
      expect(open[0].detail).toMatch(/MX records are gone/);
    } finally {
      setPlatform(original);
    }
  });
});

describe('one-click Cloudflare setup', () => {
  it('stores the token encrypted after checking it, and never returns it', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/zones?per_page=50');
      return Response.json({ success: true, result: [{ name: 'wren.test' }] });
    });
    const r = await h.call('PUT', '/api/admin/cloudflare', { apiToken: 'cf-token-0123456789abcdef', workerName: 'wren' });
    expect(r.body).toMatchObject({ configured: true, zones: ['wren.test'] });
    const stored = get<{ value: string }>(`SELECT value FROM settings WHERE key = 'cloudflare.apiToken'`)!.value;
    expect(stored).not.toContain('cf-token');
    expect((await h.call('GET', '/api/admin/settings')).body.settings['cloudflare.apiToken']).toBe('••••••••');
  });

  it('enables routing, points the catch-all at the Worker, onboards sending and creates missing DNS', async () => {
    const calls: { method: string; path: string; body?: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://api.cloudflare.com/client/v4', '');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer cf-token-0123456789abcdef');
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (path === '/zones?name=wren.test') return ok([{ id: 'z1', name: 'wren.test' }]);
      if (path === '/zones/z1/email/routing' && method === 'GET') return ok({ enabled: false });
      if (path === '/zones/z1/dns_records?type=MX&name=wren.test') return ok([]);
      if (path === '/zones/z1/email/routing/dns' && method === 'POST') return ok({ enabled: true, status: 'ready' });
      if (path === '/zones/z1/email/routing/rules/catch_all' && method === 'GET') return ok({ enabled: true, actions: [{ type: 'forward', value: ['old@example.org'] }] });
      if (path === '/zones/z1/email/routing/rules/catch_all' && method === 'PUT') return ok({});
      if (path === '/zones/z1/email/sending/subdomains' && method === 'GET') return ok([]);
      if (path === '/zones/z1/email/sending/subdomains' && method === 'POST') return ok({ tag: 't1', name: 'wren.test', enabled: true });
      if (path === '/zones/z1/email/sending/subdomains/t1/dns')
        return ok([
          { type: 'TXT', name: 'cf2024-1._domainkey.wren.test', content: 'v=DKIM1; p=abc' },
          { type: 'TXT', name: 'wren.test', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
        ]);
      if (path.startsWith('/zones/z1/dns_records?type=TXT&name=cf2024-1')) return ok([]);
      if (path.startsWith('/zones/z1/dns_records?type=TXT&name=wren.test')) return ok([{ name: 'wren.test', content: '"v=spf1 include:other.example ~all"' }]);
      if (path === '/zones/z1/dns_records' && method === 'POST') return ok({ id: 'r1' });
      return Response.json({ success: false, errors: [{ code: 7003, message: `unexpected ${method} ${path}` }] }, { status: 404 });
    });
    const domainId = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!.id;
    const r = await h.call('POST', `/api/admin/domains/${domainId}/cloudflare-setup`, { sending: true });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.steps.map((s: any) => [s.id, s]));
    expect(byId.zone.status).toBe('done');
    expect(byId.routing.status).toBe('done');
    expect(byId.catchall).toMatchObject({ status: 'done' });
    expect(byId.catchall.detail).toMatch(/previously did: forward old@example.org/);
    expect(byId.sending.status).toBe('done');
    expect(byId.dns.status).toBe('warn'); // SPF has to be merged by hand
    expect(byId.dns.detail).toMatch(/Created TXT cf2024-1._domainkey.wren.test/);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ actions: [{ type: 'worker', value: ['wren'] }], matchers: [{ type: 'all' }], enabled: true, name: 'Send everything to Wren' });
    const created = calls.filter((c) => c.method === 'POST' && c.path === '/zones/z1/dns_records');
    expect(created.map((c) => c.body.name)).toEqual(['cf2024-1._domainkey.wren.test']);
  });

  it('leaves a domain that receives mail elsewhere alone unless the switch is confirmed', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://api.cloudflare.com/client/v4', '');
      const method = init.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (path === '/zones?name=wren.test') return ok([{ id: 'z1', name: 'wren.test' }]);
      if (path === '/zones/z1/email/routing') return ok({ enabled: false });
      if (path === '/zones/z1/dns_records?type=MX&name=wren.test') return ok([{ type: 'MX', name: 'wren.test', content: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }]);
      if (path === '/zones/z1/email/routing/dns' && method === 'POST') return ok({ enabled: true });
      if (path === '/zones/z1/email/routing/rules/catch_all' && method === 'GET') return ok({ enabled: false });
      if (path === '/zones/z1/email/routing/rules/catch_all' && method === 'PUT') return ok({});
      return Response.json({ success: false, errors: [{ code: 7003, message: `unexpected ${method} ${path}` }] }, { status: 404 });
    });
    const domainId = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!.id;
    const r = await h.call('POST', `/api/admin/domains/${domainId}/cloudflare-setup`, { sending: false });
    expect(r.body.steps.map((s: any) => [s.id, s.status])).toEqual([
      ['zone', 'done'],
      ['routing', 'failed'],
    ]);
    expect(r.body.steps[1].detail).toMatch(/receives mail through inbound-smtp.us-east-1.amazonaws.com today.*Nothing was changed/);
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);

    const confirmed = await h.call('POST', `/api/admin/domains/${domainId}/cloudflare-setup`, { sending: false, replaceMx: true });
    expect(confirmed.body.steps.find((s: any) => s.id === 'routing').status).toBe('done');
    expect(calls).toContain('PUT /zones/z1/email/routing/rules/catch_all');
  });

  it('explains a domain that is not on the account', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true, result: [] }));
    const domainId = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!.id;
    const r = await h.call('POST', `/api/admin/domains/${domainId}/cloudflare-setup`, { sending: false });
    expect(r.body.steps).toEqual([expect.objectContaining({ id: 'zone', status: 'failed' })]);
  });
});

describe('delivery logs', () => {
  it('filters, shows detail with headers and a timeline, and retries', async () => {
    const { raw } = await buildMime({ from: { address: 'admin@wren.test' }, to: [{ address: 'bob@elsewhere.example' }], subject: 'Quarterly numbers', html: '<p>secret body</p>' });
    const blob = await (await import('../src/server/mail/blobs')).putBlob(raw);
    const job = insert(`INSERT INTO outbox (kind, user_id, mail_from, recipients, raw_blob, subject, status, attempts, last_error, next_attempt_at, created_at, updated_at)
      VALUES ('user', ?, 'admin@wren.test', '["bob@elsewhere.example"]', ?, 'Quarterly numbers', 'failed', 3, '550 no such user', ?, ?, ?)`, [adminId, blob, now(), now(), now()]);
    insert(`INSERT INTO delivery_log (user_id, outbox_id, event, recipients, detail, created_at) VALUES (?, ?, 'deferred', 'bob@elsewhere.example', 'try later', ?)`, [adminId, job, now()]);
    const failed = insert(`INSERT INTO delivery_log (user_id, outbox_id, event, recipients, detail, created_at) VALUES (?, ?, 'failed', 'bob@elsewhere.example', '550 no such user', ?)`, [adminId, job, now()]);

    const problems = (await h.call('GET', '/api/admin/delivery-log?event=problems&q=quarterly')).body.items;
    expect(problems.map((i: any) => i.id)).toEqual([failed, failed - 1]);
    expect((await h.call('GET', '/api/admin/delivery-log?q=nothing-matches')).body.items).toEqual([]);

    const detail = (await h.call('GET', `/api/admin/delivery-log/${failed}`)).body;
    expect(detail.job).toMatchObject({ status: 'failed', attempts: 3, canRetry: true, lastError: '550 no such user' });
    expect(detail.timeline.map((t: any) => t.event)).toEqual(['deferred', 'failed']);
    expect(detail.headers).toMatch(/^Message-ID: /m);
    expect(detail.headers).not.toMatch(/secret body/);

    expect((await h.call('POST', `/api/admin/delivery-log/${failed}/retry`)).status).toBe(200);
    expect(get<{ status: string }>('SELECT status FROM outbox WHERE id = ?', [job])!.status).toBe('queued');
  });

  it('filters the inbound log', async () => {
    const { raw } = await buildMime({ from: { address: 'carol@example.org' }, to: [{ address: 'ghost@wren.test' }], subject: 'Hello?', text: 'x' });
    await ingest(raw, { rcptTo: ['ghost@wren.test'], source: 'cloudflare-routing' });
    const rejected = (await h.call('GET', '/api/admin/inbound-log?status=problems&domain=wren.test')).body.items;
    expect(rejected[0]).toMatchObject({ rcpt_to: 'ghost@wren.test', status: 'rejected' });
    expect((await h.call('GET', `/api/admin/inbound-log/${rejected[0].id}`)).body.entry.reason).toMatch(/no such mailbox/);
  });
});

describe('DNS guidance follows the sending provider', () => {
  it('shows Resend’s records, not Cloudflare’s, and checks SPF where Resend puts it', async () => {
    const pid = insert(`INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES ('Resend', 'resend', '{}', 1, 0, 'tok-dns-test', ?)`, [now()]);
    const domainId = get<{ id: number }>(`SELECT id FROM domains WHERE name = 'wren.test'`)!.id;
    run('UPDATE domains SET provider_id = ? WHERE id = ?', [pid, domainId]);
    const original = platform();
    setPlatform({
      ...original,
      dns: {
        txt: async (name: string) => (name === 'send.wren.test' ? ['v=spf1 include:amazonses.com ~all'] : name === 'resend._domainkey.wren.test' ? ['p=MIGf'] : []),
        cname: async () => [],
        mx: async () => [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }],
      },
    });
    try {
      const records = (await h.call('GET', `/api/admin/domains/${domainId}`)).body.records;
      const by = (type: string, host: string) => records.find((r: any) => r.type === type && r.host === host);
      expect(by('MX', 'wren.test').value).toBe('(the MX record Resend shows)');
      expect(by('MX', 'send.wren.test').value).toMatch(/^\(feedback-smtp/);
      expect(by('TXT', 'send.wren.test').value).toBe('v=spf1 include:amazonses.com ~all');
      expect(by('TXT', 'resend._domainkey.wren.test').value).toBe('(copy the DKIM value from Resend)');
      expect(records.some((r: any) => r.value === 'v=spf1 ~all' || r.value.includes('cloudflare.net'))).toBe(false);
      await h.call('POST', `/api/admin/domains/${domainId}/check`);
      const dns = (await h.call('GET', `/api/admin/domains/${domainId}`)).body.domain.dns;
      expect(dns.spf).toMatchObject({ ok: true, includesProvider: true, host: 'send.wren.test' });
      expect(dns.dkim).toEqual([{ selector: 'resend', found: true, value: 'p=MIGf' }]);
    } finally {
      setPlatform(original);
      run('UPDATE domains SET provider_id = NULL WHERE id = ?', [domainId]);
      run('DELETE FROM providers WHERE id = ?', [pid]);
    }
  });
});

describe('system email sender', () => {
  const lastNotice = async () => (await outbox('notice')).at(-1)!;
  const header = (raw: string, name: string) => new RegExp(`^${name}: (.+)$`, 'mi').exec(raw)?.[1]?.trim();

  it('defaults to no-reply@ and can be set to another hosted address, name and reply-to', async () => {
    await h.call('POST', '/api/admin/invites', { sendTo: 'friend@example.org', days: 7 });
    let raw = (await lastNotice()).raw;
    expect(header(raw, 'From')).toBe('Fernhill <no-reply@wren.test>');
    expect(header(raw, 'Reply-To')).toBeUndefined();

    expect((await h.call('PUT', '/api/admin/settings', { 'mail.systemFrom': 'contact@elsewhere.example' })).body.error).toMatch(/isn’t a domain hosted here/);
    expect((await h.call('PUT', '/api/admin/settings', { 'mail.systemName': 'Bad\r\nBcc: x' })).status).toBe(400);
    const saved = await h.call('PUT', '/api/admin/settings', { 'mail.systemFrom': ' Contact@Wren.test ', 'mail.systemName': 'No reply', 'mail.systemReplyTo': 'contact@wren.test' });
    expect(saved.status).toBe(200);
    expect((await h.call('GET', '/api/admin/settings')).body.systemSender).toEqual({ address: 'contact@wren.test', name: 'No reply' });

    await h.call('POST', '/api/admin/invites', { sendTo: 'friend2@example.org', days: 7 });
    raw = (await lastNotice()).raw;
    expect(header(raw, 'From')).toBe('No reply <contact@wren.test>');
    expect(header(raw, 'Reply-To')).toBe('contact@wren.test');

    // Back to automatic.
    await h.call('PUT', '/api/admin/settings', { 'mail.systemFrom': '', 'mail.systemName': '', 'mail.systemReplyTo': '' });
    expect((await h.call('GET', '/api/admin/settings')).body.systemSender).toEqual({ address: 'no-reply@wren.test', name: 'Fernhill' });
  });
});
