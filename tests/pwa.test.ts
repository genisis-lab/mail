import { describe, expect, it } from 'vitest';
import { searchTerms } from '../src/web/lib/format';
import { mailtoMessage } from '../src/web/lib/share';
import { harness } from './harness';

const h = harness();

describe('the installed app', () => {
  it('takes shares and mailto: links, and opens them in the window already open', async () => {
    const m = await (await h.app.request('/api/manifest.webmanifest')).json();
    expect(m.share_target).toMatchObject({ action: '/api/share', method: 'POST', enctype: 'multipart/form-data' });
    expect(m.share_target.params.files[0].name).toBe('files');
    expect(m.protocol_handlers).toEqual([{ protocol: 'mailto', url: '/inbox?mailto=%s' }]);
    expect(m.launch_handler.client_mode[0]).toBe('navigate-existing');
  });

  it('opens a share the service worker missed as a new message with its text', async () => {
    const form = new FormData();
    form.set('title', 'Look at this');
    form.set('text', 'A+B & more');
    form.set('url', 'https://example.com/a?b=1');
    form.set('files', new File(['x'], 'x.txt'));
    // A plain form post from the system share sheet: no X-Wren header, and no sign-in needed to open the composer.
    const res = await h.app.request('/api/share', { method: 'POST', body: form });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location')!, 'https://mail.example');
    expect(to.pathname).toBe('/inbox');
    expect(mailtoMessage(to.searchParams.get('mailto')!)).toMatchObject({ subject: 'Look at this', text: 'A+B & more\nhttps://example.com/a?b=1', to: [] });
  });
});

describe('mailto: links', () => {
  it('reads recipients, subject and body, keeping plus signs', () => {
    expect(mailtoMessage('mailto:ada@example.com,%20grace@example.com?cc=kim@example.com&subject=Q3%20plan&body=1+1%3D2%0Athanks&x-ignored=1')).toEqual({
      to: [{ address: 'ada@example.com' }, { address: 'grace@example.com' }],
      cc: [{ address: 'kim@example.com' }],
      bcc: [],
      subject: 'Q3 plan',
      text: '1+1=2\nthanks',
    });
    expect(mailtoMessage('MAILTO:?BCC=x@example.com')?.bcc).toEqual([{ address: 'x@example.com' }]);
    // Not addresses, broken escapes and other links don't get through.
    expect(mailtoMessage('mailto:<script>@x?subject=%E0%A4%A')).toMatchObject({ to: [], subject: '%E0%A4%A' });
    expect(mailtoMessage('https://example.com')).toBeNull();
  });
});

describe('search highlights', () => {
  it('marks words and phrases, not operators or excluded words', () => {
    expect(searchTerms('invoice "march 2026" from:ada subject:budget -spam has:attachment OR x')).toEqual(['invoice', 'march 2026', 'budget']);
    expect(searchTerms('is:unread')).toEqual([]);
  });
});
