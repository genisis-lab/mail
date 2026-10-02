/**
 * Delivery status after the provider accepted a message (delivered, bounced,
 * complained, delayed), from provider event webhooks or bounce reports that
 * come back by email, plus the suppression list: addresses that hard-bounced
 * or reported spam aren't mailed again until an admin removes them.
 *
 * Events are matched to Wren's own sends by the provider's message id or the
 * message's Message-ID, and only for the recipients the message went to.
 * Events for mail sent some other way (another app on the same provider
 * account) are ignored.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { bounceNotice, type OutboxRow } from '../mail/outbound.js';
import type { DeliveryEvent } from '../providers/types.js';
import { suppress } from './suppressions.js';

const log = logger('delivery-events');

const cleanId = (id: string | null | undefined) => (id ?? '').replace(/[<>]/g, '').trim();

/** The send an event is about. A provider's webhook only reaches messages that went out through it. */
function findJob(providerId: number | null, e: DeliveryEvent): OutboxRow | undefined {
  const scope = providerId ? 'AND (o.provider_id = ? OR o.provider_id IS NULL)' : '';
  const scoped = providerId ? [providerId] : [];
  const pid = cleanId(e.providerMessageId);
  if (pid) {
    const job =
      get<OutboxRow>(`SELECT o.* FROM outbox o WHERE o.provider_message_id = ? ${scope} ORDER BY o.id DESC LIMIT 1`, [pid, ...scoped]) ??
      get<OutboxRow>(`SELECT o.* FROM outbox o WHERE o.provider_message_id = ? ${scope} ORDER BY o.id DESC LIMIT 1`, [`<${pid}>`, ...scoped]);
    if (job) return job;
  }
  // By Message-ID (some providers' ids are the Message-ID itself).
  for (const mid of [...new Set([cleanId(e.messageId), pid].filter(Boolean))]) {
    const job = get<OutboxRow>(
      `SELECT o.* FROM outbox o JOIN messages m ON m.id = o.message_id WHERE m.message_id = ? AND m.direction = 'out' ${scope} ORDER BY o.id DESC LIMIT 1`,
      [mid, ...scoped],
    );
    if (job) return job;
  }
  return undefined;
}

/**
 * Record events; returns how many matched one of Wren's messages.
 * `providerId` is null for bounce reports that came back by email.
 * `notify: false` skips Wren's own "couldn't be delivered" message (the
 * person already has the bounce in their inbox); `userIds` limits matches
 * to messages those people sent.
 */
export async function recordDeliveryEvents(providerId: number | null, events: DeliveryEvent[], opts: { notify?: boolean; userIds?: number[] } = {}): Promise<number> {
  let matched = 0;
  for (const e of events) {
    const job = findJob(providerId, e);
    // A bounce that came back by email only counts for the person who sent the original.
    if (!job || (opts.userIds && (!job.user_id || !opts.userIds.includes(job.user_id)))) continue;
    const sentTo: string[] = (JSON.parse(job.recipients) as string[]).map(normalizeEmail);
    const reported = [...new Set(e.recipients.map(normalizeEmail).filter(Boolean))];
    // Only addresses the message went to: a report can't suppress anyone else.
    const recipients = reported.length ? reported.filter((r) => sentTo.includes(r)) : sentTo;
    if (!recipients.length) continue;
    matched++;
    const event = e.type === 'bounced' && e.permanent === false ? 'deferred' : e.type;
    const label = recipients.join(', ');
    // Providers retry webhooks: record each event once.
    if (get('SELECT 1 FROM delivery_log WHERE outbox_id = ? AND event = ? AND recipients = ?', [job.id, event, label])) continue;
    const detail =
      e.type === 'bounced'
        ? `${e.permanent === false ? 'Temporary bounce' : 'Bounced'}${e.detail ? `: ${e.detail}` : ''}`
        : e.type === 'complained'
          ? 'The recipient marked it as spam'
          : e.type === 'delayed'
            ? `Delivery delayed${e.detail ? `: ${e.detail}` : ''}`
            : e.detail || 'Delivered to the recipient’s mail server';
    insert('INSERT INTO delivery_log (message_id, user_id, provider_id, outbox_id, event, recipients, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      job.message_id,
      job.user_id,
      providerId ?? job.provider_id,
      job.id,
      event,
      label,
      detail.slice(0, 2000),
      now(),
    ]);
    if (event === 'complained' || (event === 'bounced' && e.suppress !== false)) {
      for (const r of recipients) suppress(r, event === 'bounced' ? 'bounce' : 'complaint', e.detail ?? '', providerId ?? job.provider_id);
    }
    if (event === 'bounced') {
      // Tell the sender, like a bounce message would, and mark the message failed once every recipient has bounced.
      if (opts.notify !== false) {
        await bounceNotice(job, recipients.map((rcpt) => ({ rcpt, reason: e.detail || 'The receiving server rejected the message' }))).catch((err) => log.warn('Bounce notice failed', err));
      }
      const bounced = new Set(
        all<{ recipients: string }>(`SELECT recipients FROM delivery_log WHERE outbox_id = ? AND event = 'bounced'`, [job.id]).flatMap((r) => r.recipients.split(', ')),
      );
      if (job.message_id && sentTo.length && sentTo.every((r) => bounced.has(r))) {
        run(`UPDATE messages SET status = 'failed', last_error = ? WHERE id = ?`, [detail, job.message_id]);
      }
    }
  }
  return matched;
}
