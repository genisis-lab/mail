/**
 * Admin operations: setup checklist, one-click Cloudflare setup, alerts,
 * searchable delivery logs, user management in bulk, and shared mailboxes.
 * Mounted on /api/admin next to routes/admin.ts (same auth).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, IN_LIST, insert, listParam, now, run } from '../db/index.js';
import { badRequest, notFound } from '../lib/http.js';
import { getBlob } from '../mail/blobs.js';
import { processQueue, retryOutbox } from '../mail/outbound.js';
import { platform } from '../platform.js';
import { getSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { checklist, startRoundtrip } from '../services/checklist.js';
import { CloudflareApiError, cloudflareToken, listZones, saveCloudflareToken, setUpDomainOnCloudflare } from '../services/cloudflare-setup.js';
import { openAlerts, recentAlerts, resolveAlert, runAlertChecks, type AlertKind } from '../services/alerts.js';
import { body, clientIp, intParam, type AppEnv } from '../http/context.js';
import { forbidden } from '../lib/http.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { domainOf, isEmail, normalizeEmail } from '../lib/addr.js';
import { purgeMessages } from '../mail/store.js';
import { createUser, getPrefs, getUser, mustChangePassword, quotaBytes, savePrefs, sendLimit, validatePassword } from '../services/users.js';
import { jobDto, type JobRow } from '../services/jobs.js';
import { deleteJob, exportStream, startExport } from '../services/mail-import.js';
import { sendSetupLink, welcomeUser } from '../services/account-links.js';
import { listSuppressions, suppress, unsuppress } from '../services/suppressions.js';

export const adminOpsRoutes = new Hono<AppEnv>();

const act = (c: any, action: string, target: string, details?: unknown) => audit(c.get('user').id, action, target, details, clientIp(c));

// ── Setup checklist ─────────────────────────────────────────────────────────

adminOpsRoutes.get('/checklist', (c) => c.json(checklist(c.get('user').id)));

adminOpsRoutes.post('/checklist/roundtrip', async (c) => {
  const me = c.get('user');
  const r = await startRoundtrip(me);
  act(c, 'admin.roundtrip_test', me.email);
  return c.json({ ok: true, outboxId: r.outboxId });
});

// ── Cloudflare one-click setup ──────────────────────────────────────────────

adminOpsRoutes.get('/cloudflare', (c) => c.json({ configured: !!cloudflareToken(), workerName: getSettings()['cloudflare.workerName'] }));

adminOpsRoutes.put('/cloudflare', async (c) => {
  const input = await body(c, z.object({ apiToken: z.string().min(20).max(200), workerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/i, 'Use the Worker’s name as shown in the dashboard').optional() }));
  let zones: string[];
  try {
    zones = await listZones(input.apiToken.trim());
  } catch (err) {
    throw badRequest(`Cloudflare didn’t accept this token: ${(err as Error).message}`);
  }
  saveCloudflareToken(input.apiToken.trim(), input.workerName);
  act(c, 'admin.cloudflare_token_saved', `${zones.length} zone(s)`);
  return c.json({ configured: true, zones, workerName: getSettings()['cloudflare.workerName'] });
});

adminOpsRoutes.delete('/cloudflare', (c) => {
  saveCloudflareToken(null);
  act(c, 'admin.cloudflare_token_removed', '');
  return c.json({ configured: false });
});

adminOpsRoutes.post('/domains/:id/cloudflare-setup', async (c) => {
  const id = intParam(c, 'id');
  const { sending, replaceMx } = await body(c, z.object({ sending: z.boolean().default(true), replaceMx: z.boolean().default(false) }));
  let steps;
  try {
    steps = await setUpDomainOnCloudflare(id, { sending, replaceMx });
  } catch (err) {
    if (err instanceof CloudflareApiError) throw badRequest(err.message);
    throw err;
  }
  const d = get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [id]);
  act(c, 'admin.cloudflare_setup', d?.name ?? String(id), { steps: steps.map((s) => `${s.id}:${s.status}`) });
  return c.json({ steps });
});

// ── Alerts ──────────────────────────────────────────────────────────────────

const alertDto = (a: any) => ({
  id: a.id,
  kind: a.kind,
  key: a.key,
  severity: a.severity,
  title: a.title,
  detail: a.detail,
  link: a.link,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  resolvedAt: a.resolved_at,
});

adminOpsRoutes.get('/alerts', (c) => c.json({ open: openAlerts().map(alertDto), recent: recentAlerts().map(alertDto) }));

adminOpsRoutes.post('/alerts/check', async (c) => {
  await runAlertChecks();
  return c.json({ open: openAlerts().map(alertDto) });
});

/** Dismiss an alert. If the problem persists it is raised again on the next check. */
adminOpsRoutes.post('/alerts/:id/resolve', (c) => {
  const a = get<{ kind: AlertKind; key: string }>('SELECT kind, key FROM alerts WHERE id = ?', [intParam(c, 'id')]);
  if (!a) throw notFound();
  resolveAlert(a.kind, a.key);
  return c.json({ ok: true });
});

