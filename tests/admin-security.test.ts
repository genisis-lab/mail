import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, now, run } from '../src/server/db/index';
import { ipInList, ipNetwork, parseCidr, parseIp, parseIpList } from '../src/server/lib/ip';
import { pruneSignIns } from '../src/server/services/sign-ins';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';
const DAY = 86_400_000;
let bo = 0;

const from = (ip: string, country?: string) => ({ 'cf-connecting-ip': ip, ...(country ? { 'cf-ipcountry': country } : {}) });
const signIn = (email: string, password: string, headers: Record<string, string>) => {
  h.as(`${email}:${Math.random()}`);
  return h.call('POST', '/api/auth/login', { email, password }, headers);
};
const history = (userId: number) =>
  all<{ ok: number; method: string; reason: string | null; ip: string; country: string | null; new_location: number }>('SELECT * FROM sign_ins WHERE user_id = ? ORDER BY id', [userId]);
const last = (userId: number) => history(userId).at(-1)!;
const admin = (method: string, path: string, body?: unknown, ip = '198.51.100.10') => {
  h.as('admin');
  return h.call(method, path, body, from(ip));
};

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW, 'admin');
  bo = (await h.call('POST', '/api/admin/users', { email: 'bo@wren.test', name: 'Bo', password: PW })).body.id;
});

describe('IP ranges', () => {
  it('parses IPv4 and IPv6 addresses and ranges', () => {
    expect(parseIp('192.0.2.1')).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp('::ffff:192.0.2.1')).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp('2001:db8::1')).toEqual({ v: 6, n: (0x20010db8n << 96n) | 1n });
    expect(parseIp('::')).toEqual({ v: 6, n: 0n });
    for (const bad of ['256.1.1.1', '1.2.3', '01.2.3.4', '2001:db8::1::2', '2001:db8:0:0:0:0:0:0:1', 'gggg::1', 'example.com', '']) expect(parseIp(bad)).toBeNull();
    for (const bad of ['10.0.0.0/33', '2001:db8::/129', '10.0.0.0/', '10.0.0.0/8/8', '10.0.0.0/-1']) expect(parseCidr(bad)).toBeNull();
    expect(parseCidr('10.1.2.3/8')).toEqual({ v: 4, bits: 8, n: 0x0a000000n });
  });

  it('matches addresses against IPv4 and IPv6 CIDRs', () => {
    const { ranges, invalid } = parseIpList('203.0.113.7, 198.51.100.0/24\n2001:db8:abcd::/48  ::ffff:192.0.2.0/120 nope');
    expect(invalid).toEqual(['nope']);
    expect(ipInList('203.0.113.7', ranges)).toBe(true);
    expect(ipInList('203.0.113.8', ranges)).toBe(false);
    expect(ipInList('198.51.100.255', ranges)).toBe(true);
    expect(ipInList('198.51.101.0', ranges)).toBe(false);
    expect(ipInList('::ffff:198.51.100.4', ranges)).toBe(true);
    expect(ipInList('192.0.2.77', ranges)).toBe(true);
    expect(ipInList('2001:db8:abcd:12::1', ranges)).toBe(true);
    expect(ipInList('2001:DB8:ABCE::1', ranges)).toBe(false);
    expect(ipInList('', ranges)).toBe(false);
    expect(ipInList('2001:db8::1', parseIpList('::/0').ranges)).toBe(true);
    expect(ipInList('2001:db8::1', parseIpList('0.0.0.0/0').ranges)).toBe(false);
  });

  it('names the /24 or /48 an address is on', () => {
    expect(ipNetwork('203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipNetwork('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipNetwork('nope')).toBe('');
  });
});

