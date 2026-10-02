/**
 * Admin alerts: things that need attention before users notice. Each alert is
 * keyed by (kind, key) so a problem raises one alert, stays open while it
 * persists, and resolves itself when the condition clears.
 *
 * Admins are notified with a message in their own inbox (stored directly, so
 * it works even when the outbound provider is the thing that's broken) and,
 * optionally, by email to an outside address.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { logger } from '../lib/log.js';
import { escapeHtml } from '../mail/compose.js';
import { storeMessage } from '../mail/store.js';
import { getSettings } from '../settings.js';
import { appUrl, sendSystemEmail, systemSender, systemTemplate } from './system-mail.js';
import { quotaBytes } from './users.js';
import { notifyNewMail } from './push.js';

const log = logger('alerts');
const RENOTIFY_MS = 24 * 3600_000;

export type AlertKind = 'provider' | 'queue' | 'quota' | 'dns' | 'backup';
export type Severity = 'info' | 'warn' | 'critical';

export interface AlertInput {
  kind: AlertKind;
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  link?: string;
}

export interface AlertRow {
  id: number;
  kind: AlertKind;
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  link: string | null;
  created_at: number;
  updated_at: number;
  notified_at: number | null;
  resolved_at: number | null;
}

/** Open (or refresh) an alert. Notifies admins when it's new, or again after a day. */
export async function raiseAlert(a: AlertInput): Promise<AlertRow> {
  const ts = now();
  const open = get<AlertRow>('SELECT * FROM alerts WHERE kind = ? AND key = ? AND resolved_at IS NULL', [a.kind, a.key]);
  let row: AlertRow;
  if (open) {
    run('UPDATE alerts SET severity = ?, title = ?, detail = ?, link = ?, updated_at = ? WHERE id = ?', [a.severity, a.title, a.detail ?? '', a.link ?? null, ts, open.id]);
    row = { ...open, ...a, detail: a.detail ?? '', link: a.link ?? null, updated_at: ts };
  } else {
    const id = insert('INSERT INTO alerts (kind, key, severity, title, detail, link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      a.kind,
      a.key,
      a.severity,
      a.title,
      a.detail ?? '',
      a.link ?? null,
      ts,
      ts,
    ]);
    row = get<AlertRow>('SELECT * FROM alerts WHERE id = ?', [id])!;
    log.warn(`Alert: ${a.title}`);
  }
  if (!row.notified_at || ts - row.notified_at > RENOTIFY_MS) {
    run('UPDATE alerts SET notified_at = ? WHERE id = ?', [ts, row.id]);
    await notifyAdmins(row).catch((err) => log.warn('Could not notify admins', err));
  }
  return row;
}

export function resolveAlert(kind: AlertKind, key: string): boolean {
  return run('UPDATE alerts SET resolved_at = ?, updated_at = ? WHERE kind = ? AND key = ? AND resolved_at IS NULL', [now(), now(), kind, key]).changes > 0;
}

export function openAlerts(): AlertRow[] {
  return all<AlertRow>(`SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, updated_at DESC`);
}

export function recentAlerts(limit = 50): AlertRow[] {
  return all<AlertRow>('SELECT * FROM alerts ORDER BY COALESCE(resolved_at, updated_at) DESC LIMIT ?', [limit]);
}

async function notifyAdmins(a: AlertRow) {
  const s = getSettings();
  if (!s['alerts.email']) return;
  const html = systemTemplate({
    title: a.title,
    paragraphs: [escapeHtml(a.detail || ''), 'You’ll get one message per problem per day while it lasts. It resolves on its own once fixed.'].filter(Boolean),
    button: a.link ? { label: 'Open the admin panel', url: appUrl(a.link) } : undefined,
    footer: 'Alerts can be turned off in Admin → Settings → Alerts.',
  });
  const admins = all<{ id: number; email: string; name: string }>(`SELECT id, email, name FROM users WHERE role IN ('owner','admin') AND status = 'active' AND kind = 'person'`);
  for (const admin of admins) {
    const domain = admin.email.split('@')[1];
    await storeMessage({
      userId: admin.id,
      folder: 'inbox',
      direction: 'in',
      messageId: `alert.${a.id}.${now()}.${admin.id}@${domain}`,
      inReplyTo: null,
      references: [],
      from: { address: systemSender(domain)?.address ?? `contact@${domain}`, name: `${s['instance.name']} alerts` },
      to: [{ address: admin.email, name: admin.name }],
      cc: [],
      replyTo: null,
      subject: `[Alert] ${a.title}`,
      text: null,
      html,
      date: now(),
      size: html.length,
      rawBlob: null,
      attachments: [],
      isImportant: a.severity === 'critical',
      source: 'system',
    });
    if (a.severity === 'critical') notifyNewMail(admin.id);
  }
  const external = s['alerts.externalTo'].trim();
  if (external) await sendSystemEmail({ to: [external], subject: `[${s['instance.name']}] ${a.title}`, html });
}

