import { Hono } from 'hono';
import { z } from 'zod';
import { APP_NAME, APP_VERSION } from '../../shared/brand.js';
import { get, insert, now, run } from '../db/index.js';
import { decrypt, hashPassword, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/http.js';
import { normalizeEmail } from '../lib/addr.js';
import { getSettings, setSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { createProvider } from '../services/providers.js';
import { platform } from '../platform.js';
import { createUser, getUserByEmail, sessionUser, getUser, validatePassword } from '../services/users.js';
import { markRecoveryVerified, sendPasswordReset, welcomeUser } from '../services/account-links.js';
import { consumeToken, peekToken } from '../services/tokens.js';
import { body, clearRateLimit, clientIp, createSession, destroySession, getPendingSession, rateLimit, SESSION_COOKIE, type AppEnv } from '../http/context.js';
import { getCookie } from 'hono/cookie';
import { finishLogin, loginOptions } from '../services/passkeys.js';
import { noteSignIn } from '../services/signin-alerts.js';
import { WebAuthnError } from '../lib/webauthn.js';

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
  const found = getUserByEmail(email);
  // Shared mailboxes have no password of their own; members open them from their account.
  const user = found && found.kind !== 'shared' ? found : undefined;
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
  await noteSignIn(c, user, 'your password');
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
  await noteSignIn(c, user, pending.passkey ? 'a passkey and 2-step verification' : 'your password and 2-step verification');
  return c.json({ user: sessionUser(user) });
});

// ── Passkeys ────────────────────────────────────────────────────────────────

authRoutes.post('/passkey/options', async (c) => {
  const { email } = await body(c, z.object({ email: z.string().max(254).optional() }));
  rateLimit(`passkey:ip:${clientIp(c)}`, 60, 15 * 60_000);
  return c.json(loginOptions(email?.trim() || undefined));
});

const assertionSchema = z.object({
  id: z.string().min(8).max(1400),
  response: z.object({ clientDataJSON: z.string().max(4000), authenticatorData: z.string().max(4000), signature: z.string().max(2000), userHandle: z.string().max(400).nullish() }),
});

authRoutes.post('/passkey', async (c) => {
  const input = await body(c, assertionSchema);
  const ip = clientIp(c);
  rateLimit(`passkey:ip:${ip}`, 60, 15 * 60_000);
  let result;
  try {
    result = await finishLogin(input);
  } catch (err) {
    if (err instanceof WebAuthnError) {
      audit(null, 'auth.login_failed', 'passkey', { reason: err.message }, ip);
      throw unauthorized(err.message);
    }
    throw err;
  }
  const { user, userVerified, passkeyName } = result;
  if (user.kind === 'shared') throw unauthorized('Shared mailboxes can’t sign in');
  if (user.status !== 'active') throw forbidden('This account is suspended. Contact your administrator.');
  // A passkey that checked a PIN or biometric is two factors; one that didn't still needs the 2-step code.
  if (user.totp_enabled && !userVerified) {
    createSession(c, user.id, true, true);
    return c.json({ mfaRequired: true });
  }
  createSession(c, user.id);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  audit(user.id, 'auth.login', user.email, { passkey: passkeyName }, ip);
  await noteSignIn(c, user, 'a passkey');
  return c.json({ user: sessionUser(user) });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

// ── Password reset & account setup links ────────────────────────────────────

authRoutes.post('/forgot', async (c) => {
  const { email } = await body(c, z.object({ email: z.string().min(3).max(254) }));
  const ip = clientIp(c);
  rateLimit(`forgot:ip:${ip}`, 10, 60 * 60_000);
  rateLimit(`forgot:user:${normalizeEmail(email)}`, 3, 60 * 60_000);
  const user = getUserByEmail(email);
  // Same answer whether or not the account exists, so this can't be used to probe addresses.
  if (user && user.kind === 'person' && user.status === 'active' && user.recovery_email && user.recovery_verified_at) {
    await sendPasswordReset(user, user.recovery_email);
    audit(user.id, 'auth.reset_requested', user.email, undefined, ip);
  } else {
    audit(user?.id ?? null, 'auth.reset_requested_unavailable', normalizeEmail(email), undefined, ip);
  }
  return c.json({ ok: true });
});

authRoutes.get('/reset/:token', (c) => {
  const row = peekToken(c.req.param('token'), ['reset', 'setup']);
  const user = row ? getUser(row.user_id) : undefined;
  if (!row || !user || user.status !== 'active') return c.json({ valid: false });
  return c.json({ valid: true, kind: row.kind, email: user.email, name: user.name });
});

authRoutes.post('/reset', async (c) => {
  const input = await body(c, z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(256) }));
  rateLimit(`reset:${clientIp(c)}`, 20, 60 * 60_000);
  const pending = peekToken(input.token, ['reset', 'setup']);
  if (!pending) throw badRequest('This link is invalid or has expired. Ask for a new one.');
  validatePassword(input.password);
  const row = consumeToken(input.token, ['reset', 'setup']);
  const user = row ? getUser(row.user_id) : undefined;
  if (!row || !user || user.status !== 'active') throw badRequest('This link is invalid or has expired. Ask for a new one.');
  run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [await hashPassword(input.password), now(), user.id]);
  run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  // A setup link sent to a personal address proves that address works: keep it for recovery.
  const sentTo = row.data ? (JSON.parse(row.data) as { email?: string | null }).email : null;
  if (row.kind === 'setup' && sentTo) markRecoveryVerified(user.id, sentTo);
  audit(user.id, row.kind === 'setup' ? 'auth.account_setup' : 'auth.password_reset', user.email, undefined, clientIp(c));
  if (user.totp_enabled) return c.json({ ok: true, signedIn: false });
  createSession(c, user.id);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  return c.json({ ok: true, signedIn: true, user: sessionUser(getUser(user.id)!) });
});

