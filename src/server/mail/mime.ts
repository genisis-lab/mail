/**
 * Minimal, dependency-free RFC 5322 / MIME message builder that runs on
 * Cloudflare Workers and in tests on Node.js alike.
 *
 * Structure: mixed[ alternative[ text, related[ html, inline images ] ], attachments ]
 * (each level is only added when needed). Bcc is never written to headers.
 */
import crypto from 'node:crypto';
import type { Addr } from '../../shared/types.js';

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string | null;
  inline?: boolean;
}

export interface MimeInput {
  from: Addr;
  to?: Addr[];
  cc?: Addr[];
  replyTo?: string | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | string | null;
  date?: Date;
  headers?: Record<string, string>;
  attachments?: MimeAttachment[];
}

const CRLF = '\r\n';
const enc = new TextEncoder();
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

function boundary(): string {
  return `----=_Wren_${crypto.randomBytes(12).toString('hex')}`;
}

/** RFC 2047 encoded-word(s) for non-ASCII header text. */
export function encodeWords(text: string): string {
  if (isAscii(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    // Keep each encoded word under ~75 characters (45 bytes → 60 base64 chars).
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

export function formatMailbox(a: Addr): string {
  const name = (a.name ?? '').trim();
  if (!name) return a.address;
  if (!isAscii(name)) return `${encodeWords(name)} <${a.address}>`;
  if (/[()<>[\]:;@\\,."]/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${a.address}>`;
  return `${name} <${a.address}>`;
}

/** Fold a structured header at whitespace so lines stay under 78 characters. */
function header(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes(CRLF)) return line + CRLF;
  const tokens = value.split(' ');
  let out = `${name}:`;
  let current = out.length;
  for (const t of tokens) {
    if (current + 1 + t.length > 78 && current > name.length + 1) {
      out += `${CRLF} ${t}`;
      current = 1 + t.length;
    } else {
      out += ` ${t}`;
      current += 1 + t.length;
    }
  }
  return out + CRLF;
}

/** Quoted-printable encoding (RFC 2045) of UTF-8 text with CRLF line breaks. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const bytes = enc.encode(line);
    const tokens: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      if ((b === 0x20 || b === 0x09) && !last) tokens.push(String.fromCharCode(b));
      else if (b >= 33 && b <= 126 && b !== 61) tokens.push(String.fromCharCode(b));
      else tokens.push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
    }
    let cur = '';
    for (const t of tokens) {
      if (cur.length + t.length > 75) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += t;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

function base64Lines(data: Uint8Array): string {
  const b64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  return b64.replace(/.{1,76}/g, (m) => m + CRLF).replace(/\r\n$/, '');
}

function paramValue(v: string): string {
  return isAscii(v) ? `"${v.replace(/(["\\])/g, '\\$1')}"` : `"${encodeWords(v).replace(/\r\n /g, ' ')}"`;
}

interface Part {
  headers: string;
  body: string;
}

function textPart(type: 'plain' | 'html', content: string): Part {
  return {
    headers: header('Content-Type', `text/${type}; charset=utf-8`) + header('Content-Transfer-Encoding', 'quoted-printable'),
    body: quotedPrintable(content),
  };
}

function attachmentPart(a: MimeAttachment): Part {
  const type = a.contentType || 'application/octet-stream';
  let h = header('Content-Type', `${type}; name=${paramValue(a.filename)}`) + header('Content-Transfer-Encoding', 'base64');
  if (a.inline && a.contentId) {
    h += header('Content-ID', `<${a.contentId}>`) + header('Content-Disposition', `inline; filename=${paramValue(a.filename)}`);
  } else {
    h += header('Content-Disposition', `attachment; filename=${paramValue(a.filename)}`);
  }
  return { headers: h, body: base64Lines(a.content) };
}

function multipart(subtype: string, parts: Part[]): Part {
  const b = boundary();
  const body = parts.map((p) => `--${b}${CRLF}${p.headers}${CRLF}${p.body}${CRLF}`).join('') + `--${b}--`;
  return { headers: header('Content-Type', `multipart/${subtype}; boundary="${b}"`), body };
}

function rfc2822Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

const bracket = (id: string) => (id.startsWith('<') ? id : `<${id}>`);

export function buildMimeMessage(input: MimeInput): Buffer {
  const attachments = input.attachments ?? [];
  const inline = input.html ? attachments.filter((a) => a.inline && a.contentId) : [];
  const regular = attachments.filter((a) => !inline.includes(a));

  let htmlNode: Part | null = input.html ? textPart('html', input.html) : null;
  if (htmlNode && inline.length) htmlNode = multipart('related', [htmlNode, ...inline.map(attachmentPart)]);
  const text = input.text ?? '';
  let body: Part = htmlNode ? (text ? multipart('alternative', [textPart('plain', text), htmlNode]) : htmlNode) : textPart('plain', text);
  if (regular.length) body = multipart('mixed', [body, ...regular.map(attachmentPart)]);

  let h = '';
  if (input.messageId) h += header('Message-ID', bracket(input.messageId));
  h += header('Date', rfc2822Date(input.date ?? new Date()));
  h += header('From', formatMailbox(input.from));
  if (input.to?.length) h += header('To', input.to.map(formatMailbox).join(', '));
  if (input.cc?.length) h += header('Cc', input.cc.map(formatMailbox).join(', '));
  if (input.replyTo) h += header('Reply-To', input.replyTo);
  h += header('Subject', encodeWords(input.subject ?? ''));
  if (input.inReplyTo) h += header('In-Reply-To', bracket(input.inReplyTo));
  const refs = Array.isArray(input.references) ? input.references.map(bracket).join(' ') : input.references ?? '';
  if (refs) h += header('References', refs);
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!v || /^(content-type|content-transfer-encoding|mime-version|bcc)$/i.test(k)) continue;
    h += header(k, encodeWords(String(v).replace(/[\r\n]+/g, ' ')));
  }
  h += header('MIME-Version', '1.0');
  return Buffer.from(h + body.headers + CRLF + body.body + CRLF, 'utf8');
}
