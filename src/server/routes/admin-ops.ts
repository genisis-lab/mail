/**
 * Admin operations: setup checklist, one-click Cloudflare setup, alerts,
 * searchable delivery logs, user management in bulk, and shared mailboxes.
 * Mounted on /api/admin next to routes/admin.ts (same auth).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, IN_LIST, listParam, now, run } from '../db/index.js';
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
  const { sending } = await body(c, z.object({ sending: z.boolean().default(true) }));
  let steps;
  try {
    steps = await setUpDomainOnCloudflare(id, { sending });
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
  if (event === 'problems') where.push(`l.event IN ('deferred','rejected','failed')`);
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

/** Domains and users for the log filters. */
adminOpsRoutes.get('/log-filters', (c) =>
  c.json({
    domains: all<{ name: string }>('SELECT name FROM domains ORDER BY name').map((d) => d.name),
    users: all<{ id: number; email: string }>(`SELECT id, email FROM users ORDER BY email`),
  }),
);