authRoutes.post('/verify-recovery', async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(20).max(100) }));
  const row = consumeToken(token, ['verify_recovery']);
  const email = row?.data ? (JSON.parse(row.data) as { email: string }).email : null;
  const user = row ? getUser(row.user_id) : undefined;
  if (!row || !user || !email || (user.recovery_email ?? '').toLowerCase() !== email.toLowerCase()) {
    throw badRequest('This link is invalid or has expired.');
  }
  markRecoveryVerified(user.id, email);
  audit(user.id, 'account.recovery_verified', email, undefined, clientIp(c));
  return c.json({ ok: true, email });
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
  let inviteSentTo: string | null = null;
  if (input.invite) {
    const inv = get<any>('SELECT i.*, d.name AS domain FROM invites i LEFT JOIN domains d ON d.id = i.domain_id WHERE i.token_hash = ?', [sha256(input.invite)]);
    if (!inv || inv.used_at || inv.expires_at < now()) throw badRequest('This invitation is invalid or has expired');
    if (inv.email && normalizeEmail(inv.email) !== email) throw badRequest(`This invitation is for ${inv.email}`);
    if (inv.domain && inv.domain.toLowerCase() !== input.domain.toLowerCase()) throw badRequest(`This invitation is for @${inv.domain}`);
    role = inv.role === 'admin' ? 'admin' : 'user';
    inviteId = inv.id;
    inviteSentTo = inv.sent_to ?? null;
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
  // The invitation link reached this address, so it's a proven way to recover the account.
  if (inviteSentTo) markRecoveryVerified(id, inviteSentTo);
  await welcomeUser(id);
  audit(id, 'auth.register', email, { invite: !!inviteId }, clientIp(c));
  createSession(c, id);
  return c.json({ user: sessionUser(getUser(id)!) });
});

// ── First-run setup ─────────────────────────────────────────────────────────

export const setupRoutes = new Hono<AppEnv>();

/** The Cloudflare Email Service binding (when deployed on Cloudflare), offered as the zero-config sender. */
function cloudflareEmailBinding(): string | null {
  const names = platform().emailBindings?.() ?? [];
  return names.includes('EMAIL') ? 'EMAIL' : (names[0] ?? null);
}

setupRoutes.get('/', (c) => c.json({ needed: !get('SELECT 1 FROM users LIMIT 1'), cloudflareEmail: !!cloudflareEmailBinding() }));

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
      email: z
        .object({ provider: z.enum(['cloudflare', 'resend', 'later']), apiKey: z.string().max(300).optional() })
        .default({ provider: 'later' }),
    }),
  );
  const binding = cloudflareEmailBinding();
  if (input.email.provider === 'cloudflare' && !binding) throw badRequest('This Worker has no Cloudflare email binding. Choose another provider or set it up later.');
  if (input.email.provider === 'resend' && !input.email.apiKey?.trim()) throw badRequest('Enter your Resend API key');
  const domain = input.domain.toLowerCase();
  insert('INSERT INTO domains (name, verify_token, created_at) VALUES (?, ?, ?)', [domain, randomToken(12), now()]);
  const id = await createUser({ email: `${input.localPart}@${domain}`, name: input.name, password: input.password, role: 'owner' });
  setSettings({ 'instance.name': input.instanceName, 'instance.setupComplete': true });
  await welcomeUser(id);
  if (input.email.provider === 'cloudflare') {
    createProvider({ name: 'Cloudflare Email Service', type: 'cloudflare-binding', config: { binding }, isDefault: true });
  } else if (input.email.provider === 'resend') {
    createProvider({ name: 'Resend', type: 'resend', config: { apiKey: input.email.apiKey }, isDefault: true });
  }
  audit(id, 'setup.complete', domain, undefined, clientIp(c));
  createSession(c, id);
  return c.json({ user: sessionUser(getUser(id)!) });
});

