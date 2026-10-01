import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db/index';
import { nodeSqlDriver } from './sqlite';
import { withDurableObjectLimits } from './do-limits';
import { invalidateSettings } from '../src/server/settings';
import { createApp } from '../src/server/app';
import '../src/server/mail/ingest';

const app = createApp();
let cookie = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Wren': '1', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set && set.includes('wren_sid=')) cookie = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(() => {
  openDb(withDurableObjectLimits(nodeSqlDriver(':memory:')));
  invalidateSettings();
});

describe('HTTP API', () => {
  it('runs first-time setup once', async () => {
    const info = (await call('GET', '/api/setup')).body;
    expect(info).toEqual({ needed: true, cloudflareEmail: false });
    const base = { instanceName: 'Test Mail', domain: 'wren.test', localPart: 'admin', name: 'Admin', password: 'a very long password' };
    // No send_email binding in this environment, and Resend needs a key.
    expect((await call('POST', '/api/setup', { ...base, email: { provider: 'cloudflare' } })).body.error).toMatch(/no Cloudflare email binding/);
    expect((await call('POST', '/api/setup', { ...base, email: { provider: 'resend' } })).body.error).toMatch(/Resend API key/);
    const r = await call('POST', '/api/setup', { ...base, email: { provider: 'resend', apiKey: 're_test_123' } });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('owner');
    const providers = (await call('GET', '/api/admin/providers')).body.providers;
    expect(providers).toMatchObject([{ type: 'resend', name: 'Resend', isDefault: true }]);
    const detail = (await call('GET', `/api/admin/providers/${providers[0].id}`)).body.provider;
    expect(detail.config.apiKey).toBe('••••••••'); // stored encrypted, never sent back
    expect((await call('POST', '/api/setup', { instanceName: 'x', domain: 'x.test', localPart: 'a', name: 'a', password: 'a very long password' })).status).toBe(403);
  });

  it('rejects mutating requests without the CSRF header', async () => {
    const res = await app.request('/api/labels', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(403);
  });

  it('requires auth and admin role', async () => {
    const saved = cookie;
    cookie = '';
    expect((await call('GET', '/api/mail/threads')).status).toBe(401);
    cookie = saved;
    expect((await call('GET', '/api/mail/threads')).status).toBe(200);
    await call('POST', '/api/admin/users', { email: 'u@wren.test', name: 'U', password: 'user password 12' });
    await call('POST', '/api/auth/logout');
    cookie = '';
    expect((await call('POST', '/api/auth/login', { email: 'u@wren.test', password: 'wrong password' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { email: 'u@wren.test', password: 'user password 12' })).status).toBe(200);
    expect((await call('GET', '/api/admin/overview')).status).toBe(403);
    await call('POST', '/api/auth/logout');
    cookie = '';
    await call('POST', '/api/auth/login', { email: 'admin@wren.test', password: 'a very long password' });
    expect((await call('GET', '/api/admin/overview')).status).toBe(200);
  });

  it('accepts inbound mail through a provider webhook', async () => {
    const p = await call('POST', '/api/admin/providers', { name: 'Pipe', type: 'raw', config: {} });
    expect(p.status).toBe(200);
    const list = await call('GET', '/api/admin/providers');
    const url = new URL(list.body.providers.find((x: { id: number }) => x.id === p.body.id).inboundUrl);
    const raw = 'From: Carol <carol@example.org>\r\nTo: u@wren.test\r\nSubject: Webhook test\r\nMessage-ID: <wh1@example.org>\r\n\r\nHello!\r\n';
    const res = await app.request(url.pathname, { method: 'POST', headers: { 'Content-Type': 'message/rfc822', 'X-Rcpt-To': 'u@wren.test' }, body: raw });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: ['u@wren.test'], delivered: 1 });
    const bad = await app.request('/api/inbound/not-a-token', { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: raw });
    expect(bad.status).toBe(404);
  });

  it('masks provider secrets', async () => {
    const created = await call('POST', '/api/admin/providers', { name: 'Resend', type: 'resend', config: { apiKey: 're_secret_value' } });
    const one = await call('GET', `/api/admin/providers/${created.body.id}`);
    expect(one.body.provider.config.apiKey).toBe('••••••••');
    // Saving the mask keeps the old secret.
    expect((await call('PUT', `/api/admin/providers/${created.body.id}`, { config: { apiKey: '••••••••' } })).status).toBe(200);
  });

  it('sends with an API key over the public API', async () => {
    const key = await call('POST', '/api/account/api-keys', { name: 'script' });
    const saved = cookie;
    cookie = '';
    const res = await app.request('/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.body.key}` },
      body: JSON.stringify({ to: 'u@wren.test', subject: 'From API', text: 'hi' }),
    });
    expect(res.status).toBe(202);
    cookie = saved;
  });
});
