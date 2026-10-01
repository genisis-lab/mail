import type { DnsResolver } from '../platform.js';

/** DNS over HTTPS (Cloudflare 1.1.1.1 JSON API) — works on every runtime with fetch. */
export function dohResolver(endpoint = 'https://cloudflare-dns.com/dns-query'): DnsResolver {
  async function query(name: string, type: 'TXT' | 'MX' | 'CNAME'): Promise<string[]> {
    const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`DNS query failed (HTTP ${res.status})`);
    const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    if (body.Status === 3) return []; // NXDOMAIN
    const code = { TXT: 16, MX: 15, CNAME: 5 }[type];
    return (body.Answer ?? []).filter((a) => a.type === code).map((a) => a.data);
  }
  return {
    async txt(name) {
      // TXT data arrives as one or more quoted strings: "v=spf1 a " "~all"
      return (await query(name, 'TXT')).map((d) => {
        const parts = [...d.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
        return parts.length ? parts.join('') : d;
      });
    },
    async mx(name) {
      return (await query(name, 'MX')).map((d) => {
        const [prio, host] = d.split(/\s+/);
        return { priority: Number(prio), exchange: (host ?? '').replace(/\.$/, '') };
      });
    },
    async cname(name) {
      return (await query(name, 'CNAME')).map((d) => d.replace(/\.$/, ''));
    },
  };
}