describe('sign-in history', () => {
  it('records successes and failures on existing accounts only', async () => {
    expect((await signIn('bo@wren.test', 'wrong password!', from('203.0.113.5', 'NL'))).status).toBe(401);
    expect(last(bo)).toMatchObject({ ok: 0, method: 'password', reason: 'wrong_password', ip: '203.0.113.5', country: 'NL' });
    expect((await signIn('bo@wren.test', PW, { ...from('203.0.113.5', 'NL'), 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/130.0' })).status).toBe(200);
    expect(last(bo)).toMatchObject({ ok: 1, method: 'password', reason: null, new_location: 0 });
    const before = get<{ c: number }>('SELECT COUNT(*) AS c FROM sign_ins')!.c;
    expect((await signIn('nobody@wren.test', PW, from('203.0.113.5'))).status).toBe(401);
    expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM sign_ins')!.c).toBe(before);
    // The audit log still has the unknown address.
    expect(get(`SELECT 1 FROM audit_log WHERE action = 'auth.login_failed' AND target = 'nobody@wren.test'`)).toBeTruthy();
  });

  it('flags a sign-in from a country not seen in 90 days', async () => {
    await signIn('bo@wren.test', PW, from('192.0.2.9', 'NL'));
    expect(last(bo).new_location).toBe(0); // same country, other network
    await signIn('bo@wren.test', PW, from('192.0.2.9', 'BR'));
    expect(last(bo).new_location).toBe(1);
    await signIn('bo@wren.test', PW, from('192.0.2.10', 'BR'));
    expect(last(bo).new_location).toBe(0);
    // A failure from elsewhere is never "new location", and doesn't make the place known.
    await signIn('bo@wren.test', 'wrong password!', from('192.0.2.9', 'JP'));
    expect(last(bo)).toMatchObject({ ok: 0, new_location: 0 });
    await signIn('bo@wren.test', PW, from('192.0.2.9', 'JP'));
    expect(last(bo).new_location).toBe(1);
    // Sign-ins older than 90 days don't count.
    run(`UPDATE sign_ins SET created_at = ? WHERE user_id = ? AND country = 'NL'`, [now() - 91 * DAY, bo]);
    await signIn('bo@wren.test', PW, from('203.0.113.5', 'NL'));
    expect(last(bo).new_location).toBe(1);
  });

  it('without a country, compares /24 and /48 networks', async () => {
    const cy = (await admin('POST', '/api/admin/users', { email: 'cy@wren.test', name: 'Cy', password: PW })).body.id;
    await signIn('cy@wren.test', PW, from('203.0.113.5'));
    expect(last(cy).new_location).toBe(0); // the first one sets the baseline
    await signIn('cy@wren.test', PW, from('203.0.113.200'));
    expect(last(cy).new_location).toBe(0);
    await signIn('cy@wren.test', PW, from('203.0.114.1'));
    expect(last(cy).new_location).toBe(1);
    await signIn('cy@wren.test', PW, from('2001:db8:1:2::9'));
    expect(last(cy).new_location).toBe(1);
    await signIn('cy@wren.test', PW, from('2001:db8:1:ffff::1'));
    expect(last(cy).new_location).toBe(0);
  });

  it('shows admins the history and a summary, and prunes after 90 days', async () => {
    const d = (await admin('GET', `/api/admin/users/${bo}/detail`)).body;
    expect(d.signIns[0]).toMatchObject({ ok: true, method: 'password', country: 'NL', newLocation: true });
    expect(d.signIns.some((s: any) => !s.ok && s.reason === 'wrong_password')).toBe(true);
    const o = (await admin('GET', '/api/admin/overview')).body.signIns;
    expect(o.failed24h).toBe(1); // the other one was aged out above
    expect(o.newLocation7d).toBeGreaterThanOrEqual(5);
    expect(o.users.find((u: any) => u.id === bo)).toMatchObject({ email: 'bo@wren.test', failed: 1, newLocation: 3 });
    pruneSignIns();
    expect(get(`SELECT 1 FROM sign_ins WHERE user_id = ? AND created_at < ?`, [bo, now() - 90 * DAY])).toBeUndefined();
    expect(history(bo).length).toBeGreaterThan(0);
  });
});

describe('admin IP allowlist', () => {
  it('rejects invalid entries and a list that would lock out the admin saving it', async () => {
    let r = await admin('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '198.51.100.0/24, banana' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/banana/);
    r = await admin('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '203.0.113.0/24' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'admin_ip_lockout' });
    expect(r.body.error).toContain('198.51.100.10');
    expect((await admin('GET', '/api/admin/settings')).body.settings['security.adminIpAllowlist']).toBe('');
    expect((await admin('GET', '/api/admin/settings')).body.clientIp).toBe('198.51.100.10');
  });

  it('blocks admin routes from other IPs and allows matching ones', async () => {
    const r = await admin('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '198.51.100.0/24,\n2001:db8::/32' });
    expect(r.status).toBe(200);
    expect(r.body.settings['security.adminIpAllowlist']).toBe('198.51.100.0/24\n2001:db8::/32');
    expect((await admin('GET', '/api/admin/overview', undefined, '198.51.100.77')).status).toBe(200);
    expect((await admin('GET', '/api/admin/users', undefined, '2001:db8:9::1')).status).toBe(200);
    const blocked = await admin('GET', '/api/admin/users', undefined, '203.0.113.9');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('admin_ip_blocked');
    expect((await admin('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '' }, '203.0.113.9')).status).toBe(403);
    // Mail and the person's own account still work from anywhere.
    expect((await admin('GET', '/api/mail/counters', undefined, '203.0.113.9')).status).toBe(200);
    // Clearing it lifts the restriction.
    expect((await admin('PUT', '/api/admin/settings', { 'security.adminIpAllowlist': '' })).status).toBe(200);
    expect((await admin('GET', '/api/admin/users', undefined, '203.0.113.9')).status).toBe(200);
  });
});
