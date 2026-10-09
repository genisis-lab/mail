import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { config } from '../src/server/config';
import { ingest } from '../src/server/mail/ingest';
import { imageKey, remoteImages, serveImage, signImage, signedImages } from '../src/server/services/image-proxy';
import { harness } from './harness';

const h = harness();
const UPS = '1ZA0T5770319884736';
let n = 0;
const receive = (opts: { from: string; subject: string; text?: string; html?: string; headers?: string[]; date?: number }) => {
  const id = `<x${++n}.${Date.now()}@ext.example>`;
  const body = opts.html ? ['Content-Type: text/html; charset=utf-8', '', opts.html] : ['Content-Type: text/plain; charset=utf-8', '', opts.text ?? 'Hello'];
  const raw = [`From: ${opts.from}`, 'To: Ada Admin <admin@wren.test>', `Subject: ${opts.subject}`, `Message-ID: ${id}`, ...(opts.headers ?? []), `Date: ${new Date(opts.date ?? Date.now() - 3600_000 + n * 1000).toUTCString()}`, 'MIME-Version: 1.0', ...body, ''].join('\r\n');
  return ingest(Buffer.from(raw), { rcptTo: ['admin@wren.test'], source: 'resend' }).then(() => get<any>('SELECT * FROM messages WHERE message_id = ?', [id.slice(1, -1)])!);
};

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password');
});
afterEach(() => {
  config.imageProxy = true;
});

