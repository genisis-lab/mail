/**
 * Compromised-account guard. Someone who suddenly sends a burst of mail, or
 * whose mail hard-bounces a lot (a stolen password used for spam), has their
 * sending paused: sends are refused and anything already queued is held
 * (outbound.ts), while reading and receiving go on. Admins are alerted and
 * resume sending from the person's page; they can also pause it by hand.
 */
import { all, get, now, run } from '../db/index.js';
import { HttpError } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../settings.js';
import { raiseAlert, resolveAlert } from './alerts.js';
import { audit } from './audit.js';
import { getUser, type UserRow } from './users.js';

const log = logger('send-guard');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** The bounce rate means little on a handful of messages. */
const MIN_FOR_BOUNCE_RATE = 20;

export const pausedError = () =>
  new HttpError(403, 'Sending is paused for your account because of unusual activity. Contact your administrator to have it turned back on.', 'send_paused');

/** Messages sent in the last hour, counted like the daily limit (sentToday). Only since an admin last resumed sending. */
export function sentLastHour(userId: number, resumedAt: number | null = null): number {
  const since = Math.max(now() - HOUR, resumedAt ?? 0);
  return get<{ c: number }>(`SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND kind IN ('user','api') AND created_at > ? AND status != 'cancelled'`, [userId, since])?.c ?? 0;
}

/** Of the messages that went out in the last 24 hours (since sending was last resumed), how many hard-bounced for at least one recipient. */
export function bounceStats(userId: number, resumedAt: number | null = null): { sent: number; bounced: number } {
  const since = Math.max(now() - DAY, resumedAt ?? 0);
  const sent = get<{ c: number }>(`SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND kind IN ('user','api') AND status IN ('sent','failed') AND created_at > ?`, [userId, since])?.c ?? 0;
  const bounced =
    get<{ c: number }>(
      `SELECT COUNT(DISTINCT d.outbox_id) AS c FROM delivery_log d JOIN outbox o ON o.id = d.outbox_id
        WHERE d.user_id = ? AND d.event = 'bounced' AND d.created_at > ? AND o.kind IN ('user','api') AND o.created_at > ?`,
      [userId, since, since],
    )?.c ?? 0;
  return { sent, bounced };
}

/** Why this person's sending should be paused now, if it should. */
function tripped(user: Pick<UserRow, 'id' | 'send_resumed_at'>): string | null {
  const s = getSettings();
  if (!s['guard.enabled']) return null;
  const hour = sentLastHour(user.id, user.send_resumed_at);
  if (hour >= s['guard.maxPerHour']) return `Sent ${hour} messages in the last hour (the limit is ${s['guard.maxPerHour']})`;
  const { sent, bounced } = bounceStats(user.id, user.send_resumed_at);
  if (sent >= MIN_FOR_BOUNCE_RATE && (bounced / sent) * 100 >= s['guard.bounceRatePercent']) {
    return `${bounced} of ${sent} messages sent in the last 24 hours bounced (${Math.round((bounced / sent) * 100)}%, the limit is ${s['guard.bounceRatePercent']}%)`;
  }
  return null;
}

/**
 * Pause someone's sending. `by` is the admin who did it, or null for the
 * guard (which also alerts admins). False if it was already paused.
 */
export async function pauseSending(user: Pick<UserRow, 'id' | 'email'>, reason: string, by: number | null = null, ip?: string | null): Promise<boolean> {
  const paused = run('UPDATE users SET send_paused_at = ?, send_paused_reason = ? WHERE id = ? AND send_paused_at IS NULL', [now(), reason.slice(0, 500), user.id]).changes > 0;
  if (!paused) return false;
  audit(by, by ? 'admin.user_sending_paused' : 'guard.sending_paused', user.email, { reason }, ip);
  if (by === null) {
    log.warn(`Paused sending for ${user.email}: ${reason}`);
    await raiseAlert({
      kind: 'sending',
      key: String(user.id),
      severity: 'critical',
      title: `Sending paused for ${user.email}`,
      detail: `${reason}. This can mean the account was compromised. Their queued mail is held until you resume sending; check their recent sign-ins first.`,
      link: `/admin/users/${user.id}`,
    }).catch((err) => log.warn('Could not raise the alert', err));
  }
  return true;
}

/** Turn sending back on; held mail goes out with the next queue run. The guard starts counting afresh. */
export function resumeSending(userId: number): boolean {
  const resumed =
    run('UPDATE users SET send_paused_at = NULL, send_paused_reason = NULL, send_resumed_at = ? WHERE id = ? AND send_paused_at IS NOT NULL', [now(), userId]).changes > 0;
  resolveAlert('sending', String(userId));
  return resumed;
}

/**
 * Before a send is queued: refuse it while sending is paused, and pause it
 * when this send would go over the hourly burst or the bounce rate is too high.
 * `userIds` are the mailbox and the person pressing Send (a shared mailbox).
 */
export async function guardSend(userIds: number[]) {
  for (const id of [...new Set(userIds)]) {
    const user = getUser(id);
    if (!user) continue;
    if (user.send_paused_at) throw pausedError();
    const reason = tripped(user);
    if (reason) {
      await pauseSending(user, reason);
      throw pausedError();
    }
  }
}

/** Background check (with the alerts): people whose mail has been bouncing. */
export async function checkSendGuard() {
  if (!getSettings()['guard.enabled']) return;
  const ids = all<{ user_id: number }>(
    `SELECT DISTINCT d.user_id FROM delivery_log d JOIN users u ON u.id = d.user_id
      WHERE d.event = 'bounced' AND d.created_at > ? AND u.send_paused_at IS NULL`,
    [now() - DAY],
  );
  for (const { user_id } of ids) {
    const user = getUser(user_id);
    const reason = user && tripped(user);
    if (user && reason) await pauseSending(user, reason);
  }
}
