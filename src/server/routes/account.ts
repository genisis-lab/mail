import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_PREFS } from '../../shared/types.js';
import { all, get, insert, now, run } from '../db/index.js';
import { decrypt, encrypt, generateTotpSecret, hashPassword, randomToken, sha256, totpUri, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { badRequest, notFound, unauthorized } from '../lib/http.js';
import { isEmail } from '../lib/addr.js';
import { getSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { getPrefs, getUser, identities, savePrefs, sessionUser, userAddresses, validatePassword } from '../services/users.js';
import { sendRecoveryVerification } from '../services/account-links.js';
import { body, clientIp, intParam, rateLimit, type AppEnv } from '../http/context.js';

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.put('/profile', async (c) => {
  const user = c.get('user');
  const { name } = await body(c, z.object({ name: z.string().min(1).max(100) }));
  run('UPDATE users SET name = ? WHERE id = ?', [name.trim(), user.id]);
  run(`UPDATE addresses SET name = ? WHERE user_id = ? AND kind = 'mailbox'`, [name.trim(), user.id]);
  return c.json({ user: sessionUser(getUser(user.id)!) });
});

const prefsSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
    signature: z.string().max(20_000),
    signatureOnReplies: z.boolean(),
    showImages: z.enum(['ask', 'always']),
    undoSendSeconds: z.number().int().min(0).max(30),
    pageSize: z.number().int().min(10).max(200),
    keyboardShortcuts: z.boolean(),
    defaultFrom: z.string().max(254),
    readingPane: z.boolean(),
    vacation: z.object({
      enabled: z.boolean(),
      subject: z.string().max(200),
      message: z.string().max(20_000),
      startAt: z.number().nullable(),
      endAt: z.number().nullable(),
      contactsOnly: z.boolean(),
    }),
    forwarding: z.object({
      enabled: z.boolean(),
      to: z.string().max(254),
      keep: z.enum(['inbox', 'archive', 'read', 'trash']),
    }),
  })
  .partial();

accountRoutes.put('/prefs', async (c) => {
  const user = c.get('user');
  const patch = await body(c, prefsSchema);
  const current = getPrefs(user.id);
  const next = {
    ...current,
    ...patch,
    vacation: { ...current.vacation, ...(patch.vacation ?? {}) },
    forwarding: { ...current.forwarding, ...(patch.forwarding ?? {}) },
  };
  if (next.forwarding.enabled) {
    if (!getSettings()['mail.allowExternalForwarding']) throw badRequest('Forwarding is disabled by your administrator');
    if (!isEmail(next.forwarding.to)) throw badRequest('Enter a valid forwarding address');
  }
  if (next.defaultFrom && !identities(user.id).some((i) => i.address === next.defaultFrom)) next.defaultFrom = '';
  savePrefs(user.id, next);
  if (patch.forwarding) audit(user.id, 'account.forwarding', next.forwarding.enabled ? next.forwarding.to : 'disabled', undefined, clientIp(c));
  return c.json({ prefs: next });
});

accountRoutes.post('/prefs/reset', (c) => {
  savePrefs(c.get('user').id, DEFAULT_PREFS);
  return c.json({ prefs: DEFAULT_PREFS });
});