// ── Delivery logs (filterable, with detail) ─────────────────────────────────

function page(c: any) {
  const before = Number(c.req.query('before') ?? 0) || null;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 10), 300);
  return { before, limit };
}

adminOpsRoutes.get('/delivery-log', (c) => {
  const { before, limit } = page(c);
  const where: string[] = [];
  const params: unknown[] = [];
  const event = c.req.query('event');
  if (event === 'problems') where.push(`l.event IN ('deferred','rejected','failed','bounced','complained','suppressed')`);
  else if (event) {
    where.push('l.event = ?');
    params.push(event);
  }
  const domain = c.req.query('domain');
  if (domain) {
    where.push(`(o.mail_from LIKE ? OR u.email LIKE ?)`);
    params.push(`%@${domain}`, `%@${domain}`);
  }
  const user = Number(c.req.query('user') ?? 0);
  if (user) {
    where.push('l.user_id = ?');
    params.push(user);
  }
  const q = c.req.query('q')?.trim();
  if (q) {
    where.push('(l.recipients LIKE ? OR l.detail LIKE ? OR m.subject LIKE ? OR o.subject LIKE ? OR o.mail_from LIKE ?)');
    params.push(...Array(5).fill(`%${q}%`));
  }
  if (before) {
    where.push('l.id < ?');
    params.push(before);
  }
  const rows = all<any>(
    `SELECT l.id, l.event, l.recipients, l.detail, l.created_at, l.outbox_id, l.message_id, p.name AS provider_name, u.email AS user_email,
            COALESCE(m.subject, o.subject) AS subject, o.mail_from, o.kind, o.status AS outbox_status
       FROM delivery_log l
       LEFT JOIN providers p ON p.id = l.provider_id LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN messages m ON m.id = l.message_id LEFT JOIN outbox o ON o.id = l.outbox_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT ?`,
    [...params, limit],
  );
  return c.json({ items: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
});

/** Headers of a stored message (never the body: admins don't read users' mail). */
async function headersOf(blob: string | null): Promise<string | null> {
  if (!blob) return null;
  try {
    const raw = (await getBlob(blob)).subarray(0, 64 * 1024).toString('utf8');
    const end = raw.search(/\r?\n\r?\n/);
    return (end >= 0 ? raw.slice(0, end) : raw).slice(0, 16_000);
  } catch {
    return null;
  }
}

adminOpsRoutes.get('/delivery-log/:id', async (c) => {
  const l = get<any>(
    `SELECT l.*, p.name AS provider_name, u.email AS user_email FROM delivery_log l
       LEFT JOIN providers p ON p.id = l.provider_id LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
    [intParam(c, 'id')],
  );
  if (!l) throw notFound();
  const job = l.outbox_id
    ? get<any>(`SELECT o.*, p.name AS provider_name FROM outbox o LEFT JOIN providers p ON p.id = o.provider_id WHERE o.id = ?`, [l.outbox_id])
    : null;
  const timeline = l.outbox_id
    ? all<any>(`SELECT l.id, l.event, l.recipients, l.detail, l.created_at, p.name AS provider_name FROM delivery_log l LEFT JOIN providers p ON p.id = l.provider_id WHERE l.outbox_id = ? ORDER BY l.id`, [l.outbox_id])
    : [l];
  return c.json({
    entry: l,
    job: job
      ? {
          id: job.id,
          kind: job.kind,
          status: job.status,
          mailFrom: job.mail_from,
          recipients: JSON.parse(job.recipients),
          subject: job.subject,
          attempts: job.attempts,
          nextAttemptAt: job.next_attempt_at,
          lastError: job.last_error,
          providerName: job.provider_name,
          providerMessageId: job.provider_message_id,
          createdAt: job.created_at,
          updatedAt: job.updated_at,
          canRetry: ['failed', 'cancelled'].includes(job.status),
          canCancel: job.status === 'queued',
        }
      : null,
    timeline,
    headers: job ? await headersOf(job.raw_blob) : null,
  });
});

adminOpsRoutes.post('/delivery-log/:id/retry', (c) => {
  const l = get<{ outbox_id: number | null }>('SELECT outbox_id FROM delivery_log WHERE id = ?', [intParam(c, 'id')]);
  if (!l?.outbox_id || !retryOutbox(l.outbox_id)) throw badRequest('Only failed or cancelled messages can be retried');
  act(c, 'admin.outbox_retried', String(l.outbox_id));
  platform().defer?.(processQueue());
  return c.json({ ok: true });
});

adminOpsRoutes.get('/inbound-log', (c) => {
  const { before, limit } = page(c);
  const where: string[] = [];
  const params: unknown[] = [];
  const status = c.req.query('status');
  if (status === 'problems') where.push(`l.status IN ('rejected','error','spam')`);
  else if (status) {
    where.push('l.status = ?');
    params.push(status);
  }
  const domain = c.req.query('domain');
  if (domain) {
    where.push('l.rcpt_to LIKE ?');
    params.push(`%@${domain}%`);
  }
  const q = c.req.query('q')?.trim();
  if (q) {
    where.push('(l.mail_from LIKE ? OR l.rcpt_to LIKE ? OR l.subject LIKE ? OR l.reason LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  if (before) {
    where.push('l.id < ?');
    params.push(before);
  }
  const rows = all<any>(
    `SELECT l.*, p.name AS provider_name FROM inbound_log l LEFT JOIN providers p ON p.id = l.provider_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT ?`,
    [...params, limit],
  );
  return c.json({ items: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
});

adminOpsRoutes.get('/inbound-log/:id', async (c) => {
  const l = get<any>('SELECT l.*, p.name AS provider_name FROM inbound_log l LEFT JOIN providers p ON p.id = l.provider_id WHERE l.id = ?', [intParam(c, 'id')]);
  if (!l) throw notFound();
  // Spam score, authentication results and headers of the delivered copy, if any.
  const msg = l.message_id
    ? get<any>(
        `SELECT m.id, m.folder, m.spam_score, m.auth_results, m.raw_blob, u.email AS mailbox FROM messages m JOIN users u ON u.id = m.user_id
          WHERE m.message_id = ? AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1`,
        [l.message_id],
      )
    : null;
  return c.json({
    entry: l,
    delivered: msg ? { folder: msg.folder, mailbox: msg.mailbox, spamScore: msg.spam_score, authResults: msg.auth_results ? JSON.parse(msg.auth_results) : null } : null,
    headers: msg ? await headersOf(msg.raw_blob) : null,
  });
});

// ── Suppression list ────────────────────────────────────────────────────────

adminOpsRoutes.get('/suppressions', (c) => c.json({ items: listSuppressions((c.req.query('q') ?? '').trim()) }));

adminOpsRoutes.post('/suppressions', async (c) => {
  const { address, detail } = await body(c, z.object({ address: z.string().max(254), detail: z.string().max(300).default('') }));
  const a = normalizeEmail(address);
  if (!isEmail(a)) throw badRequest('Enter a valid email address');
  suppress(a, 'manual', detail);
  act(c, 'admin.suppression_added', a);
  return c.json({ ok: true });
});

adminOpsRoutes.delete('/suppressions/:address', (c) => {
  const a = normalizeEmail(decodeURIComponent(c.req.param('address')));
  if (!unsuppress(a)) throw notFound();
  act(c, 'admin.suppression_removed', a);
  return c.json({ ok: true });
});

/** Remove someone's passkeys (a lost or stolen device). */
adminOpsRoutes.delete('/users/:id/passkeys', (c) => {
  const id = intParam(c, 'id');
  const u = getUser(id);
  if (!u) throw notFound();
  if (u.role === 'owner' && c.get('user').role !== 'owner') throw forbidden();
  const removed = run('DELETE FROM passkeys WHERE user_id = ?', [id]).changes;
  act(c, 'admin.user_passkeys_removed', u.email, { removed });
  return c.json({ removed });
});

// ── Catch-all control ───────────────────────────────────────────────────────

/** Addresses that only received mail through a domain's catch-all, and blocked addresses. */
adminOpsRoutes.get('/domains/:id/catchall', (c) => {
  const id = intParam(c, 'id');
  const d = get<{ name: string; catch_all_user_id: number | null }>('SELECT name, catch_all_user_id FROM domains WHERE id = ?', [id]);
  if (!d) throw notFound();
  const hits = all<any>(
    `SELECT h.address, h.count, h.first_at, h.last_at, h.last_from, h.last_subject, (SELECT 1 FROM blocked_recipients b WHERE b.address = h.address) AS blocked
       FROM catchall_hits h WHERE h.domain_id = ? AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.address = h.address)
      ORDER BY h.last_at DESC LIMIT 500`,
    [id],
  );
  const blocked = all<any>(`SELECT address, created_at FROM blocked_recipients WHERE address LIKE ? ESCAPE '\\' ORDER BY address`, [`%@${d.name.replace(/[\\%_]/g, (x) => `\\${x}`)}`]);
  return c.json({
    catchAllUserId: d.catch_all_user_id,
    hits: hits.map((h) => ({ address: h.address, count: h.count, firstAt: h.first_at, lastAt: h.last_at, lastFrom: h.last_from, lastSubject: h.last_subject, blocked: !!h.blocked })),
    blocked: blocked.map((b) => ({ address: b.address, createdAt: b.created_at })),
  });
});

const hostedAddress = (value: string) => {
  const a = normalizeEmail(value);
  if (!isEmail(a) || !get('SELECT 1 FROM domains WHERE name = ?', [domainOf(a)])) throw badRequest('Enter an address on one of your domains');
  return a;
};

/** Refuse mail to an address (even when a catch-all would take it). */
adminOpsRoutes.post('/blocked-recipients', async (c) => {
  const a = hostedAddress((await body(c, z.object({ address: z.string().max(254) }))).address);
  run('INSERT OR IGNORE INTO blocked_recipients (address, created_by, created_at) VALUES (?, ?, ?)', [a, c.get('user').id, now()]);
  act(c, 'admin.recipient_blocked', a);
  return c.json({ ok: true });
});

adminOpsRoutes.delete('/blocked-recipients/:address', (c) => {
  const a = normalizeEmail(decodeURIComponent(c.req.param('address')));
  if (!run('DELETE FROM blocked_recipients WHERE address = ?', [a]).changes) throw notFound();
  act(c, 'admin.recipient_unblocked', a);
  return c.json({ ok: true });
});

/** Turn an address the catch-all has been taking into a real alias. */
adminOpsRoutes.post('/catchall/alias', async (c) => {
  const input = await body(c, z.object({ address: z.string().max(254), userId: z.number().int().positive().optional() }));
  const a = hostedAddress(input.address);
  if (get('SELECT 1 FROM addresses WHERE address = ?', [a]) || get('SELECT 1 FROM users WHERE email = ?', [a])) throw badRequest('That address already exists');
  const d = get<{ id: number; catch_all_user_id: number | null }>('SELECT id, catch_all_user_id FROM domains WHERE name = ?', [domainOf(a)])!;
  const userId = input.userId ?? d.catch_all_user_id;
  if (!userId || !getUser(userId)) throw badRequest('Choose the mailbox this alias delivers to');
  const id = insert(`INSERT INTO addresses (address, domain_id, kind, user_id, name, can_send, enabled, description, created_at) VALUES (?, ?, 'alias', ?, '', 1, 1, ?, ?)`, [
    a,
    d.id,
    userId,
    'Created from the catch-all',
    now(),
  ]);
  run('DELETE FROM blocked_recipients WHERE address = ?', [a]);
  act(c, 'admin.alias_created', a);
  return c.json({ id });
});

adminOpsRoutes.delete('/catchall/hits/:address', (c) => {
  run('DELETE FROM catchall_hits WHERE address = ?', [normalizeEmail(decodeURIComponent(c.req.param('address')))]);
  return c.json({ ok: true });
});

/** Domains and users for the log filters. */
adminOpsRoutes.get('/log-filters', (c) =>
  c.json({
    domains: all<{ name: string }>('SELECT name FROM domains ORDER BY name').map((d) => d.name),
    users: all<{ id: number; email: string }>(`SELECT id, email FROM users ORDER BY email`),
  }),
);


// ── User detail ─────────────────────────────────────────────────────────────

adminOpsRoutes.get('/users/:id/detail', (c) => {
  const id = intParam(c, 'id');
  const u = getUser(id);
  if (!u || u.kind !== 'person') throw notFound();
  const folders = all<{ folder: string; c: number; bytes: number }>('SELECT folder, COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM messages WHERE user_id = ? GROUP BY folder', [id]);
  const attachments = get<{ c: number; bytes: number }>('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE user_id = ?', [id]);
  const addresses = all<any>(
    `SELECT a.id, a.address, a.kind, a.enabled, a.can_send, a.created_by FROM addresses a WHERE a.user_id = ?
     UNION ALL
     SELECT a.id, a.address, 'group' AS kind, a.enabled, a.can_send, NULL FROM addresses a JOIN address_targets t ON t.address_id = a.id WHERE t.user_id = ? AND a.kind = 'group'
     ORDER BY kind, address`,
    [id, id],
  );
  const shared = all<any>(
    `SELECT b.id, b.email, b.name, mm.can_send FROM mailbox_members mm JOIN users b ON b.id = mm.mailbox_id WHERE mm.user_id = ? ORDER BY b.email`,
    [id],
  );
  const sessions = all<any>(
    'SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? AND mfa_pending = 0 ORDER BY last_seen_at DESC',
    [id, now()],
  ).map((s) => ({ id: s.id.slice(0, 16), ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at }));
  const signIns = all<any>(
    `SELECT action, ip, created_at, details FROM audit_log WHERE user_id = ? AND action IN ('auth.login','auth.login_failed','auth.password_reset','auth.account_setup') ORDER BY id DESC LIMIT 25`,
    [id],
  ).map((r) => {
    const d = r.details ? JSON.parse(r.details) : {};
    return { action: r.action, ip: r.ip, at: r.created_at, mfa: !!d.mfa, passkey: typeof d.passkey === 'string' };
  });
  const sentToday = get<{ c: number }>(`SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND kind IN ('user','api') AND created_at > ?`, [id, now() - 86_400_000])?.c ?? 0;
  const prefs = getPrefs(id);
  const exports = all<JobRow>(`SELECT * FROM jobs WHERE user_id = ? AND kind = 'export' ORDER BY id DESC LIMIT 5`, [id]).map(jobDto);
  return c.json({
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      passwordChangedAt: u.password_changed_at,
      mustChangePassword: mustChangePassword(u),
      totpEnabled: !!u.totp_enabled,
      passkeys: get<{ c: number }>('SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ?', [id])!.c,
      recoveryEmail: u.recovery_email,
      recoveryVerified: !!u.recovery_verified_at,
      usedBytes: u.used_bytes,
      quotaBytes: quotaBytes(u),
      customQuota: u.quota_bytes !== null,
      sendLimitPerDay: sendLimit(u),
      customSendLimit: u.send_limit_per_day !== null,
      sentToday,
      lockedUntil: lockedUntil(u.email),
    },
    mailHandling: { vacation: prefs.vacation, forwarding: prefs.forwarding },
    exports,
    storage: { folders, attachments },
    addresses,
    shared: shared.map((b) => ({ id: b.id, email: b.email, name: b.name, canSend: !!b.can_send })),
    sessions,
    signIns,
  });
});

/** The user, if this admin may manage them (only the owner manages the owner). */
function managed(c: any): NonNullable<ReturnType<typeof getUser>> {
  const u = getUser(intParam(c, 'id'));
  if (!u) throw notFound();
  if (u.role === 'owner' && c.get('user').role !== 'owner') throw forbidden('Only the owner can do that to the owner account');
  return u;
}

adminOpsRoutes.delete('/users/:id/sessions/:sid', (c) => {
  const u = managed(c);
  const sid = c.req.param('sid');
  if (!/^[a-f0-9]{16}$/.test(sid)) throw badRequest('Invalid session');
  const r = run('DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?', [u.id, sid]);
  act(c, 'admin.user_session_revoked', u.email);
  return c.json({ revoked: r.changes });
});

// ── Lockouts ────────────────────────────────────────────────────────────────

/** When too many failed sign-ins locked this address out, until when (else null). */
function lockedUntil(email: string): number | null {
  const row = get<{ count: number; reset_at: number }>('SELECT count, reset_at FROM login_attempts WHERE key = ?', [`login:user:${normalizeEmail(email)}`]);
  return row && row.reset_at > now() && row.count >= getSettings()['security.maxLoginAttempts'] ? row.reset_at : null;
}

adminOpsRoutes.post('/users/:id/unlock', (c) => {
  const u = managed(c);
  run('DELETE FROM login_attempts WHERE key = ?', [`login:user:${normalizeEmail(u.email)}`]);
  act(c, 'admin.user_unlocked', u.email);
  return c.json({ ok: true });
});

// ── Out of office and forwarding, set for someone (an absence, someone who left) ──

const mailHandlingSchema = z.object({
  vacation: z
    .object({
      enabled: z.boolean(),
      subject: z.string().max(200),
      message: z.string().max(20_000),
      startAt: z.number().nullable(),
      endAt: z.number().nullable(),
      contactsOnly: z.boolean(),
    })
    .partial()
    .optional(),
  forwarding: z.object({ enabled: z.boolean(), to: z.string().max(254), keep: z.enum(['inbox', 'archive', 'read', 'trash']) }).partial().optional(),
});

adminOpsRoutes.put('/users/:id/mail-handling', async (c) => {
  const u = managed(c);
  const input = await body(c, mailHandlingSchema);
  const prefs = getPrefs(u.id);
  const vacation = { ...prefs.vacation, ...(input.vacation ?? {}) };
  const forwarding = { ...prefs.forwarding, ...(input.forwarding ?? {}) };
  forwarding.to = normalizeEmail(forwarding.to);
  if (vacation.enabled && !vacation.message.trim()) throw badRequest('Write the automatic reply');
  if (forwarding.enabled) {
    if (!isEmail(forwarding.to)) throw badRequest('Enter a valid forwarding address');
    if (forwarding.to === u.email.toLowerCase()) throw badRequest('Mail can’t be forwarded to the same mailbox');
    // Policy is about mail leaving the server; forwarding to a hosted address is always fine.
    const hosted = !!get('SELECT 1 FROM domains WHERE name = ? AND enabled = 1', [domainOf(forwarding.to)]);
    if (!hosted && !getSettings()['mail.allowExternalForwarding']) throw badRequest('Forwarding outside this server is turned off in Settings → Security');
  }
  savePrefs(u.id, { ...prefs, vacation, forwarding });
  if (input.vacation) act(c, 'admin.user_vacation', u.email, { enabled: vacation.enabled });
  if (input.forwarding) act(c, 'admin.user_forwarding', u.email, { to: forwarding.enabled ? forwarding.to : null });
  return c.json({ mailHandling: { vacation, forwarding } });
});

// ── Mail export for someone (offboarding, a legal hold) ─────────────────────

adminOpsRoutes.post('/users/:id/export', (c) => {
  const u = managed(c);
  const id = startExport(u.id);
  act(c, 'admin.user_export_started', u.email);
  return c.json({ job: jobDto(get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])!) });
});

function userExport(c: any, u: { id: number }): JobRow {
  const job = get<JobRow>(`SELECT * FROM jobs WHERE id = ? AND user_id = ? AND kind = 'export'`, [intParam(c, 'job'), u.id]);
  if (!job) throw notFound();
  return job;
}

adminOpsRoutes.get('/users/:id/export/:job/download', (c) => {
  const u = managed(c);
  const job = userExport(c, u);
  if (job.status !== 'done') throw badRequest('The export isn’t ready yet');
  const bytes = (JSON.parse(job.state) as { bytes?: number }).bytes ?? 0;
  act(c, 'admin.user_export_downloaded', u.email);
  return new Response(exportStream(job), {
    headers: {
      'Content-Type': 'application/mbox',
      'Content-Disposition': `attachment; filename="${u.email.replace(/[^a-z0-9@._-]/gi, '_')}-${new Date(job.created_at).toISOString().slice(0, 10)}.mbox"`,
      'Content-Length': String(bytes),
      'Cache-Control': 'private, no-store',
    },
  });
});

adminOpsRoutes.delete('/users/:id/export/:job', async (c) => {
  const u = managed(c);
  const job = userExport(c, u);
  if (job.status === 'queued' || job.status === 'running') run(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now(), job.id]);
  await deleteJob(job);
  return c.json({ ok: true });
});

// ── Bulk actions ────────────────────────────────────────────────────────────

const bulkSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  action: z.enum(['suspend', 'activate', 'quota', 'sendLimit', 'signout', 'requirePasswordChange', 'delete']),
  /** MB for quota, messages/day for sendLimit; null resets to the default. */
  value: z.number().int().min(0).nullable().optional(),
});

adminOpsRoutes.post('/users/bulk', async (c) => {
  const input = await body(c, bulkSchema);
  const me = c.get('user');
  const results: { id: number; email: string; ok: boolean; error?: string }[] = [];
  for (const id of [...new Set(input.ids)]) {
    const u = getUser(id);
    if (!u || u.kind !== 'person') {
      results.push({ id, email: '', ok: false, error: 'not found' });
      continue;
    }
    const skip = (error: string) => results.push({ id, email: u.email, ok: false, error });
    if (u.role === 'owner' && me.role !== 'owner') {
      skip('only the owner can change the owner');
      continue;
    }
    if (id === me.id && ['suspend', 'delete', 'requirePasswordChange'].includes(input.action)) {
      skip('you can’t do that to your own account');
      continue;
    }
    if (u.role === 'owner' && ['suspend', 'delete'].includes(input.action)) {
      skip('owners can’t be suspended or deleted');
      continue;
    }
    switch (input.action) {
      case 'suspend':
        run(`UPDATE users SET status = 'suspended' WHERE id = ?`, [id]);
        run('DELETE FROM sessions WHERE user_id = ?', [id]);
        break;
      case 'activate':
        run(`UPDATE users SET status = 'active' WHERE id = ?`, [id]);
        break;
      case 'quota':
        run('UPDATE users SET quota_bytes = ? WHERE id = ?', [input.value ? input.value * 1024 * 1024 : null, id]);
        break;
      case 'sendLimit':
        run('UPDATE users SET send_limit_per_day = ? WHERE id = ?', [input.value ?? null, id]);
        break;
      case 'signout':
        run('DELETE FROM sessions WHERE user_id = ?', [id]);
        break;
      case 'requirePasswordChange':
        run('UPDATE users SET password_change_required_at = ? WHERE id = ?', [now(), id]);
        break;
      case 'delete':
        purgeMessages(all<{ id: number }>('SELECT id FROM messages WHERE user_id = ?', [id]).map((r) => r.id));
        run('DELETE FROM users WHERE id = ?', [id]);
        break;
    }
    results.push({ id, email: u.email, ok: true });
  }
  act(c, `admin.users_bulk_${input.action}`, `${results.filter((r) => r.ok).length} user(s)`, { value: input.value ?? null });
  return c.json({ results });
});

// ── CSV import (the browser parses the file; rows arrive as JSON) ───────────

const importRow = z.object({
  email: z.string().max(254),
  name: z.string().max(100).default(''),
  password: z.string().max(256).optional(),
  role: z.enum(['user', 'admin']).optional(),
  quotaMb: z.number().int().min(1).nullable().optional(),
  sendLimitPerDay: z.number().int().min(0).nullable().optional(),
  setupEmail: z.string().max(254).optional(),
});

function validateRow(r: z.infer<typeof importRow>, seen: Set<string>): string | null {
  const email = normalizeEmail(r.email);
  if (!isEmail(email)) return 'invalid email address';
  if (seen.has(email)) return 'duplicate row';
  if (!get('SELECT 1 FROM domains WHERE name = ?', [domainOf(email)])) return `domain ${domainOf(email)} isn’t hosted here`;
  if (get('SELECT 1 FROM addresses WHERE address = ?', [email]) || get('SELECT 1 FROM users WHERE email = ?', [email])) return 'address already exists';
  if (r.setupEmail && !isEmail(r.setupEmail.trim())) return 'invalid setup email';
  if (!r.password && !r.setupEmail) return 'needs a password or a setup email';
  if (r.password) {
    try {
      validatePassword(r.password);
    } catch (err) {
      return (err as Error).message.toLowerCase();
    }
  }
  return null;
}

adminOpsRoutes.post('/users/import', async (c) => {
  // Password hashing is CPU-heavy: the browser sends large files in batches of up to 100.
  const input = await body(c, z.object({ rows: z.array(importRow).min(1).max(100), dryRun: z.boolean().default(false) }));
  const seen = new Set<string>();
  const results: { row: number; email: string; ok: boolean; error?: string; setupUrl?: string | null }[] = [];
  for (const [i, r] of input.rows.entries()) {
    const email = normalizeEmail(r.email);
    const error = validateRow(r, seen);
    seen.add(email);
    if (error || input.dryRun) {
      results.push({ row: i + 1, email, ok: !error, error: error ?? undefined });
      continue;
    }
    try {
      const id = await createUser({
        email,
        name: r.name.trim() || email.split('@')[0],
        password: r.password || `${randomToken(24)}${randomToken(8)}`,
        role: r.role ?? 'user',
        quotaBytes: r.quotaMb ? r.quotaMb * 1024 * 1024 : null,
        sendLimitPerDay: r.sendLimitPerDay ?? null,
      });
      let setupUrl: string | null = null;
      const setupEmail = r.setupEmail?.trim().toLowerCase();
      if (setupEmail) {
        run('UPDATE users SET recovery_email = ? WHERE id = ?', [setupEmail, id]);
        if (!r.password) setupUrl = await sendSetupLink(getUser(id)!, setupEmail);
      }
      await welcomeUser(id);
      results.push({ row: i + 1, email, ok: true, setupUrl });
    } catch (err) {
      results.push({ row: i + 1, email, ok: false, error: (err as Error).message });
    }
  }
  if (!input.dryRun) act(c, 'admin.users_imported', `${results.filter((r) => r.ok).length} user(s)`);
  return c.json({ results });
});

// ── Shared mailboxes ────────────────────────────────────────────────────────

const memberSchema = z.array(z.object({ userId: z.number().int().positive(), canSend: z.boolean().default(true) })).max(500);

function sharedDto(b: any) {
  const members = all<any>(
    `SELECT u.id, u.email, u.name, mm.can_send FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_id = ? ORDER BY u.email`,
    [b.id],
  );
  return {
    id: b.id,
    address: b.email,
    name: b.name,
    status: b.status,
    usedBytes: b.used_bytes,
    quotaBytes: quotaBytes(b),
    unread: get<{ c: number }>(`SELECT COUNT(DISTINCT thread_id) AS c FROM messages WHERE user_id = ? AND folder = 'inbox' AND is_read = 0`, [b.id])?.c ?? 0,
    members: members.map((m) => ({ userId: m.id, email: m.email, name: m.name, canSend: !!m.can_send })),
  };
}

function setMembers(mailboxId: number, members: z.infer<typeof memberSchema>) {
  run('DELETE FROM mailbox_members WHERE mailbox_id = ?', [mailboxId]);
  for (const m of members) {
    const u = getUser(m.userId);
    if (!u || u.kind !== 'person') throw badRequest(`Unknown member ${m.userId}`);
    run('INSERT INTO mailbox_members (mailbox_id, user_id, can_send, created_at) VALUES (?, ?, ?, ?)', [mailboxId, m.userId, m.canSend ? 1 : 0, now()]);
  }
}

adminOpsRoutes.get('/shared-mailboxes', (c) => c.json({ mailboxes: all<any>(`SELECT * FROM users WHERE kind = 'shared' ORDER BY email`).map(sharedDto) }));

adminOpsRoutes.post('/shared-mailboxes', async (c) => {
  const input = await body(c, z.object({ address: z.string().max(254), name: z.string().min(1).max(100), members: memberSchema.default([]), quotaMb: z.number().int().min(1).nullable().optional() }));
  const id = await createUser({
    email: input.address,
    name: input.name,
    // Never used: shared mailboxes can't sign in.
    password: `${randomToken(24)}${randomToken(8)}`,
    quotaBytes: input.quotaMb ? input.quotaMb * 1024 * 1024 : null,
  });
  run(`UPDATE users SET kind = 'shared', password_hash = ? WHERE id = ?`, [await hashPassword(randomToken(32)), id]);
  setMembers(id, input.members);
  act(c, 'admin.shared_mailbox_created', normalizeEmail(input.address), { members: input.members.length });
  return c.json({ mailbox: sharedDto(getUser(id)) });
});

adminOpsRoutes.put('/shared-mailboxes/:id', async (c) => {
  const id = intParam(c, 'id');
  const b = getUser(id);
  if (!b || b.kind !== 'shared') throw notFound();
  const input = await body(c, z.object({ name: z.string().min(1).max(100).optional(), members: memberSchema.optional(), quotaMb: z.number().int().min(1).nullable().optional(), status: z.enum(['active', 'suspended']).optional() }));
  if (input.name !== undefined) {
    run('UPDATE users SET name = ? WHERE id = ?', [input.name, id]);
    run(`UPDATE addresses SET name = ? WHERE user_id = ? AND kind = 'mailbox'`, [input.name, id]);
  }
  if (input.quotaMb !== undefined) run('UPDATE users SET quota_bytes = ? WHERE id = ?', [input.quotaMb ? input.quotaMb * 1024 * 1024 : null, id]);
  if (input.status) run('UPDATE users SET status = ? WHERE id = ?', [input.status, id]);
  if (input.members) setMembers(id, input.members);
  act(c, 'admin.shared_mailbox_updated', b.email);
  return c.json({ mailbox: sharedDto(getUser(id)) });
});

adminOpsRoutes.delete('/shared-mailboxes/:id', (c) => {
  const id = intParam(c, 'id');
  const b = getUser(id);
  if (!b || b.kind !== 'shared') throw notFound();
  if (c.get('user').role !== 'owner' && c.get('user').role !== 'admin') throw forbidden();
  purgeMessages(all<{ id: number }>('SELECT id FROM messages WHERE user_id = ?', [id]).map((r) => r.id));
  run('DELETE FROM users WHERE id = ?', [id]);
  act(c, 'admin.shared_mailbox_deleted', b.email);
  return c.json({ ok: true });
});
