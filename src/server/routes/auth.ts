import { Hono } from 'hono';
import { z } from 'zod';
import { APP_NAME, APP_VERSION } from '../../shared/brand.js';
import { get, insert, now, run } from '../db/index.js';
import { config } from '../config.js';
import { decrypt, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/http.js';
import { normalizeEmail } from '../lib/addr.js';
import { getSettings, setSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { createUser, getUserByEmail, sessionUser, getUser } from '../services/users.js';
import { body, clearRateLimit, clientIp, createSession, destroySession, getPendingSession, rateLimit, SESSION_COOKIE, type AppEnv } from '../http/context.js';
import { getCookie } from 'hono/cookie';

export const authRoutes = new Hono<AppEnv>();

function instanceInfo() {
  const s = getSettings();
  const domains = s['registration.mode'] === 'open'
    ? (s['registration.domains'].length
        ? s['registration.domains'].map((id) => get<{ name: string }>('SELECT name FROM domains WHERE id = ? AND enabled = 1', [id])?.name).filter(Boolean)
        : [])
    : [];
  return {
    name: s['instance.name'] || APP_NAME,
    accent: s['instance.accent'],
    loginMessage: s['instance.loginMessage'],
    registration: s['registration.mode'],
    registrationDomains: domains,
    setupComplete: s['instance.setupComplete'] || !!get('SELECT 1 FROM users LIMIT 1'),
    retention: { trashDays: s['retention.trashDays'], spamDays: s['retention.spamDays'] },
    version: APP_VERSION,
    platform: config.platform,
  };
}

authRoutes.get('/me', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  let user = null;
  let mfaPending = false;
  if (token) {
    const s = get<{ user_id: number; mfa_pending: number; expires_at: number }>('SELECT user_id, mfa_pending, expires_at FROM sessions WHERE id = ?', [sha256(token)]);
    if (s && s.expires_at > now()) {
      const u = getUser(s.user_id);
      if (u && u.status === 'active') {
        if (s.mfa_pending) mfaPending = true;
        else user = sessionUser(u);
      }
    }
  }
  return c.json({ user, mfaPending, instance: instanceInfo() });
});

authRoutes.post('/login', async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) }));
  const ip = clientIp(c);
  const max = getSettings()['security.maxLoginAttempts'];
  rateLimit(`login:ip:${ip}`, max * 3, 15 * 60_000);
  rateLimit(`login:user:${normalizeEmail(email)}`, max, 15 * 60_000);
  const user = getUserByEmail(email);
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
  if (!user || !ok) {
    audit(user?.id ?? null, 'auth.login_failed', normalizeEmail(email), undefined, ip);
    throw unauthorized('Incorrect email or password');
  }
  if (user.status !== 'active') throw forbidden('This account is suspended. Contact your administrator.');
  clearRateLimit(`login:user:${normalizeEmail(email)}`);
  if (user.totp_enabled) {
    createSession(c, user.id, true);
    return c.json({ mfaRequired: true });
  }
  createSession(c, user.id);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  audit(user.id, 'auth.login', user.email, undefined, ip);
  return c.json({ user: sessionUser(user) });
});

authRoutes.post('/mfa', async (c) => {
  const { code } = await body(c, z.object({ code: z.string().min(6).max(32) }));
  const pending = getPendingSession(c);
  if (!pending) throw unauthorized('Your sign-in expired. Please start again.');
  rateLimit(`mfa:${pending.user.id}`, 8, 15 * 60_000);
  const { user, session } = pending;
  let ok = false;
  if (user.totp_secret) ok = verifyTotp(decrypt(user.totp_secret), code);
  if (!ok && user.recovery_codes) {
    const codes: string[] = JSON.parse(user.recovery_codes);
    const h = sha256(code.replace(/[\s-]/g, '').toLowerCase());
    if (codes.includes(h)) {
      ok = true;
      run('UPDATE users SET recovery_codes = ? WHERE id = ?', [JSON.stringify(codes.filter((x) => x !== h)), user.id]);
      audit(user.id, 'auth.recovery_code_used', user.email, undefined, clientIp(c));
    }
  }
  if (!ok) throw unauthorized('That code is not valid');
  clearRateLimit(`mfa:${user.id}`);
  run('DELETE FROM sessions WHERE id = ?', [session.id]);
  createSession(c, user.id);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  audit(user.id, 'auth.login', user.email, { mfa: true }, clientIp(c));
  return c.json({ user: sessionUser(user) });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/invite/:token', (c) => {
  const inv = get<any>(
    `SELECT i.email, i.role, i.expires_at, i.used_at, d.name AS domain FROM invites i LEFT JOIN domains d ON d.id = i.domain_id WHERE i.token_hash = ?`,
    [sha256(c.req.param('token'))],
  );
  if (!inv || inv.used_at || inv.expires_at < now()) return c.json({ valid: false });
  return c.json({ valid: true, email: inv.email, domain: inv.domain, role: inv.role });
});

