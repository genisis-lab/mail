import { expect, it } from 'vitest';
import { harness } from './harness';

it('a fresh tab authenticates from cookies alone and never caches signed-out state', async () => {
  const h = harness();
  await h.setup();
  const before = await h.app.request('/api/auth/me');
  expect((await before.json()).user).toBeNull();
  expect(before.headers.get('cache-control')).toContain('no-store');
  const login = await h.call('POST', '/api/auth/login', { email: 'admin@wren.test', password: 'a very long password' });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect(cookie).toContain('wren_sid=');
  const fresh = await h.app.request('/api/auth/me', { headers: { Cookie: cookie } });
  const me = await fresh.json();
  expect(me.user.email).toBe('admin@wren.test');
  expect(fresh.headers.get('cache-control')).toContain('no-store');
  expect(fresh.headers.get('vary')).toContain('Cookie');
  const named = await h.app.request('/api/auth/me', { headers: { Cookie: cookie, 'X-Wren-Account': String(me.user.id) } });
  expect((await named.json()).user.id).toBe(me.user.id);
  // A private tab with a separate cookie jar cannot inherit another session.
  expect((await (await h.app.request('/api/auth/me')).json()).user).toBeNull();
});
