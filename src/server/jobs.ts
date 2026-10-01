import { all, get, now, run } from './db/index.js';
import { logger } from './lib/log.js';
import { getSettings } from './settings.js';
import { collectGarbage } from './mail/blobs.js';
import { processQueue, recoverQueue } from './mail/outbound.js';
import { purgeMessages } from './mail/store.js';
import { wakeSnoozed } from './mail/threads.js';

const log = logger('jobs');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
let lastMaintenance = 0;
let lastGc = 0;

/** Empty trash/spam past retention and drop expired sessions and old logs. */
export function runMaintenance() {
  const s = getSettings();
  const ts = now();
  const trash = all<{ id: number }>(`SELECT id FROM messages WHERE folder = 'trash' AND COALESCE(trashed_at, date) < ?`, [ts - s['retention.trashDays'] * DAY]);
  const spam = all<{ id: number }>(`SELECT id FROM messages WHERE folder = 'spam' AND date < ?`, [ts - s['retention.spamDays'] * DAY]);
  purgeMessages([...trash, ...spam].map((r) => r.id));
  run('DELETE FROM sessions WHERE expires_at < ?', [ts]);
  run('DELETE FROM login_attempts WHERE reset_at < ?', [ts]);
  run('DELETE FROM inbound_log WHERE created_at < ?', [ts - 90 * DAY]);
  run('DELETE FROM delivery_log WHERE created_at < ?', [ts - 90 * DAY]);
  run(`DELETE FROM outbox WHERE status IN ('sent','cancelled') AND updated_at < ?`, [ts - 30 * DAY]);
  run('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?', [ts - DAY]);
  run('DELETE FROM autoreply_log WHERE sent_at < ?', [ts - 30 * DAY]);
  if (trash.length || spam.length) log.info(`Retention: purged ${trash.length} trash and ${spam.length} spam messages`);
}

/**
 * Run whatever background work is due: the outbound queue, snooze wake-ups,
 * hourly maintenance and daily blob GC. Called by the Node timers and by the
 * Durable Object alarm on Workers.
 */
export async function runDueWork(opts: { gc?: boolean } = {}) {
  await processQueue();
  wakeSnoozed();
  const ts = now();
  if (ts - lastMaintenance > HOUR) {
    lastMaintenance = ts;
    runMaintenance();
  }
  if (opts.gc !== false && ts - lastGc > DAY) {
    lastGc = ts;
    const r = await collectGarbage();
    if (r.removed) log.info(`Blob GC removed ${r.removed} objects (${r.bytes} bytes)`);
  }
}

/** When background work should next run (used to schedule Workers alarms). */
export function nextWakeAt(): number {
  const ts = now();
  const queue = get<{ t: number | null }>(`SELECT MIN(next_attempt_at) AS t FROM outbox WHERE status = 'queued'`)?.t ?? Infinity;
  const snooze = get<{ t: number | null }>(`SELECT MIN(snoozed_until) AS t FROM messages WHERE snoozed_until IS NOT NULL`)?.t ?? Infinity;
  const maintenance = (lastMaintenance || ts) + HOUR;
  return Math.max(ts + 500, Math.min(queue, snooze, maintenance));
}

// ── Node.js timers ──────────────────────────────────────────────────────────

const timers: ReturnType<typeof setInterval>[] = [];

export function startNodeJobs(queueIntervalMs: number) {
  recoverQueue();
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueWork();
    } catch (err) {
      log.error('Background work failed', err);
    } finally {
      busy = false;
    }
  }, queueIntervalMs);
  (t as any).unref?.();
  timers.push(t);
}

export function stopJobs() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