// ── Checks (run every few minutes from the background jobs) ─────────────────

const HOUR = 3600_000;

export async function checkProviders() {
  const since = now() - HOUR;
  const providers = all<{ id: number; name: string; enabled: number }>('SELECT id, name, enabled FROM providers');
  for (const p of providers) {
    // The most recent attempts decide: three failures in a row is an outage; one success clears it.
    const recent = all<{ event: string; detail: string }>(
      `SELECT event, detail FROM delivery_log WHERE provider_id = ? AND event IN ('sent','deferred','rejected','failed') AND created_at > ? ORDER BY id DESC LIMIT 3`,
      [p.id, since],
    );
    const failing = recent.length === 3 && recent.every((r) => r.event !== 'sent');
    if (p.enabled && failing) {
      await raiseAlert({
        kind: 'provider',
        key: String(p.id),
        severity: 'critical',
        title: `${p.name} is failing to send mail`,
        detail: `The last ${recent.length} attempts failed. Latest error: ${recent[0].detail || 'unknown'}. Messages are being retried.`,
        link: '/admin/providers',
      });
    } else if (!p.enabled || !recent.length || recent[0].event === 'sent') {
      resolveAlert('provider', String(p.id));
    }
  }
}

export async function checkQueue() {
  const ts = now();
  const due = get<{ c: number; oldest: number | null }>(`SELECT COUNT(*) AS c, MIN(next_attempt_at) AS oldest FROM outbox WHERE status = 'queued' AND next_attempt_at <= ?`, [ts]);
  const retrying = get<{ c: number }>(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'queued' AND attempts > 0`)?.c ?? 0;
  const threshold = getSettings()['alerts.queueThreshold'];
  const count = due?.c ?? 0;
  const stuckMinutes = due?.oldest ? Math.round((ts - due.oldest) / 60_000) : 0;
  if (count >= threshold || stuckMinutes >= 30 || retrying >= threshold) {
    await raiseAlert({
      kind: 'queue',
      key: 'backlog',
      severity: 'warn',
      title: 'Outgoing mail is backing up',
      detail: `${count} message(s) are waiting to be sent${stuckMinutes ? `, the oldest for ${stuckMinutes} minutes` : ''}; ${retrying} are being retried after errors.`,
      link: '/admin/queue',
    });
  } else {
    resolveAlert('queue', 'backlog');
  }
}

export async function checkQuotas() {
  const pct = getSettings()['alerts.quotaPercent'] / 100;
  const users = all<{ id: number; email: string; used_bytes: number; quota_bytes: number | null }>(`SELECT id, email, used_bytes, quota_bytes FROM users WHERE status = 'active'`);
  for (const u of users) {
    const quota = quotaBytes(u);
    const used = u.used_bytes / quota;
    if (used >= pct) {
      await raiseAlert({
        kind: 'quota',
        key: String(u.id),
        severity: used >= 1 ? 'critical' : 'warn',
        title: used >= 1 ? `${u.email} is out of storage` : `${u.email} is almost out of storage`,
        detail: `${Math.round(used * 100)}% of ${Math.round(quota / 1024 / 1024)} MB used. ${used >= 1 ? 'New mail is being rejected.' : 'Raise the quota or ask them to clean up.'}`,
        link: `/admin/users/${u.id}`,
      });
    } else {
      resolveAlert('quota', String(u.id));
    }
  }
}

export async function runAlertChecks() {
  await checkProviders();
  await checkQueue();
  await checkQuotas();
}
