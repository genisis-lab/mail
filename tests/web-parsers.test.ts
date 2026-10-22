import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv, toCsv } from '../src/web/lib/csv';
import { contactsFromCsv, contactsFromFile, contactsFromVcard } from '../src/web/lib/contacts-import';

describe('CSV', () => {
  it('handles quotes, doubled quotes, CRLF, a BOM and semicolons', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(parseCsv('name;email\nAnn;ann@example.org\n')).toEqual([
      ['name', 'email'],
      ['Ann', 'ann@example.org'],
    ]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([
      ['a', 'b'],
      ['multi\nline', '2'],
    ]);
    expect(csvRecords('Full Name,E-mail Address\nAnn,ann@example.org').records).toEqual([{ fullname: 'Ann', emailaddress: 'ann@example.org' }]);
    expect(parseCsv(toCsv([['a,b', 'c"d', null], [1, 'x\ny', '']]))).toEqual([
      ['a,b', 'c"d', ''],
      ['1', 'x\ny', ''],
    ]);
  });
});

describe('contact files', () => {
  it('reads Google Contacts CSV, including several addresses in one cell', () => {
    const google = 'First Name,Middle Name,Last Name,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Value,Organization Name,Notes\nZoë,,Quinn,* Home,zoe@example.org ::: zq@work.example,+1 555 0100,Quartz,"likes ""tea"""\n,,,,not-an-email,,,\n';
    expect(contactsFromCsv(google)).toEqual([
      { email: 'zoe@example.org', name: 'Zoë Quinn', phone: '+1 555 0100', company: 'Quartz', notes: 'likes "tea"' },
      { email: 'zq@work.example', name: 'Zoë Quinn', phone: '+1 555 0100', company: 'Quartz', notes: 'likes "tea"' },
    ]);
  });

  it('reads Outlook CSV and Wren’s own export', () => {
    expect(contactsFromCsv('First Name,Last Name,E-mail Address,Mobile Phone,Company\nMax,Power,max@example.org,555,Acme\n')).toEqual([
      { email: 'max@example.org', name: 'Max Power', phone: '555', company: 'Acme', notes: '' },
    ]);
    expect(contactsFromCsv('name,email,phone,company,notes\nPat,pat@example.org,,,\n')[0]).toMatchObject({ email: 'pat@example.org', name: 'Pat' });
  });

  it('reads vCards with folded lines, escapes and several emails', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Moreau;Alice;;;',
      'item1.EMAIL;TYPE=INTERNET:alice@example.org',
      'EMAIL;TYPE=WORK:alice@work.example',
      'TEL;TYPE=CELL:+33 6 00 00 00 00',
      'ORG:Fernhill\\, Inc.;Mail team',
      'NOTE:first line\\nsecond lin',
      ' e continued',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:No Email',
      'END:VCARD',
    ].join('\r\n');
    expect(contactsFromVcard(vcf)).toEqual([
      { email: 'alice@example.org', name: 'Alice Moreau', phone: '+33 6 00 00 00 00', company: 'Fernhill, Inc.', notes: 'first line\nsecond line continued' },
      { email: 'alice@work.example', name: 'Alice Moreau', phone: '+33 6 00 00 00 00', company: 'Fernhill, Inc.', notes: 'first line\nsecond line continued' },
    ]);
    expect(contactsFromFile('people.txt', 'BEGIN:VCARD\nFN:A\nEMAIL:a@example.org\nEND:VCARD')).toHaveLength(1);
  });
});

describe('forgotten attachments', async () => {
  const { mentionsAttachment } = await import('../src/web/lib/attachment-check');
  it('spots “see attached” and friends in what was written', () => {
    expect(mentionsAttachment('Report', 'Hi, please see attached for the numbers.')).toBe('see attached');
    expect(mentionsAttachment('Report', 'I’ve enclosed the contract')).toBe('I’ve enclosed');
    expect(mentionsAttachment('Report', 'PFA')).toBe('PFA');
    expect(mentionsAttachment('Attachment: invoice', 'Hello')).toBe('Attachment');
    expect(mentionsAttachment('Lunch?', 'Want to grab lunch?')).toBeNull();
    // A reply's subject came from the original message.
    expect(mentionsAttachment('Re: Contract attached', 'Thanks, looks good')).toBeNull();
    expect(mentionsAttachment('Fwd: attached', 'fyi')).toBeNull();
  });
});

