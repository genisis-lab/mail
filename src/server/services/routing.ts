import { all, get } from '../db/index.js';
import { domainOf, normalizeEmail, stripSubaddress } from '../lib/addr.js';

export interface Resolution {
  /** Local users that should receive a copy. */
  userIds: number[];
  /** External addresses to forward to (from groups). */
  external: string[];
  /** The hosted address that matched (alias/group/mailbox/catch-all). */
  matched: string | null;
  /** Why nothing matched (for logs). */
  reason?: string;
}

export function isHostedDomain(domain: string): boolean {
  return !!get('SELECT 1 FROM domains WHERE name = ? AND enabled = 1', [domain.toLowerCase()]);
}

export function hostedDomains(): string[] {
  return all<{ name: string }>('SELECT name FROM domains WHERE enabled = 1').map((r) => r.name.toLowerCase());
}

interface AddressRow {
  id: number;
  address: string;
  kind: 'mailbox' | 'alias' | 'group';
  user_id: number | null;
  enabled: number;
  user_status: string | null;
}

function lookup(address: string): AddressRow | undefined {
  return get<AddressRow>(
    `SELECT a.id, a.address, a.kind, a.user_id, a.enabled, u.status AS user_status
       FROM addresses a
       JOIN domains d ON d.id = a.domain_id AND d.enabled = 1
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.address = ?`,
    [address],
  );
}

/**
 * Resolve a recipient address on a hosted domain to local users and external
 * forwards. Supports plus-addressing (user+tag@domain), aliases, groups
 * (nested one level) and per-domain catch-all.
 */
export function resolveRecipient(input: string): Resolution {
  const address = normalizeEmail(input);
  const domain = domainOf(address);
  const dom = get<{ id: number; catch_all_user_id: number | null; enabled: number }>(
    'SELECT id, catch_all_user_id, enabled FROM domains WHERE name = ?',
    [domain],
  );
  if (!dom || !dom.enabled) return { userIds: [], external: [], matched: null, reason: 'domain not hosted' };

  let row = lookup(address);
  if (!row) {
    const base = stripSubaddress(address);
    if (base !== address) row = lookup(base);
  }
  if (row && !row.enabled) return { userIds: [], external: [], matched: row.address, reason: 'address disabled' };

  if (row) {
    if (row.kind === 'group') return expandGroup(row.id, row.address, new Set([row.id]));
    if (row.user_id && row.user_status === 'active') return { userIds: [row.user_id], external: [], matched: row.address };
    return { userIds: [], external: [], matched: row.address, reason: 'mailbox suspended' };
  }

  if (dom.catch_all_user_id) {
    const u = get<{ status: string }>('SELECT status FROM users WHERE id = ?', [dom.catch_all_user_id]);
    if (u?.status === 'active') return { userIds: [dom.catch_all_user_id], external: [], matched: `*@${domain}` };
  }
  return { userIds: [], external: [], matched: null, reason: 'no such mailbox' };
}

function expandGroup(groupId: number, matched: string, seen: Set<number>): Resolution {
  const targets = all<{ user_id: number | null; external: string | null; status: string | null }>(
    `SELECT t.user_id, t.external, u.status FROM address_targets t LEFT JOIN users u ON u.id = t.user_id WHERE t.address_id = ?`,
    [groupId],
  );
  const userIds = new Set<number>();
  const external = new Set<string>();
  for (const t of targets) {
    if (t.user_id && t.status === 'active') userIds.add(t.user_id);
    if (t.external) {
      // A member may itself be a hosted address (e.g. another group or alias).
      const inner = lookup(t.external.toLowerCase());
      if (inner && inner.enabled) {
        if (inner.kind === 'group' && !seen.has(inner.id)) {
          seen.add(inner.id);
          const r = expandGroup(inner.id, matched, seen);
          r.userIds.forEach((u) => userIds.add(u));
          r.external.forEach((e) => external.add(e));
        } else if (inner.user_id && inner.user_status === 'active') {
          userIds.add(inner.user_id);
        }
      } else {
        external.add(t.external.toLowerCase());
      }
    }
  }
  return { userIds: [...userIds], external: [...external], matched };
}

/** True if the address would be delivered locally (hosted domain + known recipient). */
export function isLocalAddress(address: string): boolean {
  const r = resolveRecipient(address);
  return r.userIds.length > 0 || r.external.length > 0;
}
