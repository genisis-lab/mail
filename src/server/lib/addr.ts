import { addressParser } from 'postal-mime';
import type { Addr } from '../../shared/types.js';

const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

export function localPart(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? address : address.slice(0, at);
}

/** Strip "+tag" subaddressing: john+news@x.com -> john@x.com */
export function stripSubaddress(address: string): string {
  const local = localPart(address);
  const plus = local.indexOf('+');
  return plus > 0 ? `${local.slice(0, plus)}@${domainOf(address)}` : address;
}

/** Parse "Name <a@b>, c@d" (or an array of such strings / objects) into Addr[]. */
export function parseAddresses(input: unknown): Addr[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap((v) => parseAddresses(v));
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const address = String(o.address ?? o.email ?? o.Email ?? o.Address ?? '').trim();
    const name = String(o.name ?? o.Name ?? '').trim();
    return address ? [{ address: normalizeEmail(address), name }] : [];
  }
  const out: Addr[] = [];
  const walk = (list: any[]) => {
    for (const item of list) {
      if (item.group) walk(item.group);
      else if (item.address) out.push({ address: normalizeEmail(item.address), name: (item.name || '').trim() });
    }
  };
  walk(addressParser(String(input)) as any[]);
  return out;
}

export function formatAddr(a: Addr): string {
  if (!a.name) return a.address;
  const needsQuotes = /[",;:<>()@[\]\\]/.test(a.name);
  const name = needsQuotes ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : a.name;
  return `${name} <${a.address}>`;
}

export function uniqueAddrs(list: Addr[]): Addr[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Strip angle brackets from a Message-ID. */
export function cleanMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = String(id).trim().match(/<?([^<>\s]+)>?/);
  return m ? m[1] : null;
}

export function parseReferences(value: unknown): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(' ') : String(value);
  if (!raw.includes('<')) return raw.split(/[\s,]+/).filter(Boolean);
  return [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
}

/** Matches a sender against a block pattern: exact address, "@domain" or "domain". */
export function matchesPattern(address: string, pattern: string): boolean {
  const a = address.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.includes('@') && !p.startsWith('@')) return a === p;
  const domain = p.replace(/^@/, '');
  const d = domainOf(a);
  return d === domain || d.endsWith(`.${domain}`);
}

/** Looks like an automated / no-reply sender (used to avoid auto-reply loops). */
export function isNoReply(address: string): boolean {
  const local = localPart(address).toLowerCase();
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)(\+.*)?$/.test(local) || local.includes('noreply');
}