describe('dark mode for email bodies', async () => {
  const { looksDesigned, luminance } = await import('../src/web/lib/dark-mail');
  it('keeps designed mail on white and lets ordinary mail go dark', () => {
    expect(looksDesigned('<div dir="ltr">Hey man<blockquote>On Fri… wrote: hi</blockquote></div>')).toBe(false);
    expect(looksDesigned('<p><span style="color:rgb(34,34,34);background-color:rgb(255,255,255)">pasted</span></p>')).toBe(false);
    expect(looksDesigned('<table width="600" bgcolor="#f4f4f4"><tr><td>Sale</td></tr></table>')).toBe(true);
    expect(looksDesigned('<div style="background-color:#0b5fff;color:#fff">Brand</div>')).toBe(true);
    expect(looksDesigned('<div style="background:url(https://x.example/a.png)">x</div>')).toBe(true);
    expect(looksDesigned('<div style="max-width:600px;margin:auto">Newsletter</div>')).toBe(true);
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1);
  });
});

describe('links and trackers in received mail', async () => {
  const { cleanLink, linkMismatch, isTrackingPixel, textToSafeHtml, MAIL_FORBID_TAGS } = await import('../src/web/lib/sanitize');
  const img = (attrs: Record<string, string>) => isTrackingPixel((name) => attrs[name] ?? null);

  it('drops tracking parameters and keeps the rest exactly as written', () => {
    expect(cleanLink('https://shop.example/p?id=7&utm_source=news&UTM_Medium=email&fbclid=abc#top')).toBe('https://shop.example/p?id=7#top');
    expect(cleanLink('https://shop.example/?utm_campaign=x&gclid=1&mc_eid=2&_hsenc=3&mkt_tok=4')).toBe('https://shop.example/');
    // Marketo's unsubscribe and view-in-browser pages need their token.
    expect(cleanLink('https://go.shop.example/UnsubscribePage.html?mkt_unsubscribe=1&mkt_tok=4&utm_source=x')).toBe('https://go.shop.example/UnsubscribePage.html?mkt_unsubscribe=1&mkt_tok=4');
    expect(cleanLink('https://go.shop.example/index.php/email/emailWebview?mkt_tok=4')).toBe('https://go.shop.example/index.php/email/emailWebview?mkt_tok=4');
    // Protocol-relative links are web links too.
    expect(cleanLink('//shop.example/p?id=7&utm_source=x')).toBe('https://shop.example/p?id=7');
    expect(cleanLink('//shop.example/p')).toBe('//shop.example/p');
    // Untouched links come back byte for byte, odd encoding and all.
    expect(cleanLink('https://Example.com/a%2Fb?q=a+b&x=%7E')).toBe('https://Example.com/a%2Fb?q=a+b&x=%7E');
    expect(cleanLink('https://shop.example/?q=a+b&utm_source=x&path=%2Fc')).toBe('https://shop.example/?q=a+b&path=%2Fc');
    // Parameters sites need stay.
    expect(cleanLink('https://shop.example/?page=2&token=abc&source=app')).toBe('https://shop.example/?page=2&token=abc&source=app');
    expect(cleanLink('mailto:ann@example.org')).toBeNull();
    expect(cleanLink('javascript:alert(1)')).toBeNull();
    expect(cleanLink('/relative')).toBeNull();
  });

  it('unwraps well-known redirect wrappers, only to web addresses', () => {
    expect(cleanLink('https://www.google.com/url?q=https://news.example/story%3Fid%3D1%26utm_source%3Dg&sa=D')).toBe('https://news.example/story?id=1');
    expect(cleanLink('https://www.google.co.uk/url?url=https%3A%2F%2Fnews.example%2F')).toBe('https://news.example/');
    expect(cleanLink('https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fbank.example%2Flogin&data=05%7C01&reserved=0')).toBe('https://bank.example/login');
    expect(cleanLink('https://l.facebook.com/l.php?u=https%3A%2F%2Fblog.example%2Fpost%3Ffbclid%3Dx&h=AT0')).toBe('https://blog.example/post');
    expect(cleanLink('https://www.youtube.com/redirect?q=https://docs.example/&v=1')).toBe('https://docs.example/');
    // Wrapped twice: Outlook around Google.
    expect(cleanLink(`https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://www.google.com/url?q=https://a.example/')}`)).toBe('https://a.example/');
    // Not a web address inside, or not really a wrapper: left alone.
    expect(cleanLink('https://www.google.com/url?q=javascript:alert(1)')).toBe('https://www.google.com/url?q=javascript:alert(1)');
    expect(cleanLink('https://google.evil.example/url?q=https://a.example/')).toBe('https://google.evil.example/url?q=https://a.example/');
    expect(cleanLink('https://www.google.com/search?q=https://a.example/')).toBe('https://www.google.com/search?q=https://a.example/');
  });

  it('spots link text that names a different site', () => {
    expect(linkMismatch('www.paypal.com', 'https://paypal.com.evil.example/login')).toBe('paypal.com');
    expect(linkMismatch('https://bank.example/login', 'https://bank-secure.example/')).toBe('bank.example');
    expect(linkMismatch(' PayPal.com. ', 'https://evil.example/')).toBe('paypal.com');
    expect(linkMismatch('pay\u200bpal.com', 'https://evil.example/')).toBe('paypal.com');
    expect(linkMismatch('paypal.com', '//evil.example/login')).toBe('paypal.com');
    expect(linkMismatch('paypal.com', '/\\evil.example/login')).toBe('paypal.com');
    // Browsers drop tabs and newlines inside, and control characters at the ends, before reading a link.
    expect(linkMismatch('paypal.com', '/\t/evil.example/login')).toBe('paypal.com');
    expect(linkMismatch('paypal.com', '/\n/evil.example/login')).toBe('paypal.com');
    expect(linkMismatch('paypal.com', '\u0001//evil.example/login')).toBe('paypal.com');
    // A file or product name only looks like a domain; written as an address, it's checked.
    for (const name of ['invoice.pdf', 'deck.pptx', 'Budget.XLSX', 'Node.js', 'README.md', 'index.html', 'photo.jpeg', 'files.zip']) {
      expect(linkMismatch(name, 'https://drive.example/f/1')).toBeNull();
    }
    expect(linkMismatch('www.readme.md', 'https://evil.example/')).toBe('readme.md');
    expect(linkMismatch('https://node.js', 'https://evil.example/')).toBe('node.js');
    expect(linkMismatch('docs.example/invoice.pdf', 'https://evil.example/')).toBe('docs.example');
    // Same site, a subdomain of it, or text that isn't an address: fine.
    expect(linkMismatch('paypal.com', 'https://www.paypal.com/us/home')).toBeNull();
    expect(linkMismatch('example.com', 'https://go.example.com/x')).toBeNull();
    expect(linkMismatch('www.news.example.com', 'https://example.com/')).toBeNull();
    expect(linkMismatch('Read more', 'https://evil.example/')).toBeNull();
    expect(linkMismatch('Visit example.com today', 'https://evil.example/')).toBeNull();
    expect(linkMismatch('ann@example.org', 'https://evil.example/')).toBeNull();
    expect(linkMismatch('v2.0', 'https://evil.example/')).toBeNull();
  });

  it('finds tracking pixels but leaves real pictures', () => {
    expect(img({ src: 'https://t.example/o.gif', width: '1', height: '1' })).toBe(true);
    expect(img({ src: '//t.example/o.gif', width: '0', height: '0' })).toBe(true);
    expect(img({ src: 'https://t.example/o.gif', style: 'border:0; width:1px !important; height:2px' })).toBe(true);
    expect(img({ src: 'https://t.example/o.gif', style: 'display:none' })).toBe(true);
    expect(img({ src: 'https://t.example/o.gif', hidden: '' })).toBe(true);
    expect(img({ src: 'https://acme.us1.list-manage.com/track/open.php?u=1&id=2', width: '600' })).toBe(true);
    expect(img({ src: 'https://u123.ct.sendgrid.net/wf/open?upn=abc' })).toBe(true);
    // Real pictures, and ones the sender can't learn anything from.
    expect(img({ src: 'https://cdn.example/hero.png', width: '600', height: '300' })).toBe(false);
    expect(img({ src: 'https://cdn.example/logo.png' })).toBe(false);
    expect(img({ src: 'https://cdn.example/rule.png', width: '1', height: '40' })).toBe(false);
    expect(img({ src: 'https://cdn.example/hero.png', width: '1', height: '1', style: 'width:100%;height:auto' })).toBe(false);
    expect(img({ src: 'https://cdn.example/a.png', width: '1%', height: '1%' })).toBe(false);
    expect(img({ src: 'https://cdn.example/a.png', style: 'max-width:1px;line-height:1px' })).toBe(false);
    // Phone-only picture, shown by an @media rule.
    expect(img({ src: 'https://cdn.example/m.png', width: '320', style: 'display:none' })).toBe(false);
    expect(img({ src: 'cid:logo@x', width: '1', height: '1' })).toBe(false);
    expect(img({ src: 'data:image/gif;base64,R0lGOD', width: '1', height: '1' })).toBe(false);
    // Pictures and media that load outside <img> are dropped, so blocking can't be skipped.
    // shortcut: checks the list, not sanitized output, since tests run without a DOM; test the output once they have one.
    expect(MAIL_FORBID_TAGS).toEqual(expect.arrayContaining(['image', 'feImage', 'source', 'video', 'audio']));
  });

  it('cleans links in plain-text mail without changing what it says', () => {
    const html = textToSafeHtml('See <https://shop.example/?id=1&utm_source=x> & "quotes"');
    expect(html).toContain('href="https://shop.example/?id=1" title="https://shop.example/?id=1"');
    expect(html).toContain('&lt;<a ');
    expect(html).toContain('>https://shop.example/?id=1&amp;utm_source=x</a>&gt; &amp; &quot;quotes&quot;');
  });
});
