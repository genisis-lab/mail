import { DEFAULT_PREFS, type Identity, type Role, type SessionUser, type UserPrefs } from '../../shared/types.js';
import { all, get, insert, now, run, tx } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';
import { domainOf, isEmail, localPart, normalizeEmail } from '../lib/addr.js';
import { badRequest, conflict } from '../lib/http.js';
import { getSettings } from '../settings.js';

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  status: 'active' | 'suspended';
  quota_bytes: number | null;
  used_bytes: number;
  send_limit_per_day: number | null;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  prefs: string;
  created_at: number;
  last_login_at: number | null;
  password_changed_at: number | null;
  kind: 'person' | 'shared';
  recovery_email: string | null;
  recovery_verified_at: number | null;
}

export function getUser(id: number): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export function getUserByEmail(email: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);
}

export function parsePrefs(json: string | null | undefined): UserPrefs {
  let p: Partial<UserPrefs> = {};
  try {
    p = JSON.parse(json || '{}');
  } catch {
    /* defaults */
  }
  return {
    ...DEFAULT_PREFS,
    ...p,
    vacation: { ...DEFAULT_PREFS.vacation, ...(p.vacation ?? {}) },
    forwarding: { ...DEFAULT_PREFS.forwarding, ...(p.forwarding ?? {}) },
    signatures: { ...(p.signatures ?? {}) },
  };
}

export function getPrefs(userId: number): UserPrefs {
  return parsePrefs(get<{ prefs: string }>('SELECT prefs FROM users WHERE id = ?', [userId])?.prefs);
}

export function savePrefs(userId: number, prefs: UserPrefs) {
  run('UPDATE users SET prefs = ? WHERE id = ?', [JSON.stringify(prefs), userId]);
}

/** Addresses this user may send from (mailbox, aliases, and groups they belong to that allow sending). */
export function identities(userId: number): Identity[] {
  const user = getUser(userId);
  const rows = all<{ address: string; name: string; kind: Identity['kind'] }>(
    `SELECT a.address, a.name, a.kind FROM addresses a
       JOIN domains d ON d.id = a.domain_id AND d.enabled = 1
      WHERE a.user_id = ? AND a.enabled = 1 AND a.can_send = 1
     UNION
     SELECT a.address, a.name, a.kind FROM addresses a
       JOIN address_targets t ON t.address_id = a.id
       JOIN domains d ON d.id = a.domain_id AND d.enabled = 1
      WHERE a.kind = 'group' AND t.user_id = ? AND a.enabled = 1 AND a.can_send = 1`,
    [userId, userId],
  );
  const order = { mailbox: 0, alias: 1, group: 2 } as const;
  return rows
    .map((r) => ({ address: r.address, name: r.name || user?.name || '', kind: r.kind }))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.address.localeCompare(b.address));
}

export function userAddresses(userId: number): string[] {
  return all<{ address: string }>('SELECT address FROM addresses WHERE user_id = ?', [userId]).map((r) => r.address.toLowerCase());
}

export function quotaBytes(user: Pick<UserRow, 'quota_bytes'>): number {
  return user.quota_bytes ?? getSettings()['limits.defaultQuotaMb'] * 1024 * 1024;
}

export function sendLimit(user: Pick<UserRow, 'send_limit_per_day'>): number {
  return user.send_limit_per_day ?? getSettings()['limits.defaultSendPerDay'];
}

export function mustSetup2fa(user: UserRow): boolean {
  if (user.totp_enabled) return false;
  const policy = getSettings()['security.require2fa'];
  return policy === 'all' || (policy === 'admins' && (user.role === 'admin' || user.role === 'owner'));
}

export function sessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    totpEnabled: !!user.totp_enabled,
    prefs: parsePrefs(user.prefs),
    identities: identities(user.id),
    mustSetup2fa: mustSetup2fa(user),
  };
}

export function validatePassword(pw: string) {
  const min = getSettings()['security.passwordMinLength'];
  if (typeof pw !== 'string' || pw.length < min) throw badRequest(`Password must be at least ${min} characters`);
  if (pw.length > 256) throw badRequest('Password is too long');
}

export function findDomain(name: string) {
  return get<{ id: number; name: string; enabled: number }>('SELECT id, name, enabled FROM domains WHERE name = ?', [name.toLowerCase()]);
}

