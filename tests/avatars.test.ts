import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { get, run } from '../src/server/db/index';
import { collectGarbage } from '../src/server/mail/blobs';
import { sha256 } from '../src/server/lib/crypto';
import { platform, setPlatform } from '../src/server/platform';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Brand</title><rect width="10" height="10" fill="#c00"/></svg>');
const original = platform();

const upload = (data: Buffer, type = 'image/png') => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type }), 'me.png');
  return h.request('/api/account/avatar', { method: 'POST', body: form });
};
const picture = (address: string) => h.request(`/api/avatars/${encodeURIComponent(address)}`);
const dns = (records: Record<string, string[]>) => setPlatform({ ...original, dns: { ...original.dns, txt: async (name: string) => records[name] ?? [] } });

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
  await h.call('POST', '/api/admin/users', { email: 'sam@wren.test', name: 'Sam Lee', password: PW });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatform(original);
});

describe('your profile picture', () => {
  it('is uploaded, shown to others on the server, and removed', async () => {
    expect((await upload(Buffer.from('not a picture'), 'text/plain')).status).toBe(400);
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    const me = (await res.json()) as any;
    expect(me.user).toMatchObject({ hasAvatar: true });
    expect(me.user.avatarAt).toBeGreaterThan(0);

    // Sam sees it, under the address and its aliases.
    await h.login('sam@wren.test', PW);
    const seen = await picture('Admin@wren.test');
    expect(seen.status).toBe(200);
    expect(seen.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await seen.arrayBuffer()).equals(PNG)).toBe(true);

    h.as('admin@wren.test');
    expect(((await (await h.request('/api/account/avatar', { method: 'DELETE' })).json()) as any).user.hasAvatar).toBe(false);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 })); // no Gravatar either
    expect((await picture('admin@wren.test')).status).toBe(404);
  });

  it('keeps uploaded pictures through storage clean-up', async () => {
    await upload(PNG);
    await collectGarbage();
    const blob = get<{ avatar_blob: string }>(`SELECT avatar_blob FROM users WHERE email = 'admin@wren.test'`)!.avatar_blob;
    expect(get('SELECT 1 FROM blob_tombstones WHERE key = ?', [blob])).toBeUndefined();
  });
});

describe('pictures for people who write in', () => {
  it('finds a Gravatar from the server and remembers the answer', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return url.includes(sha256('maya@northwind.example')) ? new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }) : new Response(null, { status: 404 });
    });
    const res = await picture('Maya@Northwind.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(asked[0]).toBe(`https://gravatar.com/avatar/${sha256('maya@northwind.example')}?s=160&d=404`);
    await picture('maya@northwind.example');
    expect(asked).toHaveLength(1); // cached

    // Nobody there: asked once, then remembered too.
    expect((await picture('nobody@quiet.example')).status).toBe(404);
    const n = asked.length;
    expect((await picture('nobody@quiet.example')).status).toBe(404);
    expect(asked).toHaveLength(n);
  });

  it('shows a company’s BIMI logo only when its DMARC turns away forgeries', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url === 'https://brand.example/logo.svg' || url === 'https://lax.example/logo.svg' ? new Response(new Uint8Array(SVG), { headers: { 'content-type': 'image/svg+xml' } }) : new Response(null, { status: 404 }),
    );
    dns({
      '_dmarc.brand.example': ['v=DMARC1; p=reject; rua=mailto:d@brand.example'],
      'default._bimi.brand.example': ['v=BIMI1; l=https://brand.example/logo.svg; a='],
      '_dmarc.lax.example': ['v=DMARC1; p=none'],
      'default._bimi.lax.example': ['v=BIMI1; l=https://lax.example/logo.svg'],
    });
    // Any address at the company (and its subdomains) gets the logo.
    const res = await picture('billing@mail.brand.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(get<{ source: string }>(`SELECT source FROM avatar_cache WHERE key = '@mail.brand.example'`)!.source).toBe('bimi');
    // p=none: anyone could send as them, so no logo.
    expect((await picture('news@lax.example')).status).toBe(404);
  });

  it('only shows people on this server when sender pictures are off', async () => {
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked++;
      return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    });
    await h.call('PUT', '/api/account/prefs', { senderPictures: false });
    expect((await picture('someone@else.example')).status).toBe(404);
    expect(asked).toBe(0);
    await upload(PNG);
    expect((await picture('admin@wren.test')).status).toBe(200);
    await h.call('PUT', '/api/account/prefs', { senderPictures: true });
    run('DELETE FROM avatar_cache');
  });

  it('stops asking out for someone trawling through addresses', async () => {
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked++;
      return new Response(null, { status: 404 });
    });
    const me = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
    run('INSERT OR REPLACE INTO login_attempts (key, count, reset_at) VALUES (?, 600, ?)', [`avatars:${me}`, Date.now() + 3_600_000]);
    expect((await picture('random1@trawl.example')).status).toBe(404);
    expect(asked).toBe(0);
    // Pictures already known, and people here, still show.
    expect((await picture('admin@wren.test')).status).toBe(200);
    run('DELETE FROM login_attempts');
  });
});