authRoutes.post('/register', async (c) => {
  const input = await body(
    c,
    z.object({
      localPart: z.string().min(1).max(64),
      domain: z.string().min(3).max(253),
      name: z.string().min(1).max(100),
      password: z.string().min(1).max(256),
      invite: z.string().optional(),
    }),
  );
  rateLimit(`register:${clientIp(c)}`, 10, 60 * 60_000);
  const s = getSettings();
  const email = normalizeEmail(`${input.localPart}@${input.domain}`);
  let role: 'user' | 'admin' = 'user';
  let inviteId: number | null = null;
  if (input.invite) {
    const inv = get<any>('SELECT i.*, d.name AS domain FROM invites i LEFT JOIN domains d ON d.id = i.domain_id WHERE i.token_hash = ?', [sha256(input.invite)]);
    if (!inv || inv.used_at || inv.expires_at < now()) throw badRequest('This invitation is invalid or has expired');
    if (inv.email && normalizeEmail(inv.email) !== email) throw badRequest(`This invitation is for ${inv.email}`);
    if (inv.domain && inv.domain.toLowerCase() !== input.domain.toLowerCase()) throw badRequest(`This invitation is for @${inv.domain}`);
    role = inv.role === 'admin' ? 'admin' : 'user';
    inviteId = inv.id;
  } else if (s['registration.mode'] === 'open') {
    const allowed = s['registration.domains'].map((id) => get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [id])?.name?.toLowerCase());
    if (!allowed.includes(input.domain.toLowerCase())) throw forbidden('Registration is not open for that domain');
  } else {
    throw forbidden('Registration is closed. Ask an administrator for an invitation.');
  }
  if (/^(postmaster|abuse|admin|administrator|root|hostmaster|webmaster|mailer-daemon|noreply|no-reply|security)$/i.test(input.localPart) && !inviteId) {
    throw conflict('That address is reserved');
  }
  const id = await createUser({ email, name: input.name, password: input.password, role });
  if (inviteId) run('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?', [now(), id, inviteId]);
  audit(id, 'auth.register', email, { invite: !!inviteId }, clientIp(c));
  createSession(c, id);
  return c.json({ user: sessionUser(getUser(id)!) });
});

// ── First-run setup ─────────────────────────────────────────────────────────

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get('/', (c) => c.json({ needed: !get('SELECT 1 FROM users LIMIT 1') }));

setupRoutes.post('/', async (c) => {
  if (get('SELECT 1 FROM users LIMIT 1')) throw forbidden('Setup has already been completed');
  const input = await body(
    c,
    z.object({
      instanceName: z.string().min(1).max(60),
      domain: z
        .string()
        .min(3)
        .max(253)
        .regex(/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i, 'Enter a valid domain like example.com'),
      localPart: z.string().min(1).max(64),
      name: z.string().min(1).max(100),
      password: z.string().min(1).max(256),
    }),
  );
  const domain = input.domain.toLowerCase();
  insert('INSERT INTO domains (name, verify_token, created_at) VALUES (?, ?, ?)', [domain, randomToken(12), now()]);
  const id = await createUser({ email: `${input.localPart}@${domain}`, name: input.name, password: input.password, role: 'owner' });
  setSettings({ 'instance.name': input.instanceName, 'instance.setupComplete': true });
  audit(id, 'setup.complete', domain, undefined, clientIp(c));
  createSession(c, id);
  return c.json({ user: sessionUser(getUser(id)!) });
});