/** Create a user with a mailbox address on a hosted domain. */
export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role?: Role;
  quotaBytes?: number | null;
  sendLimitPerDay?: number | null;
}): Promise<number> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw badRequest('Invalid email address');
  if (!/^[a-z0-9._+-]+$/i.test(localPart(email))) throw badRequest('Address may only contain letters, numbers, dots, dashes, underscores and plus');
  const domain = findDomain(domainOf(email));
  if (!domain) throw badRequest(`Domain ${domainOf(email)} is not hosted on this server`);
  validatePassword(input.password);
  if (get('SELECT 1 FROM addresses WHERE address = ?', [email]) || getUserByEmail(email)) {
    throw conflict('That address is already taken');
  }
  const hash = await hashPassword(input.password);
  return tx(() => {
    const ts = now();
    const id = insert(
      `INSERT INTO users (email, name, password_hash, role, quota_bytes, send_limit_per_day, prefs, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      [email, input.name.trim(), hash, input.role ?? 'user', input.quotaBytes ?? null, input.sendLimitPerDay ?? null, ts, ts],
    );
    insert(
      `INSERT INTO addresses (address, domain_id, kind, user_id, name, created_at) VALUES (?, ?, 'mailbox', ?, ?, ?)`,
      [email, domain.id, id, input.name.trim(), ts],
    );
    return id;
  });
}

export function sentToday(userId: number): number {
  const since = now() - 24 * 3600 * 1000;
  return (
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND kind IN ('user','api') AND created_at > ? AND status != 'cancelled'`,
      [userId, since],
    )?.c ?? 0
  );
}

/**
 * Give an account a new primary address (the "username"), on any hosted
 * domain. The old address can stay as an alias so mail sent to it still
 * arrives and replies can come from it. One of the person's own aliases can
 * be promoted. Signatures and the default From follow the address.
 */
export function renameUser(userId: number, newEmail: string, opts: { keepOldAsAlias: boolean }): { from: string; to: string } {
  const user = getUser(userId);
  if (!user) throw badRequest('Unknown user');
  const from = user.email.toLowerCase();
  const to = normalizeEmail(newEmail);
  if (!isEmail(to)) throw badRequest('Enter a valid address');
  if (to === from) throw badRequest('That’s already their address');
  if (!/^[a-z0-9._+-]+$/i.test(localPart(to))) throw badRequest('Address may only contain letters, numbers, dots, dashes, underscores and plus');
  const domain = findDomain(domainOf(to));
  if (!domain) throw badRequest(`Domain ${domainOf(to)} is not hosted on this server`);
  const existing = get<{ id: number; kind: string; user_id: number | null }>('SELECT id, kind, user_id FROM addresses WHERE address = ?', [to]);
  const ownAlias = existing?.kind === 'alias' && existing.user_id === userId;
  if ((existing && !ownAlias) || get('SELECT 1 FROM users WHERE email = ? AND id != ?', [to, userId])) throw conflict('That address is already taken');

  tx(() => {
    if (ownAlias) run('DELETE FROM addresses WHERE id = ?', [existing!.id]);
    run('UPDATE users SET email = ? WHERE id = ?', [to, userId]);
    const mailbox = get<{ id: number }>(`SELECT id FROM addresses WHERE user_id = ? AND kind = 'mailbox'`, [userId]);
    if (mailbox) run('UPDATE addresses SET address = ?, domain_id = ? WHERE id = ?', [to, domain.id, mailbox.id]);
    else insert(`INSERT INTO addresses (address, domain_id, kind, user_id, name, created_at) VALUES (?, ?, 'mailbox', ?, ?, ?)`, [to, domain.id, userId, user.name, now()]);
    if (opts.keepOldAsAlias) {
      const oldDomain = findDomain(domainOf(from));
      if (oldDomain) {
        insert(`INSERT INTO addresses (address, domain_id, kind, user_id, name, description, created_at) VALUES (?, ?, 'alias', ?, ?, ?, ?)`, [
          from,
          oldDomain.id,
          userId,
          user.name,
          `Previous address (until ${new Date().toISOString().slice(0, 10)})`,
          now(),
        ]);
      }
    }
    // Per-address settings move to the new address.
    const prefs = parsePrefs(user.prefs);
    if (prefs.signatures[from] !== undefined) {
      prefs.signatures[to] = prefs.signatures[from];
      if (!opts.keepOldAsAlias) delete prefs.signatures[from];
    }
    if (prefs.defaultFrom.toLowerCase() === from) prefs.defaultFrom = '';
    savePrefs(userId, prefs);
    run('DELETE FROM login_attempts WHERE key = ?', [`login:user:${from}`]);
  });
  return { from, to };
}
