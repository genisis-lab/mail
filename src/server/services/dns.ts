import { all, get, now, run } from '../db/index.js';
import { raiseAlert, resolveAlert } from './alerts.js';
import { config } from '../config.js';
import { getProviderDef } from '../providers/registry.js';
import { platform } from '../platform.js';
import { parentHostedDomain } from './sending-domains.js';

export interface DnsRecordHint {
  type: 'MX' | 'TXT' | 'CNAME';
  host: string;
  value: string;
  priority?: number;
  purpose: string;
  optional?: boolean;
}

export interface DnsReport {
  checkedAt: number;
  verification: { ok: boolean; expected: string; found: string[] };
  mx: { ok: boolean | null; records: { exchange: string; priority: number }[]; hint: string };
  spf: { ok: boolean; record: string | null; includesProvider: boolean | null; expectedInclude: string | null; host?: string };
  dkim: { selector: string; found: boolean; value: string | null }[];
  dmarc: { ok: boolean; record: string | null; policy: string | null };
  errors: string[];
}

async function txt(name: string): Promise<string[]> {
  try {
    return await platform().dns.txt(name);
  } catch {
    return [];
  }
}

/** The provider that actually sends for a domain: its own, else the default. */
export function sendingProviderType(domain: { provider_id: number | null }): string | null {
  const own = domain.provider_id ? get<{ type: string }>('SELECT type FROM providers WHERE id = ? AND enabled = 1', [domain.provider_id]) : undefined;
  if (own) return own.type;
  return get<{ type: string }>('SELECT type FROM providers WHERE is_default = 1 AND enabled = 1 ORDER BY id LIMIT 1')?.type ?? null;
}

/** Providers whose SPF and DKIM records the provider adds itself when you onboard the domain. */
const MANAGED_RECORDS = new Set(['cloudflare-binding', 'cloudflare']);

/**
 * Providers that send from their own bounce subdomain: SPF (and a bounce MX)
 * live there, not on the domain itself.
 */
const RETURN_PATH: Record<string, { label: string; mx: string }> = {
  resend: { label: 'send', mx: 'feedback-smtp.<region>.amazonses.com' },
};

/** Where SPF is checked for a domain: the provider's bounce subdomain, or the domain. */
function spfHost(domain: string, providerType: string | null): string {
  const rp = providerType ? RETURN_PATH[providerType] : undefined;
  return rp ? `${rp.label}.${domain}` : domain;
}

