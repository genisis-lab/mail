import { get, now, run } from '../db/index.js';
import { config } from '../config.js';
import { getProviderDef } from '../providers/registry.js';
import { platform } from '../platform.js';

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
  spf: { ok: boolean; record: string | null; includesProvider: boolean | null; expectedInclude: string | null };
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

/** DNS records an admin should create for this domain. */
export function recommendedRecords(domain: { name: string; verify_token: string; provider_id: number | null; dkim_selector: string | null }): DnsRecordHint[] {
  const records: DnsRecordHint[] = [
    { type: 'TXT', host: `_wren.${domain.name}`, value: `wren-verify=${domain.verify_token}`, purpose: 'Proves you own the domain' },
  ];
  const provider = domain.provider_id ? get<{ type: string }>('SELECT type FROM providers WHERE id = ?', [domain.provider_id]) : undefined;
  const def = provider ? getProviderDef(provider.type) : undefined;
  records.push({
    type: 'MX',
    host: domain.name,
    value: 'route1.mx.cloudflare.net (+ route2, route3)',
    priority: 10,
    purpose: 'Added automatically when you enable Cloudflare Email Routing. Route the catch-all to this Worker. (Receiving through a provider webhook such as Resend instead? Use that provider’s MX records.)',
  });
  records.push({
    type: 'TXT',
    host: domain.name,
    value: `v=spf1 ${def?.spfInclude ? `include:${def.spfInclude} ` : ''}~all`,
    purpose: def?.spfInclude
      ? `Authorises ${def.name} to send for this domain (merge with any existing SPF record).`
      : 'Sender Policy Framework — add your provider’s include (merge with any existing SPF record).',
  });
  records.push({
    type: 'TXT',
    host: `_dmarc.${domain.name}`,
    value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.name}`,
    purpose: 'DMARC policy — start with p=none if you are unsure.',
  });
  const selectors = (domain.dkim_selector || def?.dkimSelectors?.join(',') || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    records.push({
      type: 'TXT',
      host: `${sel}._domainkey.${domain.name}`,
      value: def ? `(copy the DKIM value from ${def.name})` : '(your DKIM public key)',
      purpose: 'DKIM signature key — the exact value comes from your sending provider.',
    });
  }
  return records;
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

  const rootTxt = await txt(d.name);
  const spfRecord = rootTxt.find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
  const provider = d.provider_id ? get<{ type: string }>('SELECT type FROM providers WHERE id = ?', [d.provider_id]) : undefined;
  const expectedInclude = provider ? getProviderDef(provider.type)?.spfInclude ?? null : null;

  const selectors = (d.dkim_selector || (provider ? getProviderDef(provider.type)?.dkimSelectors?.join(',') : '') || '')
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

  const report: DnsReport = {
    checkedAt: now(),
    verification: { ok: verifyTxt.includes(expected), expected, found: verifyTxt },
    mx: { ok: mxRecords.length ? true : false, records: mxRecords, hint: mxHint },
    spf: {
      ok: !!spfRecord,
      record: spfRecord,
      includesProvider: expectedInclude && spfRecord ? spfRecord.includes(`include:${expectedInclude}`) : null,
      expectedInclude,
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
