/**
 * One-click Cloudflare setup for a domain, using an API token the admin
 * provides:
 *
 *   1. find the zone,
 *   2. enable Email Routing (Cloudflare adds and locks the MX/SPF records),
 *   3. point the catch-all rule at this Worker,
 *   4. onboard the domain for Email Sending and create any missing DNS records,
 *   5. re-run Wren's DNS check.
 *
 * Endpoints match the official Cloudflare API (v4).
 */
import { get, now } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { getSettings, setSettings } from '../settings.js';
import { checkDomainDns } from './dns.js';

const API = 'https://api.cloudflare.com/client/v4';

export interface SetupStep {
  id: 'zone' | 'routing' | 'catchall' | 'sending' | 'dns' | 'check';
  title: string;
  status: 'done' | 'skipped' | 'failed' | 'warn';
  detail: string;
}

interface CfResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export class CloudflareApiError extends Error {}

export function cloudflareToken(): string | null {
  const stored = getSettings()['cloudflare.apiToken'];
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

export function saveCloudflareToken(token: string | null, workerName?: string) {
  setSettings({ 'cloudflare.apiToken': token ? encrypt(token) : '', ...(workerName ? { 'cloudflare.workerName': workerName } : {}) });
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: CfResponse<T> | null = null;
  try {
    data = (await res.json()) as CfResponse<T>;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !data?.success) {
    const msg = data?.errors?.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${res.status}`;
    throw new CloudflareApiError(res.status === 403 || res.status === 401 ? `${msg}. Check the token's permissions.` : msg);
  }
  return data.result;
}

/** Zones the token can see (used to confirm the token works). */
export async function listZones(token: string): Promise<string[]> {
  const zones = await cf<{ name: string }[]>(token, 'GET', '/zones?per_page=50');
  return zones.map((z) => z.name);
}

async function findZone(token: string, domain: string): Promise<{ id: string; name: string } | null> {
  const labels = domain.toLowerCase().split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const zones = await cf<{ id: string; name: string }[]>(token, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (zones[0]) return zones[0];
  }
  return null;
}

interface DnsRecord {
  type: string;
  name?: string;
  content?: string;
  priority?: number;
  ttl?: number;
}

const sameName = (a: string | undefined, b: string, zone: string) => {
  const norm = (n: string | undefined) => (n === '@' || !n ? zone : n).toLowerCase().replace(/\.$/, '');
  return norm(a) === norm(b);
};
const sameContent = (a: string | undefined, b: string | undefined) => (a ?? '').replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '') === (b ?? '').replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '');