describe('image proxy', () => {
  const key = imageKey('a test secret that is long enough');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const req = (url: string, sig = signImage(url, key)) => new Request(`https://mail.example/api/img/${sig}?u=${encodeURIComponent(url)}`);
  const upstream = (body: BodyInit, headers: Record<string, string>, status = 200) => async () => new Response(body, { status, headers });

  it('finds the remote pictures in an email', () => {
    const html = `<img src="https://images.shopcdn.com/a.png?x=1&amp;y=2"><td background='//images.shopcdn.com/bg.jpg'>
      <div style="background-image: url(&quot;https://images.shopcdn.com/c.gif&quot;)"></div><img src="cid:logo"><img src="data:image/png;base64,AAA">`;
    expect(remoteImages(html).sort()).toEqual(['https://images.shopcdn.com/a.png?x=1&y=2', 'https://images.shopcdn.com/bg.jpg', 'https://images.shopcdn.com/c.gif']);
  });

  it('passes on a picture Wren signed, with headers that keep it inert', async () => {
    const res = await serveImage(req('https://images.shopcdn.com/a.png'), key, { fetch: upstream(png, { 'Content-Type': 'image/png' }) as typeof fetch });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('refuses anything else: unsigned, private addresses, non-pictures, errors, huge files', async () => {
    const fetchPng = upstream(png, { 'Content-Type': 'image/png' }) as typeof fetch;
    expect((await serveImage(req('https://images.shopcdn.com/a.png', 'x'.repeat(22)), key, { fetch: fetchPng })).status).toBe(403);
    expect((await serveImage(req('https://images.shopcdn.com/b.png', signImage('https://images.shopcdn.com/a.png', key)), key, { fetch: fetchPng })).status).toBe(403);
    expect((await serveImage(req('http://localhost:8080/a.png'), key, { fetch: fetchPng })).status).toBe(400);
    expect((await serveImage(req('http://192.168.1.1/a.png'), key, { fetch: fetchPng })).status).toBe(400);
    expect((await serveImage(req('https://images.shopcdn.com/page'), key, { fetch: upstream('<html>', { 'Content-Type': 'text/html' }) as typeof fetch })).status).toBe(415);
    expect((await serveImage(req('https://images.shopcdn.com/gone.png'), key, { fetch: upstream('', { 'Content-Type': 'image/png' }, 404) as typeof fetch })).status).toBe(502);
    expect((await serveImage(req('https://images.shopcdn.com/huge.png'), key, { fetch: upstream(png, { 'Content-Type': 'image/png', 'Content-Length': String(50 * 1024 * 1024) }) as typeof fetch })).status).toBe(413);
    expect((await serveImage(new Request(req('https://images.shopcdn.com/a.png').url, { method: 'POST' }), key, { fetch: fetchPng })).status).toBe(405);
  });

  it('answers from the edge cache the second time', async () => {
    const store = new Map<string, Response>();
    const cache = { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => void store.set(r.url, res) } as unknown as Cache;
    let calls = 0;
    const fetchOnce = (async () => (calls++, new Response(png, { headers: { 'Content-Type': 'image/png' } }))) as typeof fetch;
    await serveImage(req('https://images.shopcdn.com/a.png'), key, { fetch: fetchOnce, cache });
    const again = await serveImage(req('https://images.shopcdn.com/a.png'), key, { fetch: fetchOnce, cache });
    expect(calls).toBe(1);
    expect(again.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(png);
  });

  it('signs the pictures of the messages it shows, unless self-hosted', async () => {
    const m = await receive({ from: 'News <news@shop.example>', subject: 'Pictures', html: '<p>Hi</p><img src="https://images.shopcdn.com/hero.jpg">' });
    const msg = (await h.call('GET', `/api/mail/threads/${m.thread_id}`)).body.messages[0];
    expect(msg.images).toEqual({ 'https://images.shopcdn.com/hero.jpg': expect.any(String) });
    expect(signedImages('<img src="https://images.shopcdn.com/hero.jpg">')).toEqual(msg.images);
    config.imageProxy = false;
    expect((await h.call('GET', `/api/mail/threads/${m.thread_id}`)).body.messages[0].images).toBeUndefined();
  });
});

describe('packages page, notifications and search', () => {
  it('lists each package once, with its conversation', async () => {
    const t0 = Date.now() - 3 * 86_400_000;
    await receive({ from: "Macy's <CustomerService@oes.macys.com>", subject: 'Your order has shipped', text: `Order Number: 4795458681\nTracking number: ${UPS}`, date: t0 });
    const delivered = await receive({ from: 'UPS <mcinfo@ups.com>', subject: 'Your package was delivered', text: `Tracking number ${UPS}. Delivered.`, date: t0 + 86_400_000 });
    const amazon = await receive({ from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Out for delivery: "Echo Dot"', text: 'Order # 112-1234567-1234567. Track your package: TBA123456789012' });
    // An order confirmation from a shop Wren doesn't know is waiting for its shipping email: not a package yet.
    await receive({ from: 'Fern & Clay <store+111@t.shopifyemail.com>', subject: 'Order #1001 confirmed', text: 'Thank you for your purchase! Order #1001. Shipping: Standard' });

    const { packages } = (await h.call('GET', '/api/mail/packages')).body;
    expect(packages).toHaveLength(2);
    expect(packages.find((p: any) => p.merchant === 'Macy’s')).toMatchObject({ status: 'delivered', tracking: UPS, emails: 2, threadId: delivered.thread_id });
    expect(packages.find((p: any) => p.merchant === 'Amazon')).toMatchObject({ status: 'out_for_delivery', threadId: amazon.thread_id });

    // The notification leads with where the package is.
    const items = (await h.call('GET', '/api/me/notifications')).body.items;
    expect(items.find((i: any) => i.id === amazon.id).parcel).toEqual({ status: 'out_for_delivery', merchant: 'Amazon', item: 'Echo Dot' });
    // An order confirmation still waiting for its shipping email is ordinary mail.
    expect(items.find((i: any) => i.subject === 'Order #1001 confirmed').parcel).toBeNull();

    // has:package finds shipping mail, -has:package the rest.
    const search = async (q: string) => ((await h.call('GET', `/api/mail/threads?q=${encodeURIComponent(q)}`)).body.threads as any[]).map((t) => t.subject);
    expect((await search('has:package')).sort()).toEqual(['Out for delivery: "Echo Dot"', 'Your order has shipped', 'Your package was delivered']);
    expect(await search('-has:package')).toContain('Pictures');
    expect(await search('-has:package')).toContain('Order #1001 confirmed');
  });
});

describe('manage subscriptions', () => {
  it('lists list mail by sender, busiest first, and shows who you unsubscribed from', async () => {
    const list = (from: string, subject: string) =>
      receive({ from, subject, text: 'Read online', headers: ['List-Unsubscribe: <mailto:leave@lists.example?subject=unsubscribe>', 'List-Id: <weekly.lists.example>'] });
    await list('Weekly Deals <deals@shop.example>', 'Deals 1');
    await list('Weekly Deals <deals@shop.example>', 'Deals 2');
    const last = await list('Weekly Deals <Deals@shop.example>', 'Deals 3');
    await list('Book Club <club@books.example>', 'This month');
    await receive({ from: 'Kim <kim@friend.example>', subject: 'Lunch?' });

    let subs = (await h.call('GET', '/api/mail/subscriptions')).body.subscriptions;
    expect(subs.map((s: any) => [s.sender, s.recent])).toEqual([
      ['deals@shop.example', 3],
      ['club@books.example', 1],
    ]);
    expect(subs[0]).toMatchObject({ name: 'Weekly Deals', messageId: last.id, unsubscribedAt: null });

    expect((await h.call('POST', `/api/mail/messages/${last.id}/unsubscribe`)).body).toMatchObject({ method: 'email', sender: 'deals@shop.example' });
    subs = (await h.call('GET', '/api/mail/subscriptions')).body.subscriptions;
    expect(subs[0].unsubscribedAt).toBeGreaterThan(0);
  });
});

describe('push notifications', () => {
  /** Run the service worker's push handler against a canned /api/me/notifications answer. */
  const push = async (data: unknown) => {
    const handlers: Record<string, (e: any) => void> = {};
    const shown: { title: string; options: any }[] = [];
    const context = vm.createContext({
      self: {
        addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn),
        registration: { showNotification: async (title: string, options: any) => void shown.push({ title, options }) },
        navigator: {},
        location: { origin: 'https://mail.example' },
      },
      fetch: async () => new Response(JSON.stringify(data)),
      caches: { open: async () => ({}) },
      URL,
      Response,
    });
    vm.runInContext(readFileSync(new URL('../src/web/public/sw.js', import.meta.url), 'utf8'), context);
    let done: Promise<unknown> = Promise.resolve();
    handlers.push({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return shown[0];
  };
  const item = { id: 9, threadId: 4, mailbox: null, from: { address: 'shipment-tracking@amazon.com', name: 'Amazon.com' }, subject: 'Out for delivery: "Echo Dot"', code: null };

  it('leads with where the package is', async () => {
    const n = await push({ total: 1, items: [{ ...item, parcel: { status: 'out_for_delivery', merchant: 'Amazon', item: 'Echo Dot' } }] });
    expect(n.title).toBe('Out for delivery · Amazon');
    expect(n.options.body).toBe('Echo Dot');
    expect(n.options.data.url).toBe('/inbox/4');
  });

  it('keeps ordinary mail as it was', async () => {
    const n = await push({ total: 1, items: [{ ...item, parcel: null }] });
    expect(n.title).toBe('Amazon.com');
  });
});
