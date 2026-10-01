import { Hono } from 'hono';
import { z } from 'zod';
import { APP_VERSION } from '../../shared/brand.js';
import { config } from '../config.js';
import { all, get, insert, now, placeholders, run, tx } from '../db/index.js';
import { platform } from '../platform.js';
import { encryptJson, hashPassword, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { domainOf, isEmail, normalizeEmail } from '../lib/addr.js';
import { DEFAULT_SETTINGS, getSettings, setSettings, type Settings } from '../settings.js';
import { audit } from '../services/audit.js';
import { createUser, getUser, quotaBytes, sendLimit, validatePassword } from '../services/users.js';
import { checkDomainDns, recommendedRecords, smtpHostname } from '../services/dns.js';
import { getProviderDef, listProviderTypes } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { blobStoreSize, putBlob } from '../mail/blobs.js';
import { buildMime } from '../mail/compose.js';
import { enqueue, loadProvider, processQueue, providerContext, retryOutbox, toOutboundEmail } from '../mail/outbound.js';
import { purgeMessages } from '../mail/store.js';
import { body, clientIp, intParam, type AppEnv } from '../http/context.js';

export const adminRoutes = new Hono<AppEnv>();
// Set by createApp(): Workers freeze Date.now() at module load.
export const runtimeInfo = { startedAt: 0 };
const MASK = '••••••••';

function act(c: any, action: string, target: string, details?: unknown) {
  audit(c.get('user').id, action, target, details, clientIp(c));
}

// ── Overview ────────────────────────────────────────────────────────────────

let storageCache: { at: number; blobs: number } | null = null;
async function storage() {
  if (!storageCache || Date.now() - storageCache.at > 5 * 60_000) {
    storageCache = { at: Date.now(), blobs: await blobStoreSize().catch(() => 0) };
  }
  return { database: platform().databaseSize(), blobs: storageCache.blobs };
}

adminRoutes.get('/overview', async (c) => {
  const ts = now();
  const day = 86_400_000;
  const users = get<any>(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'suspended') AS suspended, SUM(role != 'user') AS admins FROM users`);
  const domains = get<any>('SELECT COUNT(*) AS total, SUM(verified_at IS NOT NULL) AS verified, SUM(enabled) AS enabled FROM domains');
  const since = ts - 14 * day;
  const startOfDay = (t: number) => Math.floor(t / day) * day;
  const inbound = all<{ d: number; c: number }>(
    `SELECT (created_at / ${day}) * ${day} AS d, COUNT(*) AS c FROM messages WHERE direction = 'in' AND source NOT IN ('system') AND created_at >= ? GROUP BY d`,
    [startOfDay(since)],
  );
  const outbound = all<{ d: number; c: number; f: number }>(
    `SELECT (updated_at / ${day}) * ${day} AS d, SUM(status = 'sent') AS c, SUM(status = 'failed') AS f FROM outbox WHERE updated_at >= ? GROUP BY d`,
    [startOfDay(since)],
  );
  const series = [];
  for (let t = startOfDay(since) + day; t <= startOfDay(ts); t += day) {
    series.push({
      date: t,
      received: inbound.find((r) => r.d === t)?.c ?? 0,
      sent: outbound.find((r) => r.d === t)?.c ?? 0,
      failed: outbound.find((r) => r.d === t)?.f ?? 0,
    });
  }
  const queue = get<any>(`SELECT SUM(status = 'queued') AS queued, SUM(status = 'sending') AS sending, SUM(status = 'failed' AND updated_at > ?) AS failed24h FROM outbox`, [ts - day]);
  const last24 = {
    received: get<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND source != 'system' AND created_at > ?`, [ts - day])?.c ?? 0,
    sent: get<{ c: number }>(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'sent' AND updated_at > ?`, [ts - day])?.c ?? 0,
    rejected: get<{ c: number }>(`SELECT COUNT(*) AS c FROM inbound_log WHERE status = 'rejected' AND created_at > ?`, [ts - day])?.c ?? 0,
    spam: get<{ c: number }>(`SELECT COUNT(*) AS c FROM inbound_log WHERE status = 'spam' AND created_at > ?`, [ts - day])?.c ?? 0,
  };
  const providers = all<any>('SELECT id, name, type, enabled, is_default, sent_count, failed_count, received_count, last_used_at, last_error, last_error_at FROM providers ORDER BY name');

  const warnings: { level: 'info' | 'warn'; message: string; link?: string }[] = [];
  const hasOutbound = providers.some((p) => p.enabled && getProviderDef(p.type)?.send);
  if (!domains?.total) warnings.push({ level: 'warn', message: 'Add your first domain to start hosting mail.', link: '/admin/domains' });
  if (!hasOutbound) warnings.push({ level: 'warn', message: 'No outbound provider is configured — mail to external addresses cannot be sent.', link: '/admin/providers' });
  else if (!providers.some((p) => p.is_default) && all('SELECT 1 FROM domains WHERE provider_id IS NULL').length)
    warnings.push({ level: 'info', message: 'Some domains have no provider and there is no default provider.', link: '/admin/domains' });
  if (config.platform === 'node' && typeof process !== 'undefined' && !process.env.WREN_SECRET) warnings.push({ level: 'info', message: 'WREN_SECRET is auto-generated in the data directory. Back it up, or set it explicitly.' });
  if (config.publicUrl.includes('localhost')) warnings.push({ level: 'info', message: 'PUBLIC_URL is localhost — inbound webhook URLs will not be reachable by providers.' });

  return c.json({
    version: APP_VERSION,
    uptime: Date.now() - runtimeInfo.startedAt,
    users,
    domains,
    series,
    queue,
    last24,
    providers: providers.map((p) => ({ ...p, typeName: getProviderDef(p.type)?.name ?? p.type })),
    storage: await storage(),
    warnings,
  });
});

adminRoutes.get('/system', async (c) =>
  c.json({
    version: APP_VERSION,
    runtime: config.platform,
    uptime: Date.now() - runtimeInfo.startedAt,
    publicUrl: config.publicUrl,
    smtp: { enabled: config.smtp.enabled, port: config.smtp.port, hostname: smtpHostname(), tls: !!(config.smtp.tlsKey && config.smtp.tlsCert), submissionPort: config.smtp.submissionPort || null },
    storage: await storage(),
    ...platform().systemInfo(),
  }),
);

// ── Users ───────────────────────────────────────────────────────────────────

function userDto(u: any) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    usedBytes: u.used_bytes,
    quotaBytes: quotaBytes(u),
    customQuota: u.quota_bytes !== null,
    sendLimitPerDay: sendLimit(u),
    customSendLimit: u.send_limit_per_day !== null,
    totpEnabled: !!u.totp_enabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    aliases: u.aliases ?? 0,
    messages: u.messages ?? 0,
  };
}

adminRoutes.get('/users', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const rows = all<any>(
    `SELECT u.*, (SELECT COUNT(*) FROM addresses a WHERE a.user_id = u.id AND a.kind = 'alias') AS aliases,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages
       FROM users u ${q ? 'WHERE u.email LIKE ? OR u.name LIKE ?' : ''} ORDER BY u.created_at`,
    q ? [`%${q}%`, `%${q}%`] : [],
  );
  return c.json({ users: rows.map(userDto) });
});

adminRoutes.get('/users/:id', (c) => {
  const id = intParam(c, 'id');
  const u = get<any>('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw notFound();
  const addresses = all<any>('SELECT id, address, kind, enabled FROM addresses WHERE user_id = ? ORDER BY kind, address', [id]);
  const sessions = get<{ c: number }>('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?', [id, now()])?.c ?? 0;
  const folders = all<any>('SELECT folder, COUNT(*) AS c, SUM(size) AS bytes FROM messages WHERE user_id = ? GROUP BY folder', [id]);
  return c.json({ user: userDto(u), addresses, sessions, folders });
});

const roleSchema = z.enum(['owner', 'admin', 'user']);

adminRoutes.post('/users', async (c) => {
  const input = await body(
    c,
    z.object({
      email: z.string().min(3).max(254),
      name: z.string().min(1).max(100),
      password: z.string().min(1).max(256),
      role: roleSchema.default('user'),
      quotaMb: z.number().int().min(1).nullable().optional(),
      sendLimitPerDay: z.number().int().min(0).nullable().optional(),
    }),
  );
  const me = c.get('user');
  if (input.role === 'owner' && me.role !== 'owner') throw forbidden('Only the owner can create owners');
  const id = await createUser({
    email: input.email,
    name: input.name,
    password: input.password,
    role: input.role,
    quotaBytes: input.quotaMb ? input.quotaMb * 1024 * 1024 : null,
    sendLimitPerDay: input.sendLimitPerDay ?? null,
  });
  act(c, 'admin.user_created', normalizeEmail(input.email), { role: input.role });
  return c.json({ id });
});

adminRoutes.put('/users/:id', async (c) => {
  const id = intParam(c, 'id');
  const me = c.get('user');
  const u = getUser(id);
  if (!u) throw notFound();
  const input = await body(
    c,
    z.object({
      name: z.string().min(1).max(100).optional(),
      role: roleSchema.optional(),
      status: z.enum(['active', 'suspended']).optional(),
      quotaMb: z.number().int().min(1).nullable().optional(),
      sendLimitPerDay: z.number().int().min(0).nullable().optional(),
    }),
  );
  if (u.role === 'owner' && me.role !== 'owner') throw forbidden('Only the owner can modify the owner account');
  if (input.role === 'owner' && me.role !== 'owner') throw forbidden('Only the owner can grant ownership');
  if (id === me.id && (input.status === 'suspended' || (input.role && input.role !== me.role))) throw badRequest('You cannot change your own role or suspend yourself');
  if (u.role === 'owner' && input.role && input.role !== 'owner') {
    const owners = get<{ c: number }>(`SELECT COUNT(*) AS c FROM users WHERE role = 'owner'`)?.c ?? 0;
    if (owners <= 1) throw badRequest('There must be at least one owner');
  }
  tx(() => {
    if (input.name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', [input.name, id]);
    if (input.role !== undefined) run('UPDATE users SET role = ? WHERE id = ?', [input.role, id]);
    if (input.status !== undefined) {
      run('UPDATE users SET status = ? WHERE id = ?', [input.status, id]);
      if (input.status === 'suspended') run('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
    if (input.quotaMb !== undefined) run('UPDATE users SET quota_bytes = ? WHERE id = ?', [input.quotaMb ? input.quotaMb * 1024 * 1024 : null, id]);
    if (input.sendLimitPerDay !== undefined) run('UPDATE users SET send_limit_per_day = ? WHERE id = ?', [input.sendLimitPerDay, id]);
  });
  act(c, 'admin.user_updated', u.email, input);
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/password', async (c) => {
  const id = intParam(c, 'id');
  const u = getUser(id);
  if (!u) throw notFound();
  if (u.role === 'owner' && c.get('user').role !== 'owner') throw forbidden();
  const { password } = await body(c, z.object({ password: z.string().min(1).max(256) }));
  validatePassword(password);
  run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [await hashPassword(password), now(), id]);
  run('DELETE FROM sessions WHERE user_id = ?', [id]);
  act(c, 'admin.user_password_reset', u.email);
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/reset-2fa', (c) => {
  const id = intParam(c, 'id');
  const u = getUser(id);
  if (!u) throw notFound();
  if (u.role === 'owner' && c.get('user').role !== 'owner') throw forbidden();
  run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?', [id]);
  act(c, 'admin.user_2fa_reset', u.email);
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/signout', (c) => {
  const id = intParam(c, 'id');
  const r = run('DELETE FROM sessions WHERE user_id = ?', [id]);
  act(c, 'admin.user_signed_out', String(id));
  return c.json({ revoked: r.changes });
});

adminRoutes.delete('/users/:id', (c) => {
  const id = intParam(c, 'id');
  const me = c.get('user');
  const u = getUser(id);
  if (!u) throw notFound();
  if (id === me.id) throw badRequest('You cannot delete your own account');
  if (u.role === 'owner') throw forbidden('Transfer ownership before deleting an owner');
  const msgs = all<{ id: number }>('SELECT id FROM messages WHERE user_id = ?', [id]).map((r) => r.id);
  purgeMessages(msgs);
  run('DELETE FROM users WHERE id = ?', [id]);
  act(c, 'admin.user_deleted', u.email);
  return c.json({ ok: true });
});

// ── Domains ─────────────────────────────────────────────────────────────────

function domainDto(d: any) {
  const report = d.dns_report ? JSON.parse(d.dns_report) : null;
  return {
    id: d.id,
    name: d.name,
    enabled: !!d.enabled,
    verified: !!d.verified_at,
    verifiedAt: d.verified_at,
    verifyToken: d.verify_token,
    providerId: d.provider_id,
    providerName: d.provider_name ?? null,
    fallbackProviderId: d.fallback_provider_id,
    catchAllUserId: d.catch_all_user_id,
    catchAllEmail: d.catch_all_email ?? null,
    dkimSelector: d.dkim_selector,
    mailboxes: d.mailboxes ?? 0,
    aliases: d.aliases ?? 0,
    dnsCheckedAt: d.dns_checked_at,
    dns: report,
    createdAt: d.created_at,
  };
}

const DOMAIN_SQL = `SELECT d.*, p.name AS provider_name, u.email AS catch_all_email,
  (SELECT COUNT(*) FROM addresses a WHERE a.domain_id = d.id AND a.kind = 'mailbox') AS mailboxes,
  (SELECT COUNT(*) FROM addresses a WHERE a.domain_id = d.id AND a.kind != 'mailbox') AS aliases
  FROM domains d LEFT JOIN providers p ON p.id = d.provider_id LEFT JOIN users u ON u.id = d.catch_all_user_id`;

adminRoutes.get('/domains', (c) => c.json({ domains: all<any>(`${DOMAIN_SQL} ORDER BY d.name`).map(domainDto) }));

adminRoutes.get('/domains/:id', (c) => {
  const d = get<any>(`${DOMAIN_SQL} WHERE d.id = ?`, [intParam(c, 'id')]);
  if (!d) throw notFound();
  return c.json({ domain: domainDto(d), records: recommendedRecords(d) });
});

const domainName = z
  .string()
  .min(3)
  .max(253)
  .transform((s) => s.trim().toLowerCase().replace(/\.$/, ''))
  .refine((s) => /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(s), 'Enter a valid domain like example.com');

adminRoutes.post('/domains', async (c) => {
  const input = await body(c, z.object({ name: domainName, providerId: z.number().int().nullable().optional() }));
  if (get('SELECT 1 FROM domains WHERE name = ?', [input.name])) throw conflict('That domain is already added');
  const id = insert('INSERT INTO domains (name, verify_token, provider_id, created_at) VALUES (?, ?, ?, ?)', [input.name, randomToken(12), input.providerId ?? null, now()]);
  act(c, 'admin.domain_added', input.name);
  return c.json({ id });
});

adminRoutes.put('/domains/:id', async (c) => {
  const id = intParam(c, 'id');
  const d = get<any>('SELECT * FROM domains WHERE id = ?', [id]);
  if (!d) throw notFound();
  const input = await body(
    c,
    z.object({
      enabled: z.boolean().optional(),
      providerId: z.number().int().nullable().optional(),
      fallbackProviderId: z.number().int().nullable().optional(),
      catchAllUserId: z.number().int().nullable().optional(),
      dkimSelector: z.string().max(200).nullable().optional(),
    }),
  );
  for (const pid of [input.providerId, input.fallbackProviderId]) {
    if (pid && !get('SELECT 1 FROM providers WHERE id = ?', [pid])) throw badRequest('Unknown provider');
  }
  if (input.catchAllUserId && !getUser(input.catchAllUserId)) throw badRequest('Unknown user');
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: [keyof typeof input, string][] = [
    ['enabled', 'enabled'],
    ['providerId', 'provider_id'],
    ['fallbackProviderId', 'fallback_provider_id'],
    ['catchAllUserId', 'catch_all_user_id'],
    ['dkimSelector', 'dkim_selector'],
  ];
  for (const [k, col] of map) {
    if (input[k] !== undefined) {
      sets.push(`${col} = ?`);
      const v = input[k];
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
  }
  if (sets.length) run(`UPDATE domains SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  act(c, 'admin.domain_updated', d.name, input);
  return c.json({ ok: true });
});

adminRoutes.post('/domains/:id/check', async (c) => {
  const report = await checkDomainDns(intParam(c, 'id'));
  return c.json({ report });
});

adminRoutes.delete('/domains/:id', (c) => {
  const id = intParam(c, 'id');
  const d = get<any>('SELECT * FROM domains WHERE id = ?', [id]);
  if (!d) throw notFound();
  const mailboxes = get<{ c: number }>(`SELECT COUNT(*) AS c FROM addresses WHERE domain_id = ? AND kind = 'mailbox'`, [id])?.c ?? 0;
  if (mailboxes) throw badRequest(`Remove or move the ${mailboxes} mailbox(es) on ${d.name} first`);
  run('DELETE FROM domains WHERE id = ?', [id]);
  act(c, 'admin.domain_deleted', d.name);
  return c.json({ ok: true });
});

// ── Addresses: aliases & groups ─────────────────────────────────────────────

adminRoutes.get('/addresses', (c) => {
  const domainId = c.req.query('domainId');
  const rows = all<any>(
    `SELECT a.*, u.email AS user_email, d.name AS domain FROM addresses a JOIN domains d ON d.id = a.domain_id LEFT JOIN users u ON u.id = a.user_id
      WHERE a.kind != 'mailbox' ${domainId ? 'AND a.domain_id = ?' : ''} ORDER BY a.address`,
    domainId ? [Number(domainId)] : [],
  );
  const ids = rows.map((r) => r.id);
  const targets = ids.length
    ? all<any>(
        `SELECT t.address_id, t.user_id, t.external, u.email FROM address_targets t LEFT JOIN users u ON u.id = t.user_id WHERE t.address_id IN (${placeholders(ids.length)})`,
        ids,
      )
    : [];
  return c.json({
    addresses: rows.map((r) => ({
      id: r.id,
      address: r.address,
      domain: r.domain,
      kind: r.kind,
      name: r.name,
      userId: r.user_id,
      userEmail: r.user_email,
      canSend: !!r.can_send,
      enabled: !!r.enabled,
      description: r.description,
      members: targets.filter((t) => t.address_id === r.id).map((t) => (t.user_id ? { userId: t.user_id, email: t.email } : { external: t.external })),
      createdAt: r.created_at,
    })),
  });
});

const addressSchema = z.object({
  address: z.string().min(3).max(254),
  kind: z.enum(['alias', 'group']),
  name: z.string().max(100).default(''),
  userId: z.number().int().nullable().optional(),
  members: z.array(z.string().max(254)).max(500).default([]),
  canSend: z.boolean().default(true),
  enabled: z.boolean().default(true),
  description: z.string().max(500).default(''),
});

function saveTargets(addressId: number, members: string[]) {
  run('DELETE FROM address_targets WHERE address_id = ?', [addressId]);
  for (const raw of members) {
    const m = normalizeEmail(raw);
    if (!isEmail(m)) throw badRequest(`Invalid member address: ${raw}`);
    const user = get<{ id: number }>('SELECT id FROM users WHERE email = ?', [m]);
    if (user) run('INSERT INTO address_targets (address_id, user_id) VALUES (?, ?)', [addressId, user.id]);
    else run('INSERT INTO address_targets (address_id, external) VALUES (?, ?)', [addressId, m]);
  }
}

adminRoutes.post('/addresses', async (c) => {
  const input = await body(c, addressSchema);
  const address = normalizeEmail(input.address);
  if (!isEmail(address)) throw badRequest('Invalid address');
  const domain = get<{ id: number }>('SELECT id FROM domains WHERE name = ?', [domainOf(address)]);
  if (!domain) throw badRequest(`${domainOf(address)} is not a hosted domain`);
  if (get('SELECT 1 FROM addresses WHERE address = ?', [address])) throw conflict('That address already exists');
  if (input.kind === 'alias' && (!input.userId || !getUser(input.userId))) throw badRequest('Choose the mailbox this alias delivers to');
  if (input.kind === 'group' && !input.members.length) throw badRequest('Add at least one member');
  const id = tx(() => {
    const id = insert(
      `INSERT INTO addresses (address, domain_id, kind, user_id, name, can_send, enabled, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [address, domain.id, input.kind, input.kind === 'alias' ? input.userId : null, input.name, input.canSend ? 1 : 0, input.enabled ? 1 : 0, input.description, now()],
    );
    if (input.kind === 'group') saveTargets(id, input.members);
    return id;
  });
  act(c, `admin.${input.kind}_created`, address);
  return c.json({ id });
});

adminRoutes.put('/addresses/:id', async (c) => {
  const id = intParam(c, 'id');
  const a = get<any>(`SELECT * FROM addresses WHERE id = ? AND kind != 'mailbox'`, [id]);
  if (!a) throw notFound();
  const input = await body(c, addressSchema.partial().omit({ address: true, kind: true }));
  tx(() => {
    if (input.name !== undefined) run('UPDATE addresses SET name = ? WHERE id = ?', [input.name, id]);
    if (input.canSend !== undefined) run('UPDATE addresses SET can_send = ? WHERE id = ?', [input.canSend ? 1 : 0, id]);
    if (input.enabled !== undefined) run('UPDATE addresses SET enabled = ? WHERE id = ?', [input.enabled ? 1 : 0, id]);
    if (input.description !== undefined) run('UPDATE addresses SET description = ? WHERE id = ?', [input.description, id]);
    if (a.kind === 'alias' && input.userId) {
      if (!getUser(input.userId)) throw badRequest('Unknown user');
      run('UPDATE addresses SET user_id = ? WHERE id = ?', [input.userId, id]);
    }
    if (a.kind === 'group' && input.members) saveTargets(id, input.members);
  });
  act(c, 'admin.address_updated', a.address);
  return c.json({ ok: true });
});

adminRoutes.delete('/addresses/:id', (c) => {
  const id = intParam(c, 'id');
  const a = get<any>(`SELECT * FROM addresses WHERE id = ? AND kind != 'mailbox'`, [id]);
  if (!a) throw notFound();
  run('DELETE FROM addresses WHERE id = ?', [id]);
  act(c, 'admin.address_deleted', a.address);
  return c.json({ ok: true });
});

// ── Providers ───────────────────────────────────────────────────────────────

adminRoutes.get('/provider-types', (c) => c.json({ types: listProviderTypes() }));

function inboundUrl(token: string) {
  return `${config.publicUrl}/api/inbound/${token}`;
}

function providerDto(row: any, withConfig = false) {
  const def = getProviderDef(row.type);
  let cfg: Record<string, unknown> | undefined;
  if (withConfig) {
    const loaded = loadProvider(row.id);
    cfg = {};
    for (const f of def?.fields ?? []) {
      const v = loaded?.cfg[f.key];
      cfg[f.key] = f.type === 'password' ? (v ? MASK : '') : (v ?? f.default ?? '');
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    typeName: def?.name ?? row.type,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    outbound: !!def?.send,
    inbound: !!def?.receive,
    inboundUrl: def?.receive ? inboundUrl(row.inbound_token) : null,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    receivedCount: row.received_count,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    domains: all<{ name: string }>('SELECT name FROM domains WHERE provider_id = ? OR fallback_provider_id = ?', [row.id, row.id]).map((d) => d.name),
    createdAt: row.created_at,
    ...(withConfig ? { config: cfg } : {}),
  };
}

adminRoutes.get('/providers', (c) => c.json({ providers: all<any>('SELECT * FROM providers ORDER BY is_default DESC, name').map((r) => providerDto(r)) }));

adminRoutes.get('/providers/:id', (c) => {
  const row = get<any>('SELECT * FROM providers WHERE id = ?', [intParam(c, 'id')]);
  if (!row) throw notFound();
  return c.json({ provider: providerDto(row, true) });
});

const providerSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.string().min(1).max(40),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

function cleanConfig(type: string, input: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const def = getProviderDef(type);
  if (!def) throw badRequest('Unknown provider type');
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    let v = input[f.key];
    if (v === MASK) v = previous[f.key];
    if (v === undefined || v === null || v === '') v = f.default ?? (f.type === 'boolean' ? false : '');
    if (f.type === 'number' && v !== '') v = Number(v);
    if (f.type === 'boolean') v = v === true || v === 'true';
    if (typeof v === 'string') v = v.trim();
    if (f.required && (v === '' || v === undefined)) throw badRequest(`${f.label} is required`);
    if (f.type === 'select' && f.options && v !== '' && !f.options.some((o) => o.value === v)) throw badRequest(`Invalid value for ${f.label}`);
    out[f.key] = v;
  }
  return out;
}

adminRoutes.post('/providers', async (c) => {
  const input = await body(c, providerSchema);
  const cfg = cleanConfig(input.type, input.config);
  const id = tx(() => {
    if (input.isDefault) run('UPDATE providers SET is_default = 0');
    return insert('INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      input.name,
      input.type,
      encryptJson(cfg),
      input.enabled ? 1 : 0,
      input.isDefault ? 1 : 0,
      randomToken(24),
      now(),
    ]);
  });
  act(c, 'admin.provider_created', input.name, { type: input.type });
  return c.json({ id });
});

adminRoutes.put('/providers/:id', async (c) => {
  const id = intParam(c, 'id');
  const existing = loadProvider(id);
  if (!existing) throw notFound();
  const input = await body(c, providerSchema.omit({ type: true }).partial());
  tx(() => {
    if (input.config) run('UPDATE providers SET config = ? WHERE id = ?', [encryptJson(cleanConfig(existing.type, input.config, existing.cfg)), id]);
    if (input.name !== undefined) run('UPDATE providers SET name = ? WHERE id = ?', [input.name, id]);
    if (input.enabled !== undefined) run('UPDATE providers SET enabled = ? WHERE id = ?', [input.enabled ? 1 : 0, id]);
    if (input.isDefault !== undefined) {
      if (input.isDefault) run('UPDATE providers SET is_default = 0');
      run('UPDATE providers SET is_default = ? WHERE id = ?', [input.isDefault ? 1 : 0, id]);
    }
  });
  act(c, 'admin.provider_updated', existing.name);
  return c.json({ ok: true });
});

adminRoutes.delete('/providers/:id', (c) => {
  const id = intParam(c, 'id');
  const p = get<any>('SELECT name FROM providers WHERE id = ?', [id]);
  if (!p) throw notFound();
  run('DELETE FROM providers WHERE id = ?', [id]);
  act(c, 'admin.provider_deleted', p.name);
  return c.json({ ok: true });
});

adminRoutes.post('/providers/:id/rotate-token', (c) => {
  const id = intParam(c, 'id');
  const token = randomToken(24);
  if (!run('UPDATE providers SET inbound_token = ? WHERE id = ?', [token, id]).changes) throw notFound();
  act(c, 'admin.provider_token_rotated', String(id));
  return c.json({ inboundUrl: inboundUrl(token) });
});

adminRoutes.post('/providers/:id/verify', async (c) => {
  const p = loadProvider(intParam(c, 'id'));
  if (!p) throw notFound();
  const def = getProviderDef(p.type);
  if (!def?.verify) return c.json({ ok: true, message: 'This provider has no credential check. Send a test message instead.' });
  try {
    const message = await def.verify(p.cfg, providerContext);
    return c.json({ ok: true, message });
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message });
  }
});

/** Send a test email directly through one provider (bypassing the queue so errors show immediately). */
adminRoutes.post('/providers/:id/test', async (c) => {
  const p = loadProvider(intParam(c, 'id'));
  if (!p) throw notFound();
  const def = getProviderDef(p.type);
  if (!def?.send) throw badRequest('This provider cannot send mail');
  const input = await body(c, z.object({ from: z.string().email(), to: z.string().email() }));
  const { raw } = await buildMime({
    from: { address: input.from, name: getSettings()['instance.name'] },
    to: [{ address: input.to }],
    subject: `Test message from ${getSettings()['instance.name']} via ${p.name}`,
    html: `<p>This is a test message sent through <b>${p.name}</b> (${def.name}).</p><p>If you can read this, outbound mail is working. 🎉</p>`,
  });
  try {
    const email = await toOutboundEmail(raw, { from: input.from, to: [input.to] });
    const res = await def.send(p.cfg, email, providerContext);
    run('UPDATE providers SET sent_count = sent_count + 1, last_used_at = ? WHERE id = ?', [now(), p.id]);
    act(c, 'admin.provider_test', p.name, { to: input.to, ok: true });
    return c.json({ ok: true, message: `Sent! Provider message id: ${res.providerMessageId ?? 'n/a'}${res.detail ? ` (${res.detail})` : ''}` });
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : (err as Error).message;
    run('UPDATE providers SET failed_count = failed_count + 1, last_error = ?, last_error_at = ? WHERE id = ?', [msg, now(), p.id]);
    return c.json({ ok: false, message: msg });
  }
});

// ── Queue & logs ────────────────────────────────────────────────────────────

adminRoutes.get('/outbox', (c) => {
  const status = c.req.query('status');
  const q = c.req.query('q');
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('o.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(o.mail_from LIKE ? OR o.recipients LIKE ? OR o.subject LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all<any>(
    `SELECT o.id, o.kind, o.message_id, o.mail_from, o.recipients, o.subject, o.status, o.attempts, o.next_attempt_at, o.last_error,
            o.provider_message_id, o.created_at, o.updated_at, p.name AS provider_name, u.email AS user_email
       FROM outbox o LEFT JOIN providers p ON p.id = o.provider_id LEFT JOIN users u ON u.id = o.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`,
    params,
  );
  return c.json({ items: rows.map((r) => ({ ...r, recipients: JSON.parse(r.recipients) })) });
});

adminRoutes.post('/outbox/:id/retry', (c) => {
  if (!retryOutbox(intParam(c, 'id'))) throw badRequest('Only failed or cancelled items can be retried');
  void processQueue();
  return c.json({ ok: true });
});

adminRoutes.post('/outbox/:id/cancel', (c) => {
  const id = intParam(c, 'id');
  const r = run(`UPDATE outbox SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'`, [now(), id]);
  if (!r.changes) throw badRequest('Only queued items can be cancelled');
  const job = get<{ message_id: number | null }>('SELECT message_id FROM outbox WHERE id = ?', [id]);
  if (job?.message_id) run(`UPDATE messages SET status = 'cancelled', last_error = 'Cancelled by administrator' WHERE id = ?`, [job.message_id]);
  act(c, 'admin.outbox_cancelled', String(id));
  return c.json({ ok: true });
});

adminRoutes.get('/delivery-log', (c) => {
  const rows = all<any>(
    `SELECT l.*, p.name AS provider_name, u.email AS user_email, m.subject FROM delivery_log l
       LEFT JOIN providers p ON p.id = l.provider_id LEFT JOIN users u ON u.id = l.user_id LEFT JOIN messages m ON m.id = l.message_id
      ORDER BY l.id DESC LIMIT 300`,
  );
  return c.json({ items: rows });
});

adminRoutes.get('/inbound-log', (c) => {
  const status = c.req.query('status');
  const rows = all<any>(
    `SELECT l.*, p.name AS provider_name FROM inbound_log l LEFT JOIN providers p ON p.id = l.provider_id
      ${status ? 'WHERE l.status = ?' : ''} ORDER BY l.id DESC LIMIT 300`,
    status ? [status] : [],
  );
  return c.json({ items: rows });
});

adminRoutes.get('/audit', (c) => {
  const rows = all<any>(`SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`);
  return c.json({ items: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) });
});

// ── Settings ────────────────────────────────────────────────────────────────

adminRoutes.get('/settings', (c) => c.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS }));

adminRoutes.put('/settings', async (c) => {
  const input = (await c.req.json().catch(() => null)) as Partial<Settings> | null;
  if (!input || typeof input !== 'object') throw badRequest('Invalid settings');
  if ('instance.accent' in input && !/^#[0-9a-f]{6}$/i.test(String(input['instance.accent']))) throw badRequest('Accent must be a hex colour');
  if ('security.passwordMinLength' in input && Number(input['security.passwordMinLength']) < 8) throw badRequest('Minimum password length is 8');
  if ('spam.rspamdUrl' in input && input['spam.rspamdUrl'] && !/^https?:\/\//.test(String(input['spam.rspamdUrl']))) throw badRequest('rspamd URL must start with http(s)://');
  try {
    setSettings(input);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  act(c, 'admin.settings_updated', Object.keys(input).join(', '));
  return c.json({ settings: getSettings() });
});

// ── Global blocklist ────────────────────────────────────────────────────────

adminRoutes.get('/blocklist', (c) =>
  c.json({ items: all<any>('SELECT id, pattern, created_at AS createdAt FROM blocked_senders WHERE user_id IS NULL ORDER BY created_at DESC') }),
);

adminRoutes.post('/blocklist', async (c) => {
  const { pattern } = await body(c, z.object({ pattern: z.string().min(2).max(254) }));
  const p = pattern.trim().toLowerCase();
  if (!get('SELECT 1 FROM blocked_senders WHERE user_id IS NULL AND pattern = ?', [p])) {
    insert('INSERT INTO blocked_senders (user_id, pattern, created_at) VALUES (NULL, ?, ?)', [p, now()]);
  }
  act(c, 'admin.blocklist_added', p);
  return c.json({ ok: true });
});

adminRoutes.delete('/blocklist/:id', (c) => {
  run('DELETE FROM blocked_senders WHERE id = ? AND user_id IS NULL', [intParam(c, 'id')]);
  return c.json({ ok: true });
});

// ── Invites ─────────────────────────────────────────────────────────────────

adminRoutes.get('/invites', (c) => {
  const rows = all<any>(
    `SELECT i.id, i.email, i.role, i.expires_at, i.used_at, i.created_at, d.name AS domain, u.email AS used_by_email
       FROM invites i LEFT JOIN domains d ON d.id = i.domain_id LEFT JOIN users u ON u.id = i.used_by ORDER BY i.id DESC LIMIT 200`,
  );
  return c.json({ invites: rows });
});

adminRoutes.post('/invites', async (c) => {
  const input = await body(
    c,
    z.object({ email: z.string().max(254).optional(), domainId: z.number().int().nullable().optional(), role: z.enum(['user', 'admin']).default('user'), days: z.number().int().min(1).max(90).default(7) }),
  );
  if (input.email && !isEmail(input.email)) throw badRequest('Invalid email');
  if (input.domainId && !get('SELECT 1 FROM domains WHERE id = ?', [input.domainId])) throw badRequest('Unknown domain');
  const token = randomToken(18);
  insert('INSERT INTO invites (token_hash, email, role, domain_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    sha256(token),
    input.email ? normalizeEmail(input.email) : null,
    input.role,
    input.domainId ?? null,
    c.get('user').id,
    now() + input.days * 86_400_000,
    now(),
  ]);
  act(c, 'admin.invite_created', input.email ?? '(open)', { role: input.role });
  return c.json({ url: `${config.publicUrl}/register?invite=${token}` });
});

adminRoutes.delete('/invites/:id', (c) => {
  run('DELETE FROM invites WHERE id = ?', [intParam(c, 'id')]);
  return c.json({ ok: true });
});

// ── Backup ──────────────────────────────────────────────────────────────────

adminRoutes.get('/backup', async (c) => {
  const snap = await platform().backup();
  act(c, 'admin.backup_downloaded', `${snap.data.length} bytes`);
  return new Response(new Uint8Array(snap.data), {
    headers: {
      'Content-Type': snap.contentType,
      'Content-Disposition': `attachment; filename="${snap.filename}"`,
    },
  });
});

/** Send a broadcast notice to every active user's inbox (e.g. maintenance announcements). */
adminRoutes.post('/announce', async (c) => {
  const input = await body(c, z.object({ subject: z.string().min(1).max(200), html: z.string().min(1).max(100_000) }));
  const me = c.get('user');
  const users = all<{ email: string }>(`SELECT email FROM users WHERE status = 'active'`);
  const { raw } = await buildMime({ from: { address: me.email, name: `${me.name} (${getSettings()['instance.name']})` }, to: [{ address: me.email }], subject: input.subject, html: input.html });
  enqueue({ kind: 'notice', userId: me.id, mailFrom: me.email, recipients: users.map((u) => u.email), rawBlob: await putBlob(raw), subject: input.subject });
  act(c, 'admin.announcement', input.subject, { recipients: users.length });
  return c.json({ recipients: users.length });
});