export async function setUpDomainOnCloudflare(domainId: number, opts: { sending: boolean }): Promise<SetupStep[]> {
  const token = cloudflareToken();
  if (!token) throw new CloudflareApiError('Add a Cloudflare API token first');
  const domain = get<{ id: number; name: string }>('SELECT id, name FROM domains WHERE id = ?', [domainId]);
  if (!domain) throw new CloudflareApiError('Domain not found');
  const worker = getSettings()['cloudflare.workerName'] || 'wren';
  const steps: SetupStep[] = [];
  const fail = (id: SetupStep['id'], title: string, err: unknown) => steps.push({ id, title, status: 'failed', detail: (err as Error).message });

  // 1. Zone
  let zone: { id: string; name: string } | null = null;
  try {
    zone = await findZone(token, domain.name);
  } catch (err) {
    fail('zone', 'Find the domain on Cloudflare', err);
    return steps;
  }
  if (!zone) {
    steps.push({ id: 'zone', title: 'Find the domain on Cloudflare', status: 'failed', detail: `${domain.name} isn’t a zone this token can see. Add the domain to Cloudflare (or give the token access to it).` });
    return steps;
  }
  steps.push({ id: 'zone', title: 'Find the domain on Cloudflare', status: 'done', detail: `Zone ${zone.name}.` });
  const isApex = zone.name.toLowerCase() === domain.name.toLowerCase();

  // 2. Email Routing
  try {
    const settings = await cf<{ enabled: boolean; status?: string }>(token, 'GET', `/zones/${zone.id}/email/routing`);
    if (settings.enabled) {
      steps.push({ id: 'routing', title: 'Enable Email Routing', status: 'skipped', detail: `Already enabled${settings.status ? ` (${settings.status})` : ''}.` });
    } else {
      const r = await cf<{ enabled: boolean; status?: string }>(token, 'POST', `/zones/${zone.id}/email/routing/dns`, isApex ? {} : { name: domain.name });
      steps.push({ id: 'routing', title: 'Enable Email Routing', status: 'done', detail: `Enabled; Cloudflare added the MX and SPF records${r.status ? ` (${r.status})` : ''}.` });
    }
  } catch (err) {
    fail('routing', 'Enable Email Routing', err);
  }

  // 3. Catch-all → this Worker
  try {
    const current = await cf<{ enabled?: boolean; actions?: { type: string; value?: string[] }[] }>(token, 'GET', `/zones/${zone.id}/email/routing/rules/catch_all`);
    const already = current.enabled && current.actions?.some((a) => a.type === 'worker' && a.value?.includes(worker));
    if (already) {
      steps.push({ id: 'catchall', title: 'Send all mail to this Worker', status: 'skipped', detail: `The catch-all already goes to ${worker}.` });
    } else {
      const previous = current.enabled ? current.actions?.map((a) => `${a.type}${a.value?.length ? ` ${a.value.join(', ')}` : ''}`).join('; ') : null;
      await cf(token, 'PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
        actions: [{ type: 'worker', value: [worker] }],
        matchers: [{ type: 'all' }],
        enabled: true,
        name: 'Send everything to Wren',
      });
      steps.push({
        id: 'catchall',
        title: 'Send all mail to this Worker',
        status: 'done',
        detail: `Catch-all now sends to the Worker “${worker}”.${previous ? ` It previously did: ${previous}.` : ''}`,
      });
    }
  } catch (err) {
    fail('catchall', 'Send all mail to this Worker', err);
  }

  // 4. Email Sending (Cloudflare Email Service)
  if (opts.sending) {
    try {
      const subs = await cf<{ tag: string; name: string; enabled: boolean }[]>(token, 'GET', `/zones/${zone.id}/email/sending/subdomains`);
      let sub = subs.find((s) => s.name.toLowerCase() === domain.name.toLowerCase());
      if (sub?.enabled) {
        steps.push({ id: 'sending', title: 'Onboard Email Sending', status: 'skipped', detail: `${domain.name} is already set up for sending.` });
      } else {
        sub = await cf<{ tag: string; name: string; enabled: boolean }>(token, 'POST', `/zones/${zone.id}/email/sending/subdomains`, { name: domain.name });
        steps.push({ id: 'sending', title: 'Onboard Email Sending', status: 'done', detail: `${domain.name} can now send through Email Service.` });
      }
      // DNS records Email Sending expects; create the missing ones.
      const expected = await cf<DnsRecord[]>(token, 'GET', `/zones/${zone.id}/email/sending/subdomains/${sub.tag}/dns`);
      const created: string[] = [];
      const manual: string[] = [];
      for (const rec of expected) {
        if (!rec.type || !rec.name) continue;
        const existing = await cf<DnsRecord[]>(token, 'GET', `/zones/${zone.id}/dns_records?type=${encodeURIComponent(rec.type)}&name=${encodeURIComponent(rec.name === '@' ? zone.name : rec.name)}`);
        const matches = existing.filter((e) => sameName(e.name, rec.name!, zone!.name));
        if (matches.some((e) => sameContent(e.content, rec.content))) continue;
        if (rec.type === 'TXT' && /^"?v=spf1/i.test(rec.content ?? '') && matches.some((e) => /^"?v=spf1/i.test(e.content ?? ''))) {
          manual.push(`merge “${rec.content}” into the existing SPF record on ${rec.name}`);
          continue;
        }
        await cf(token, 'POST', `/zones/${zone.id}/dns_records`, {
          type: rec.type,
          name: rec.name,
          content: rec.content,
          ttl: rec.ttl ?? 1,
          ...(rec.priority !== undefined ? { priority: rec.priority } : {}),
        });
        created.push(`${rec.type} ${rec.name}`);
      }
      steps.push({
        id: 'dns',
        title: 'Create sending DNS records',
        status: manual.length ? 'warn' : created.length ? 'done' : 'skipped',
        detail: [created.length ? `Created ${created.join(', ')}.` : 'All records were already in place.', manual.length ? `By hand: ${manual.join('; ')}.` : ''].filter(Boolean).join(' '),
      });
    } catch (err) {
      fail('sending', 'Onboard Email Sending', err);
    }
  }

  // 5. Wren's own DNS check
  try {
    const report = await checkDomainDns(domain.id);
    const dkim = report.dkim.some((k) => k.found);
    const mx = report.mx.records.some((m) => /\.mx\.cloudflare\.net\.?$/i.test(m.exchange));
    steps.push({
      id: 'check',
      title: 'Check DNS',
      status: mx && (dkim || !opts.sending) ? 'done' : 'warn',
      detail: `${mx ? 'MX points to Email Routing' : 'MX not visible yet'}; ${dkim ? 'DKIM found' : 'DKIM not visible yet'}. DNS can take a few minutes to update. Checked ${new Date(now()).toISOString().slice(11, 16)} UTC.`,
    });
  } catch (err) {
    fail('check', 'Check DNS', err);
  }
  return steps;
}
