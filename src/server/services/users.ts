import { DEFAULT_PREFS, type Identity, type Role, type SessionUser, type UserPrefs } from '../../shared/types.js';
import { all, get, insert, now, run, tx } from '../db/index.js';
import { decrypt, hashPassword, sha256, verifyTotp } from '../lib/crypto.js';
import { domainOf, isEmail, localPart, normalizeEmail } from '../lib/addr.js';
import { badRequest, conflict } from '../lib/http.js';
import { getSettings } from '../settings.js';
import { purgeMessages } from '../mail/store.js';
import { closeUserStreams } from '../jmap/push.js';
import { audit } from './audit.js';

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
  password_change_required_at: number | null;
  avatar_blob: string | null;
  avatar_type: string | null;
  avatar_at: number | null;
  /** An admin turned mail apps (JMAP) off for this person. */
  mail_apps_blocked: number;
  /** Sending paused (the compromised-account guard or an admin); see send-guard.ts. */
  send_paused_at: number | null;
  send_paused_reason: string | null;
  /** When an admin last resumed it: the guard only counts what was sent since. */
  send_resumed_at: number | null;
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

/** An admin required a new password, and it hasn't been changed since (any way: settings, reset link, admin). */
export function mustChangePassword(user: Pick<UserRow, 'password_change_required_at' | 'password_changed_at'>): boolean {
  return !!user.password_change_required_at && (user.password_changed_at ?? 0) <= user.password_change_required_at;
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
    mustChangePassword: mustChangePassword(user),
    hasAvatar: !!user.avatar_blob,
    avatarAt: user.avatar_at,
    sendPaused: !!user.send_paused_at,
  };
}

/** A 2-step code from their authenticator app, or one of their recovery codes (each works once). */
export function checkTwoStepCode(user: UserRow, code: string, ip: string | null): boolean {
  if (user.totp_secret && verifyTotp(decrypt(user.totp_secret), code)) return true;
  if (!user.recovery_codes) return false;
  const codes: string[] = JSON.parse(user.recovery_codes);
  const h = sha256(code.replace(/[\s-]/g, '').toLowerCase());
  if (!codes.includes(h)) return false;
  run('UPDATE users SET recovery_codes = ? WHERE id = ?', [JSON.stringify(codes.filter((x) => x !== h)), user.id]);
  audit(user.id, 'auth.recovery_code_used', user.email, undefined, ip);
  return true;
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

/**
 * Delete an account and everything in it (mail, contacts, labels, filters,
 * keys, sessions, passkeys). Its addresses are freed, or become aliases of
 * `handTo` so mail sent to them keeps arriving. Stored files are
 * garbage-collected later, as usual. Says how many addresses moved.
 */
export function deleteUser(id: number, handTo?: UserRow | null): number {
  purgeMessages(all<{ id: number }>('SELECT id FROM messages WHERE user_id = ?', [id]).map((r) => r.id));
  const moved = tx(() => {
    // The inbound log has no user id and is kept 90 days: blank what it says about their mail.
    // Rows are matched by the address mail was delivered to: user+tag@ counts as user@ (unless that's
    // someone's own address), and mail their catch-all took is any address on the domain nobody owns.
    run(
      `WITH log AS (
         SELECT id, lower(substr(rcpt_to, instr(rcpt_to, '@') + 1)) AS dom,
           CASE WHEN instr(rcpt_to, '+') > 1 AND instr(rcpt_to, '+') < instr(rcpt_to, '@')
                 AND lower(rcpt_to) NOT IN (SELECT lower(address) FROM addresses)
             THEN lower(substr(rcpt_to, 1, instr(rcpt_to, '+') - 1) || substr(rcpt_to, instr(rcpt_to, '@')))
             ELSE lower(rcpt_to) END AS rcpt
         FROM inbound_log)
       UPDATE inbound_log SET subject = '', mail_from = '' WHERE id IN (
         SELECT id FROM log
         WHERE rcpt IN (SELECT lower(address) FROM addresses WHERE user_id = ?)
            OR (dom IN (SELECT lower(name) FROM domains WHERE catch_all_user_id = ?) AND rcpt NOT IN (SELECT lower(address) FROM addresses)))`,
      [id, id],
    );
    const n = handTo ? run(`UPDATE addresses SET user_id = ?, kind = 'alias', name = ?, created_by = NULL WHERE user_id = ?`, [handTo.id, handTo.name, id]).changes : 0;
    if (handTo) run('UPDATE domains SET catch_all_user_id = ? WHERE catch_all_user_id = ?', [handTo.id, id]);
    run('DELETE FROM users WHERE id = ?', [id]);
    return n;
  });
  closeUserStreams(id);
  return moved;
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
