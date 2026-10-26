/**
 * IPv4 and IPv6 addresses and CIDR ranges: the admin panel's IP allowlist and
 * the network a sign-in came from.
 */

export interface Ip {
  v: 4 | 6;
  n: bigint;
}

export interface IpRange extends Ip {
  bits: number;
}

const width = (v: 4 | 6) => (v === 4 ? 32 : 128);

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    // No leading zeros: "010" is octal to some tools and decimal to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  let text = s;
  // A dotted IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = parseV4(tail[2]);
    if (v4 === null) return null;
    text = `${tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const full = [...head, ...Array(8 - all.length).fill('0'), ...rest];
  return full.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

/** An address, or null. IPv4-mapped IPv6 (::ffff:192.0.2.1) counts as the IPv4 address. */
export function parseIp(raw: string): Ip | null {
  const s = raw.trim();
  if (!s || s.length > 45) return null;
  if (!s.includes(':')) {
    const n = parseV4(s);
    return n === null ? null : { v: 4, n };
  }
  const n = parseV6(s);
  if (n === null) return null;
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

const mask = (v: 4 | 6, bits: number) => (bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width(v) - bits));

/** "192.0.2.0/24", "2001:db8::/32" or a single address; null if it isn't one. */
export function parseCidr(raw: string): IpRange | null {
  const [addr, len, extra] = raw.trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  let bits = width(ip.v);
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    bits = Number(len);
    // ::ffff:192.0.2.0/120 is written in IPv6 bits.
    if (ip.v === 4 && addr.includes(':')) bits -= 96;
    if (bits < 0 || bits > width(ip.v)) return null;
  }
  return { v: ip.v, bits, n: ip.n & mask(ip.v, bits) };
}

export function inRange(ip: Ip, range: IpRange): boolean {
  return ip.v === range.v && (ip.n & mask(ip.v, range.bits)) === range.n;
}

/** An allowlist as typed (one entry per line, or separated by commas or spaces): its ranges, and the entries that aren't IPs or CIDRs. */
export function parseIpList(text: string): { entries: string[]; ranges: IpRange[]; invalid: string[] } {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  const ranges: IpRange[] = [];
  const invalid: string[] = [];
  for (const e of entries) {
    const r = parseCidr(e);
    if (r) ranges.push(r);
    else invalid.push(e);
  }
  return { entries, ranges, invalid };
}

/** Whether an address falls in any of the ranges (an empty or unreadable address never does). */
export function ipInList(raw: string, ranges: IpRange[]): boolean {
  const ip = parseIp(raw);
  return !!ip && ranges.some((r) => inRange(ip, r));
}

/** The network an address is on, for telling places apart: its /24 (IPv4) or /48 (IPv6). */
export function ipNetwork(raw: string): string {
  const ip = parseIp(raw);
  if (!ip) return '';
  if (ip.v === 4) {
    const n = Number(ip.n >> 8n);
    return `${n >>> 16}.${(n >>> 8) & 255}.${n & 255}.0/24`;
  }
  const groups = [ip.n >> 112n, (ip.n >> 96n) & 0xffffn, (ip.n >> 80n) & 0xffffn].map((g) => g.toString(16));
  return `${groups.join(':')}::/48`;
}
