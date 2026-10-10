/** Raw header access for Email/get's "headers" and "header:{name}:as{Form}" properties (RFC 8621 4.1.2). */
import { parseAddresses } from '../lib/addr.js';

export interface RawHeader {
  name: string;
  value: string;
}

/** The header block of a raw message, as name and raw (folded) value pairs. */
export function parseHeaderBlock(raw: Uint8Array): RawHeader[] {
  // Headers are ASCII (or 8-bit in practice); latin1 keeps every byte.
  const head = Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, 256 * 1024)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const block = end >= 0 ? head.slice(0, end) : head;
  const out: RawHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].value += `\r\n${line}`;
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push({ name: line.slice(0, i), value: line.slice(i + 1) });
    }
  }
  return out;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase() === 'us-ascii' ? 'utf-8' : charset).decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** Decode RFC 2047 encoded words; whitespace between two encoded words is dropped. */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === 'B') bytes = Uint8Array.from(Buffer.from(text, 'base64'));
      else {
        const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(q, (c) => c.charCodeAt(0));
      }
      return decodeCharset(bytes, charset);
    });
}

const unfold = (v: string) => v.replace(/\r?\n(?=[ \t])/g, '');

/** A header value in one of the parsed forms. */
export function headerForm(value: string, form: string): unknown {
  const text = decodeWords(unfold(value)).trim();
  switch (form) {
    case 'Raw':
      return value;
    case 'Text':
      return text;
    case 'Addresses':
      return parseAddresses(text).map((a) => ({ name: a.name || null, email: a.address }));
    case 'GroupedAddresses':
      return [{ name: null, addresses: parseAddresses(text).map((a) => ({ name: a.name || null, email: a.address })) }];
    case 'MessageIds': {
      const ids = [...text.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
      return ids.length ? ids : null;
    }
    case 'Date': {
      const t = Date.parse(text);
      return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    case 'URLs': {
      const urls = [...text.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
      return urls.length ? urls : null;
    }
    default:
      return undefined;
  }
}

const FORMS = new Set(['Raw', 'Text', 'Addresses', 'GroupedAddresses', 'MessageIds', 'Date', 'URLs']);

/** Parse "header:Subject:asText:all" into its parts, or null when malformed. */
export function parseHeaderProperty(prop: string): { name: string; form: string; all: boolean } | null {
  const parts = prop.split(':');
  if (parts[0] !== 'header' || !parts[1] || parts.length > 4) return null;
  let form = 'Raw';
  let all = false;
  for (const p of parts.slice(2)) {
    if (p === 'all') all = true;
    else if (p.startsWith('as') && FORMS.has(p.slice(2)) && !all) form = p.slice(2);
    else return null;
  }
  return { name: parts[1], form, all };
}