/** DNS records an admin should create for this domain. */
export function recommendedRecords(domain: { id?: number; name: string; verify_token: string; provider_id: number | null; dkim_selector: string | null }): DnsRecordHint[] {
  // A sending-only subdomain never receives mail, so it can only be verified with this record.
  const sendingOnly = domain.id !== undefined && sendingOnlyDomain(domain.id, domain.name);
  const records: DnsRecordHint[] = [
    sendingOnly
      ? {
          type: 'TXT',
          host: `_wren.${domain.name}`,
          value: `wren-verify=${domain.verify_token}`,
          purpose: `Proves you own ${domain.name}. Add it next to the records your sending provider asked for, then press Check DNS.`,
        }
      : {
          type: 'TXT',
          host: `_wren.${domain.name}`,
          value: `wren-verify=${domain.verify_token}`,
          purpose: 'Proves you own the domain. Not needed if the domain receives mail through Cloudflare Email Routing: it’s verified automatically when the first message arrives.',
          optional: true,
        },
  ];
  const type = sendingProviderType(domain);
  const def = type ? getProviderDef(type) : undefined;
  const managed = !!type && MANAGED_RECORDS.has(type);
  const returnPath = type ? RETURN_PATH[type] : undefined;
  if (sendingOnly) {
    records.push({
      type: 'MX',
      host: domain.name,
      value: '(not needed)',
      purpose: `Only for receiving. Nothing on ${domain.name} receives mail, so leave it out unless you create an address here.`,
      optional: true,
    });
  } else if (def?.inbound && !managed) {
    records.push({
      type: 'MX',
      host: domain.name,
      value: `(the MX record ${def.name} shows)`,
      priority: 10,
      purpose: `Mail arrives through ${def.name}: turn on receiving for ${domain.name} there, add the MX record it shows, and point its inbound webhook at the URL on the Providers page. (Receiving through Cloudflare Email Routing instead? Use route1/route2/route3.mx.cloudflare.net.)`,
    });
  } else {
    records.push({
      type: 'MX',
      host: domain.name,
      value: '(added by Cloudflare: route1, route2 and route3.mx.cloudflare.net)',
      priority: 10,
      purpose: 'Added automatically when you enable Cloudflare Email Routing. Route the catch-all to this Worker. (Receiving through a provider webhook such as Resend instead? Use that provider’s MX records.)',
    });
  }
  if (managed) {
    records.push({
      type: 'TXT',
      host: domain.name,
      value: '(added by Cloudflare)',
      purpose: `SPF and DKIM are created by Cloudflare when you onboard ${domain.name} under Email Service → Email Sending (or use “Set up with Cloudflare” below). Don’t replace them by hand.`,
    });
  } else if (def?.spfInclude && returnPath) {
    records.push({
      type: 'MX',
      host: `${returnPath.label}.${domain.name}`,
      value: `(${returnPath.mx}, as ${def.name} shows)`,
      priority: 10,
      purpose: `Bounce handling for ${def.name}. The region in the host name comes from your ${def.name} domain page.`,
    });
    records.push({
      type: 'TXT',
      host: `${returnPath.label}.${domain.name}`,
      value: `v=spf1 include:${def.spfInclude} ~all`,
      purpose: `SPF for ${def.name}’s bounce subdomain. ${def.name} sends from ${returnPath.label}.${domain.name}, so the domain’s own SPF record can stay as it is.`,
    });
  } else if (def?.spfInclude) {
    records.push({
      type: 'TXT',
      host: domain.name,
      value: `v=spf1 include:${def.spfInclude} ~all`,
      purpose: `Authorises ${def.name} to send for this domain. If an SPF record already exists, add include:${def.spfInclude} to it instead of creating a second one.`,
    });
  } else {
    records.push({
      type: 'TXT',
      host: domain.name,
      value: '(from your sending provider)',
      purpose: 'SPF: use the record your sending provider gives you. If one already exists, merge the provider’s include into it.',
    });
  }
  records.push({
    type: 'TXT',
    host: `_dmarc.${domain.name}`,
    value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.name}`,
    purpose: 'DMARC policy — start with p=none if you are unsure.',
  });
  const selectors = (domain.dkim_selector || def?.dkimSelectors?.join(',') || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of managed ? [] : selectors) {
    records.push({
      type: 'TXT',
      host: `${sel}._domainkey.${domain.name}`,
      value: def ? `(copy the DKIM value from ${def.name})` : '(your DKIM public key)',
      purpose: 'DKIM signature key — the exact value comes from your sending provider.',
    });
  }
  return records;
}

/** A subdomain of another hosted domain with no address, group or catch-all on it: used only for sending. */
export function sendingOnlyDomain(domainId: number, name: string): boolean {
  if (!parentHostedDomain(name)) return false;
  const d = get<{ catch_all_user_id: number | null }>('SELECT catch_all_user_id FROM domains WHERE id = ?', [domainId]);
  return !d?.catch_all_user_id && !get('SELECT 1 FROM addresses WHERE domain_id = ? LIMIT 1', [domainId]) && !get('SELECT 1 FROM users WHERE lower(email) LIKE ? LIMIT 1', [`%@${name.toLowerCase()}`]);
}

export async function checkDomainDns(domainId: number): Promise<DnsReport> {
  const d = get<{ id: number; name: string; verify_token: string; provider_id: number | null; dkim_selector: string | null }>(
    'SELECT id, name, verify_token, provider_id, dkim_selector FROM domains WHERE id = ?',
    [domainId],
  );
  if (!d) throw new Error('Domain not found');
  const r = platform().dns;
  const errors: string[] = [];
  const expected = `wren-verify=${d.verify_token}`;
  const verifyTxt = [...(await txt(`_wren.${d.name}`)), ...(await txt(d.name))].filter((t) => t.startsWith('wren-verify='));

  let mxRecords: { exchange: string; priority: number }[] = [];
  try {
    mxRecords = (await r.mx(d.name)).sort((a, b) => a.priority - b.priority);
  } catch (err: any) {
    if (err?.code !== 'ENODATA' && err?.code !== 'ENOTFOUND') errors.push(`MX lookup failed: ${err.code ?? err.message}`);
  }
  const cfRouting = mxRecords.some((m) => /\.mx\.cloudflare\.net\.?$/i.test(m.exchange));
  const mxHint = !mxRecords.length
    ? 'No MX records: this domain cannot receive mail yet. Enable Cloudflare Email Routing for it.'
    : cfRouting
      ? 'MX points to Cloudflare Email Routing. Make sure the catch-all rule sends mail to this Worker.'
      : `MX points to ${mxRecords.map((m) => m.exchange).join(', ')}. That's fine if that provider (for example Resend) forwards mail to Wren with a webhook.`;

  const providerType = sendingProviderType(d);
  const spfRecord = (await txt(spfHost(d.name, providerType))).find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
  const expectedInclude = providerType ? getProviderDef(providerType)?.spfInclude ?? null : null;

  const selectors = (d.dkim_selector || (providerType ? getProviderDef(providerType)?.dkimSelectors?.join(',') : '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dkim = [];
  for (const sel of selectors) {
    const name = `${sel}._domainkey.${d.name}`;
    let value: string | null = (await txt(name)).find((t) => t.includes('p=')) ?? null;
    if (!value) {
      try {
        const cname = await r.cname(name);
        value = cname[0] ? `CNAME → ${cname[0]}` : null;
      } catch {
        /* none */
      }
    }
    dkim.push({ selector: sel, found: !!value, value });
  }

  const dmarcRecord = (await txt(`_dmarc.${d.name}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const policy = dmarcRecord ? /;\s*p=([a-z]+)/i.exec(dmarcRecord)?.[1]?.toLowerCase() ?? null : null;

  // A subdomain used only to send from (contact.example.com next to a hosted example.com): nothing to receive.
  const sendingOnly = !mxRecords.length && sendingOnlyDomain(d.id, d.name);
  const report: DnsReport = {
    checkedAt: now(),
    verification: { ok: verifyTxt.includes(expected), expected, found: verifyTxt },
    mx: sendingOnly
      ? { ok: null, records: [], hint: `Not needed: no address on ${d.name} receives mail, so it’s only used to send from. Add an MX record if you create an address here.` }
      : { ok: mxRecords.length ? true : false, records: mxRecords, hint: mxHint },
    spf: {
      ok: !!spfRecord,
      record: spfRecord,
      includesProvider: expectedInclude && spfRecord ? spfRecord.includes(`include:${expectedInclude}`) : null,
      expectedInclude,
      host: spfHost(d.name, providerType),
    },
    dkim,
    dmarc: { ok: !!dmarcRecord, record: dmarcRecord, policy },
    errors,
  };
  run(`UPDATE domains SET dns_report = ?, dns_checked_at = ?, verified_at = CASE WHEN ? THEN COALESCE(verified_at, ?) ELSE verified_at END WHERE id = ?`, [
    JSON.stringify(report),
    report.checkedAt,
    report.verification.ok ? 1 : 0,
    report.checkedAt,
    d.id,
  ]);
  return report;
}

/** What got worse between two DNS checks (used for alerts). */
export function dnsRegressions(prev: DnsReport | null, next: DnsReport): string[] {
  if (!prev) return [];
  const out: string[] = [];
  if (prev.mx.records.length && !next.mx.records.length) out.push('MX records are gone, so the domain can’t receive mail');
  const cf = (r: DnsReport) => r.mx.records.some((m) => /\.mx\.cloudflare\.net\.?$/i.test(m.exchange));
  if (cf(prev) && next.mx.records.length && !cf(next)) out.push('MX no longer points to Cloudflare Email Routing');
  for (const k of prev.dkim) {
    if (k.found && next.dkim.some((n) => n.selector === k.selector && !n.found)) out.push(`DKIM key ${k.selector} disappeared`);
  }
  if (prev.spf.ok && !next.spf.ok) out.push('The SPF record is gone');
  if (prev.spf.includesProvider && next.spf.includesProvider === false) out.push('SPF no longer includes the sending provider');
  return out;
}

/** Check domains that haven't been checked for a day; alert on regressions. */
export async function autoCheckDomains(limit = 5): Promise<number> {
  const due = all<{ id: number; name: string; dns_report: string | null }>(
    'SELECT id, name, dns_report FROM domains WHERE enabled = 1 AND (dns_checked_at IS NULL OR dns_checked_at < ?) ORDER BY dns_checked_at LIMIT ?',
    [now() - 24 * 3600_000, limit],
  );
  for (const d of due) {
    const prev = d.dns_report ? (JSON.parse(d.dns_report) as DnsReport) : null;
    try {
      const next = await checkDomainDns(d.id);
      const problems = dnsRegressions(prev, next);
      if (problems.length) {
        await raiseAlert({ kind: 'dns', key: String(d.id), severity: 'critical', title: `DNS changed for ${d.name}`, detail: problems.join('. ') + '.', link: `/admin/domains/${d.id}` });
      } else if (next.mx.records.length && next.errors.length === 0) {
        resolveAlert('dns', String(d.id));
      }
    } catch {
      run('UPDATE domains SET dns_checked_at = ? WHERE id = ?', [now(), d.id]); // try again tomorrow
    }
  }
  return due.length;
}

/** Mail delivered for a domain through Cloudflare Email Routing proves the domain routes to this Worker. */
export function verifyDomainsByRouting(addresses: string[]) {
  const domains = [...new Set(addresses.map((a) => a.split('@')[1]?.toLowerCase()).filter(Boolean))];
  for (const d of domains) run('UPDATE domains SET verified_at = ? WHERE name = ? AND verified_at IS NULL', [now(), d]);
}
