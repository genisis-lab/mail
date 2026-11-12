import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { harness } from './harness';

let render: typeof import('../src/web/lib/sanitize').renderMailHtml;
let draftInit: typeof import('../src/web/components/Compose').draftInit;
const dom = new JSDOM('', { url: 'https://mail.example' });
beforeAll(async () => {
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  render = (await import('../src/web/lib/sanitize')).renderMailHtml;
  draftInit = (await import('../src/web/components/Compose')).draftInit;
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

describe('tracker handling in rendered HTML', () => {
  const tracker = 'https://example.list-manage.com/track/open?u=recipient';
  it.each([true, false])('removes known trackers from every background when images are allowed=%s', (allowRemote) => {
    const result = render(`<img src="${tracker}"><table background="${tracker}"><tr><td style="background-image:url('${tracker}')">hello</td></tr></table><style>.mail { background: url(${tracker}); }</style>`, { attachments: [], allowRemote });
    expect(result.trackers).toBe(4);
    expect(result.html).not.toContain('list-manage');
    expect(result.html).toContain('hello');
  });

  it('checks CSS escapes before URL matching and removes external stylesheets', () => {
    const result = render(String.raw`<style>@im\70ort "https://remote.example/style.css"; .mail { background: u\72l("https://example.list-manage.com/track/\6f pen?u=recipient"); }</style>`, { attachments: [], allowRemote: true });
    expect(result.trackers).toBe(1);
    expect(result.html).not.toContain('list-manage');
    expect(result.html).not.toContain('remote.example');
  });

  it('preserves ordinary backgrounds, proxies signed images, and blocks them when images are off', () => {
    const url = 'https://images.example/banner.png';
    const html = `<style>.banner { background: url('${url}'); }</style><table background="${url}"><tr><td style="background:url(${url})">banner</td></tr></table>`;
    const allowed = render(html, { attachments: [], allowRemote: true, proxy: { [url]: 'signature' } });
    expect(allowed.trackers).toBe(0);
    expect(allowed.html.match(/\/api\/img\/signature/g)).toHaveLength(3);
    const blocked = render(html, { attachments: [], allowRemote: false });
    expect(blocked.blockedImages).toBe(3);
    expect(blocked.html).not.toContain('images.example');
  });

  it.each([
    ['a style sheet inside an svg', '<svg><style>rect{fill:url(https://t.example/p.png)} @import url(https://t.example/a.css);</style><rect width="10" height="10"/></svg>'],
    ['a url() left open at the end of a style attribute', '<div style="background:url(https://t.example/p.png">x</div>'],
    ['a quoted url() left open', '<div style="background:url(&quot;https://t.example/p.png">x</div>'],
    ['a url() left open at the end of a style sheet', '<style>p{background:url(https://t.example/p.png</style><p>x</p>'],
    ['a bare string in image-set()', `<div style="background-image:image-set('https://t.example/p.png' 1x)">x</div>`],
    ['a string left open in image-set()', '<div style="background-image:image-set(&quot;https://t.example/p.png">x</div>'],
    ['an svg paint server in another file', '<svg><rect fill="url(https://t.example/p.svg#a)" width="10" height="10"/></svg>'],
    ['an apostrophe in a comment before the url()', `<style>/* don't */ p{background:url(https://t.example/p.png)}</style><p>x</p>`],
    ['a string cut short by the end of its line', `<style>p{font-family:'x\n}\ndiv{background:url(https://t.example/p.png)} q{font-family:'y'}</style><p>x</p>`],
    ['a comment spelled with escapes that hides a quote', String.raw`<div style="background:\2f\2a &quot; */ url(https://t.example/p.png) &quot;">x</div>`],
    ['an obsolete MathML picture', '<math><mglyph src="https://t.example/p.png"/></math>'],
  ])('blocks remote content in %s', (_name, html) => {
    const blocked = render(html, { attachments: [], allowRemote: false });
    expect(blocked.html).not.toContain('t.example');
  });

  it('leaves no escape for the browser to decode into url(', () => {
    // "ur\\6c(" is an escaped backslash to us, and must not be "ur" + "\6c" (an l) to the browser.
    const { html } = render(String.raw`<div style="background:ur\\6c(https://t.example/p.png)">x</div>`, { attachments: [], allowRemote: false });
    expect(html).not.toMatch(/ur\\6c\(/i);
    expect(html).toContain(String.raw`ur\5c 6c(`);
  });

  it('keeps ordinary strings, local svg references and allowed pictures', () => {
    const kept = render(`<style>p{font-family:"Helvetica Neue",Arial}</style><p style="font-family:'Segoe UI'">x</p><svg><rect fill="url(#g)"/></svg>`, { attachments: [], allowRemote: false });
    expect(kept.blockedImages).toBe(0);
    expect(kept.html).toContain('"Helvetica Neue"');
    expect(kept.html).toContain(`'Segoe UI'`);
    expect(kept.html).toContain('#g');
    const url = 'https://images.example/banner.png';
    const allowed = render(`<div style="background-image:image-set('${url}' 1x)">x</div><div style="background:url(${url}">y</div>`, { attachments: [], allowRemote: true, proxy: { [url]: 'signature' } });
    expect(allowed.html.match(/\/api\/img\/signature/g)).toHaveLength(2);
  });

  it('cleans links inside an svg like any other', () => {
    const { html } = render('<svg><a href="https://shop.example/?utm_source=mail&id=7"><text>Shop</text></a></svg>', { attachments: [], allowRemote: false });
    expect(html).toContain('href="https://shop.example/?id=7"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('cannot create HTML markup by decoding CSS escapes after sanitization', () => {
    const result = render(String.raw`<style>.mail:after { content: "\3c /style>\3c img src=x onerror=alert(1)>" }</style><p>body</p>`, { attachments: [], allowRemote: true });
    const parsed = new dom.window.DOMParser().parseFromString(result.html, 'text/html');
    expect(parsed.querySelector('img')).toBeNull();
    expect(parsed.querySelector('[onerror]')).toBeNull();
    expect(parsed.querySelector('p')?.textContent).toBe('body');
  });
});

it('preserves signing intent through save, reopen, update, and an explicit opt-out', async () => {
  const h = harness();
  await h.setup();
  await h.login('admin@wren.test', 'a very long password');
  const saved = await h.call('POST', '/api/compose/drafts', { html: '<p>Sign this on send</p>', pgpSign: true });
  expect(saved.status).toBe(200);
  const path = `/api/compose/drafts/${saved.body.id}`;
  const reopened = (await h.call('GET', path)).body;
  expect(draftInit(reopened, null)).toMatchObject({ sign: true, html: '<p>Sign this on send</p>' });
  // Other clients that do not know about this flag must not erase it.
  await h.call('PUT', path, { html: '<p>Edited</p>' });
  expect(draftInit((await h.call('GET', path)).body, null).sign).toBe(true);
  await h.call('PUT', path, { html: '<p>Edited</p>', pgpSign: false });
  expect(draftInit((await h.call('GET', path)).body, null).sign).toBe(false);
});
