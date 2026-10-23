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