accountRoutes.post('/password', async (c) => {
  const user = c.get('user');
  const { current, next } = await body(c, z.object({ current: z.string().min(1), next: z.string().min(1) }));
  if (!(await verifyPassword(current, user.password_hash))) throw unauthorized('Current password is incorrect');
  validatePassword(next);
  run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [await hashPassword(next), now(), user.id]);
  // Sign out every other session.
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [user.id, c.get('session')?.id ?? '']);
  audit(user.id, 'account.password_changed', user.email, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ── Recovery email (for "Forgot password?") ─────────────────────────────────

accountRoutes.get('/recovery', (c) => {
  const u = getUser(c.get('user').id)!;
  return c.json({ email: u.recovery_email, verified: !!u.recovery_verified_at });
});

accountRoutes.put('/recovery', async (c) => {
  const user = getUser(c.get('user').id)!;
  const input = await body(c, z.object({ email: z.string().max(254), password: z.string().min(1).max(256) }));
  if (!(await verifyPassword(input.password, user.password_hash))) throw unauthorized('Password is incorrect');
  const email = input.email.trim().toLowerCase();
  if (!isEmail(email)) throw badRequest('Enter a valid email address');
  if (userAddresses(user.id).includes(email)) throw badRequest('Use an address outside this mailbox, so you can still reach it if you’re locked out');
  rateLimit(`recovery:${user.id}`, 5, 60 * 60_000);
  run('UPDATE users SET recovery_email = ?, recovery_verified_at = NULL WHERE id = ?', [email, user.id]);
  await sendRecoveryVerification(user, email);
  audit(user.id, 'account.recovery_set', email, undefined, clientIp(c));
  return c.json({ email, verified: false });
});

accountRoutes.post('/recovery/resend', async (c) => {
  const user = getUser(c.get('user').id)!;
  if (!user.recovery_email || user.recovery_verified_at) throw badRequest('Nothing to confirm');
  rateLimit(`recovery:${user.id}`, 5, 60 * 60_000);
  await sendRecoveryVerification(user, user.recovery_email);
  return c.json({ ok: true });
});

accountRoutes.delete('/recovery', async (c) => {
  const user = getUser(c.get('user').id)!;
  const { password } = await body(c, z.object({ password: z.string().min(1).max(256) }));
  if (!(await verifyPassword(password, user.password_hash))) throw unauthorized('Password is incorrect');
  run('UPDATE users SET recovery_email = NULL, recovery_verified_at = NULL WHERE id = ?', [user.id]);
  audit(user.id, 'account.recovery_removed', user.email, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ── Sessions ────────────────────────────────────────────────────────────────

accountRoutes.get('/sessions', (c) => {
  const user = c.get('user');
  const current = c.get('session')?.id;
  const rows = all<any>('SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC', [
    user.id,
  ]);
  return c.json({
    sessions: rows.map((r) => ({
      id: r.id.slice(0, 16),
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      current: r.id === current,
    })),
  });
});

accountRoutes.delete('/sessions/:id', (c) => {
  const user = c.get('user');
  const prefix = c.req.param('id');
  if (!/^[a-f0-9]{16}$/.test(prefix)) throw badRequest('Invalid session');
  run(`DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?`, [user.id, prefix]);
  return c.json({ ok: true });
});

accountRoutes.post('/sessions/revoke-others', (c) => {
  const user = c.get('user');
  const r = run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [user.id, c.get('session')?.id ?? '']);
  return c.json({ revoked: r.changes });
});

// ── Two-factor authentication ───────────────────────────────────────────────

accountRoutes.post('/2fa/setup', (c) => {
  const user = c.get('user');
  if (user.totp_enabled) throw badRequest('Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  run('UPDATE users SET totp_secret = ? WHERE id = ?', [encrypt(secret), user.id]);
  return c.json({ secret, uri: totpUri(secret, user.email, getSettings()['instance.name']) });
});

accountRoutes.post('/2fa/enable', async (c) => {
  const user = getUser(c.get('user').id)!;
  const { code } = await body(c, z.object({ code: z.string().min(6).max(10) }));
  if (!user.totp_secret) throw badRequest('Start setup first');
  if (!verifyTotp(decrypt(user.totp_secret), code)) throw badRequest('That code is not valid. Check your device clock and try again.');
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase().padEnd(8, '0'));
  run('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', [JSON.stringify(codes.map((x) => sha256(x))), user.id]);
  audit(user.id, 'account.2fa_enabled', user.email, undefined, clientIp(c));
  return c.json({ recoveryCodes: codes.map((x) => `${x.slice(0, 4)}-${x.slice(4)}`) });
});

accountRoutes.post('/2fa/disable', async (c) => {
  const user = c.get('user');
  const { password } = await body(c, z.object({ password: z.string().min(1) }));
  if (!(await verifyPassword(password, user.password_hash))) throw unauthorized('Password is incorrect');
  const policy = getSettings()['security.require2fa'];
  if (policy === 'all' || (policy === 'admins' && user.role !== 'user')) throw badRequest('Your administrator requires two-factor authentication');
  run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?', [user.id]);
  audit(user.id, 'account.2fa_disabled', user.email, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ── API keys (also usable as SMTP submission passwords) ─────────────────────

accountRoutes.get('/api-keys', (c) => {
  const rows = all<any>('SELECT id, name, prefix, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [c.get('user').id]);
  return c.json({ keys: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, lastUsedAt: r.last_used_at, createdAt: r.created_at })) });
});

accountRoutes.post('/api-keys', async (c) => {
  const user = c.get('user');
  const { name } = await body(c, z.object({ name: z.string().min(1).max(60) }));
  if ((get<{ c: number }>('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?', [user.id])?.c ?? 0) >= 20) throw badRequest('You can have at most 20 API keys');
  const key = `wren_${randomToken(24)}`;
  const id = insert('INSERT INTO api_keys (user_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)', [user.id, name, key.slice(0, 10), sha256(key), now()]);
  audit(user.id, 'account.api_key_created', name, undefined, clientIp(c));
  return c.json({ id, key });
});

accountRoutes.delete('/api-keys/:id', (c) => {
  const r = run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

