/**
 * Is a domain set up for sending at the provider that would send its mail?
 * Shown next to a domain (for example a sending subdomain such as
 * contact.example.com) so the admin can see it's verified there as well as in
 * Wren. Purely informational: what Wren may send from is still decided by its
 * own domain list and TXT verification.
 */
import { get } from '../db/index.js';
import { logger } from '../lib/log.js';
import { loadProvider, providerContext, providersForDomain } from '../mail/outbound.js';
import { getProviderDef } from '../providers/registry.js';

const log = logger('sending-domains');

/** The closest other hosted domain above a subdomain (contact.example.com → example.com), or null. */
export function parentHostedDomain(domain: string): string | null {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  for (let i = 1; i <= labels.length - 2; i++) {
    const parent = labels.slice(i).join('.');
    if (get('SELECT 1 FROM domains WHERE name = ? AND enabled = 1', [parent])) return parent;
  }
  return null;
}

export interface SenderCheck {
  domain: string;
  provider: { id: number; name: string; type: string } | null;
  /** What the provider says: verified, not verified / not set up, or null when it can't be asked. */
  verified: boolean | null;
  detail: string;
}

/** Ask the provider that sends for `domain` whether the domain is set up there. */
export async function checkSendingDomain(domain: string): Promise<SenderCheck> {
  const name = domain.toLowerCase();
  const { primary } = providersForDomain(name);
  const p = loadProvider(primary);
  const def = p && getProviderDef(p.type);
  const provider = p ? { id: p.id, name: p.name, type: p.type } : null;
  if (!p || !def) return { domain: name, provider, verified: null, detail: 'No outbound provider is set up yet.' };
  if (!def.sendingDomains) {
    return { domain: name, provider, verified: null, detail: `${p.name} can’t be asked which domains are verified. Make sure ${name} is verified there too.` };
  }
  try {
    const list = await def.sendingDomains(p.cfg, providerContext);
    const hit = list.find((d) => d.name === name);
    if (!hit) return { domain: name, provider, verified: false, detail: `${name} isn’t set up in ${p.name} yet. Add it there and create the DNS records it shows, or mail from it will be refused.` };
    return {
      domain: name,
      provider,
      verified: hit.verified,
      detail: hit.verified ? `Verified in ${p.name}.` : `${name} is in ${p.name} but not verified yet. Check the DNS records it shows.`,
    };
  } catch (err) {
    // A key that may only send (Resend "sending access" keys, for example) can't list domains.
    log.warn(`Couldn't list ${p.name} domains`, err);
    return { domain: name, provider, verified: null, detail: `Couldn’t ask ${p.name} which domains are verified (the API key may only be allowed to send). Make sure ${name} is verified there too.` };
  }
}
