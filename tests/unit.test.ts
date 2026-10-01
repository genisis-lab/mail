import { describe, expect, it } from 'vitest';
import { base32Encode, decrypt, decryptJson, encrypt, encryptJson, hashPassword, signToken, totpCode, verifyPassword, verifyToken, verifyTotp } from '../src/server/lib/crypto';
import { signAws } from '../src/server/lib/aws';
import { cleanMessageId, isEmail, isNoReply, matchesPattern, parseAddresses, parseReferences, stripSubaddress } from '../src/server/lib/addr';
import { buildSearch, ftsTerm, tokenize } from '../src/server/mail/search';
import { normalizeSubject } from '../src/server/mail/store';
import { htmlToText, makeSnippet } from '../src/server/mail/parse';

describe('crypto', () => {
  it('round-trips AES-GCM encryption and detects tampering', () => {
    const ct = encrypt('hello');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(decrypt(ct)).toBe('hello');
    expect(decryptJson(encryptJson({ a: 1 }))).toEqual({ a: 1 });
    const parts = ct.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });

  it('hashes and verifies passwords with scrypt', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('matches the RFC 6238 TOTP test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });

  it('signs and expires tokens', () => {
    const t = signToken({ u: 1 }, 60_000);
    expect(verifyToken<{ u: number }>(t)?.u).toBe(1);
    expect(verifyToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyToken(signToken({ u: 1 }, -1))).toBeNull();
  });
});

describe('AWS SigV4', () => {
  it('matches the AWS "get-vanilla" test vector', () => {
    const h = signAws({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      date: new Date('2015-08-30T12:36:00Z'),
    });
    expect(h.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('addresses', () => {
  it('parses address lists', () => {
    expect(parseAddresses('"Doe, Jane" <Jane@Example.com>, bob@x.org')).toEqual([
      { address: 'jane@example.com', name: 'Doe, Jane' },
      { address: 'bob@x.org', name: '' },
    ]);
    expect(parseAddresses([{ email: 'A@B.co', name: 'A' }])).toEqual([{ address: 'a@b.co', name: 'A' }]);
  });
  it('validates and normalises', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('not an email')).toBe(false);
    expect(stripSubaddress('john+news@x.com')).toBe('john@x.com');
    expect(cleanMessageId('<abc@x>')).toBe('abc@x');
    expect(parseReferences('<a@x> <b@y>')).toEqual(['a@x', 'b@y']);
  });
  it('matches block patterns', () => {
    expect(matchesPattern('spam@bad.com', 'bad.com')).toBe(true);
    expect(matchesPattern('spam@mail.bad.com', '@bad.com')).toBe(true);
    expect(matchesPattern('ok@good.com', 'bad.com')).toBe(false);
    expect(matchesPattern('a@x.com', 'a@x.com')).toBe(true);
    expect(isNoReply('no-reply@x.com')).toBe(true);
    expect(isNoReply('maya@x.com')).toBe(false);
  });
  it('normalises reply subjects for threading', () => {
    expect(normalizeSubject('Re: Fwd: RE: Hello')).toBe('hello');
    expect(normalizeSubject('AW: Antw: Meeting')).toBe('meeting');
  });
});

describe('text helpers', () => {
  it('turns HTML into readable text and snippets', () => {
    expect(htmlToText('<p>Hi <b>Bob</b>,</p><div>Line&nbsp;2</div>')).toBe('Hi Bob,\n\nLine 2');
    expect(makeSnippet('Hello\n> quoted\nworld', null)).toBe('Hello world');
  });
});

describe('search parser', () => {
  it('tokenizes operators, phrases and negation', () => {
    expect(tokenize('from:alice "big deal" -spam has:attachment')).toEqual([
      { key: 'from', value: 'alice', negate: false },
      { key: null, value: 'big deal', negate: false },
      { key: null, value: 'spam', negate: true },
      { key: 'has', value: 'attachment', negate: false },
    ]);
  });
  it('builds SQL fragments', () => {
    const s = buildSearch('from:alice is:unread in:inbox larger:1M report', 1, 0);
    expect(s.scoped).toBe(true);
    expect(s.where.join(' ')).toContain('m.from_addr LIKE');
    expect(s.where.join(' ')).toContain('m.is_read = 0');
    expect(s.where.join(' ')).toContain('m.folder = ?');
    expect(s.where.join(' ')).toContain('m.size > ?');
    expect(s.params).toContain(1024 * 1024);
    expect(s.params).toContain('"report"*');
  });
  it('quotes FTS terms safely', () => {
    expect(ftsTerm('he"llo')).toBe('"he""llo"*');
    expect(ftsTerm('two words', false)).toBe('"two words"');
  });
});

describe('MIME builder', async () => {
  const { buildMimeMessage, quotedPrintable, encodeWords } = await import('../src/server/mail/mime');
  const { parseMail } = await import('../src/server/mail/parse');

  it('round-trips unicode headers, bodies, attachments and inline images', async () => {
    const long = 'Résumé — '.repeat(30);
    const raw = buildMimeMessage({
      from: { address: 'zoë@wren.test', name: 'Zoë Ünïcode' },
      to: [{ address: 'bob@example.com', name: 'Bob, Jr.' }],
      cc: [{ address: 'c@example.com' }],
      subject: `Grüße aus Köln 🎉 ${long}`,
      text: `Hallo!\n${long}\n.`,
      html: `<p>Hallo <img src="cid:logo@wren"></p><p>${long}</p>`,
      messageId: 'abc@wren.test',
      inReplyTo: 'parent@x',
      references: ['root@x', 'parent@x'],
      headers: { 'X-Test': 'yes' },
      attachments: [
        { filename: 'naïve report.pdf', contentType: 'application/pdf', content: new Uint8Array(5000).fill(7) },
        { filename: 'logo.png', contentType: 'image/png', content: new Uint8Array([137, 80, 78, 71]), contentId: 'logo@wren', inline: true },
      ],
    });
    const text = raw.toString('utf8');
    expect(text).not.toMatch(/^Bcc:/im);
    for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    const p = await parseMail(raw);
    expect(p.subject).toBe(`Grüße aus Köln 🎉 ${long}`.trim());
    expect(p.from).toEqual({ address: 'zoë@wren.test', name: 'Zoë Ünïcode' });
    expect(p.to).toEqual([{ address: 'bob@example.com', name: 'Bob, Jr.' }]);
    expect(p.messageId).toBe('abc@wren.test');
    expect(p.references).toEqual(['root@x', 'parent@x']);
    expect(p.text?.trim()).toBe(`Hallo!\n${long}\n.`);
    expect(p.html).toContain('cid:logo@wren');
    const pdf = p.attachments.find((a) => a.contentType === 'application/pdf')!;
    expect(pdf.filename).toBe('naïve report.pdf');
    expect(pdf.content.length).toBe(5000);
    const logo = p.attachments.find((a) => a.contentId === 'logo@wren')!;
    expect(logo.inline).toBe(true);
  });

  it('encodes quoted-printable and RFC 2047 correctly', () => {
    expect(quotedPrintable('a=b')).toBe('a=3Db');
    expect(quotedPrintable('trailing ')).toBe('trailing=20');
    expect(quotedPrintable('x'.repeat(100)).split('\r\n').every((l) => l.length <= 76)).toBe(true);
    expect(encodeWords('plain')).toBe('plain');
    expect(encodeWords('héllo')).toBe('=?UTF-8?B?aMOpbGxv?=');
  });
});
