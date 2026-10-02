/**
 * Delivery status after the provider accepted a message (delivered, bounced,
 * complained, delayed), from provider event webhooks, plus the suppression
 * list: addresses that hard-bounced or reported spam aren't mailed again until
 * an admin removes them.
 *
 * Events are matched to Wren's own sends by the provider's message id. Events
 * for mail sent some other way (another app on the same provider account) are
 * ignored.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { bounceNotice, type OutboxRow } from '../mail/outbound.js';
import type { DeliveryEvent } from '../providers/types.js';
import { suppress } from './suppressions.js';

const log = logger('delivery-events');

/** Record provider events; returns how many matched one of Wren's messages. */
export async function recordDeliveryEvents(providerId: number, events: DeliveryEvent[]): Promise<number> {
  let matched = 0;
  for (const e of events) {
    if (!e.providerMessageId) continue;
    const job = get<OutboxRow>('SELECT * FROM outbox WHERE provider_message_id = ? ORDER BY id DESC LIMIT 1', [e.providerMessageId]);
    if (!job) continue;
    matched++;
    const recipients = [...new Set(e.recipients.map(normalizeEmail).filter(Boolean))];
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
      providerId,
      job.id,
      event,
      label,
      detail.slice(0, 2000),
      now(),
    ]);
    if (event === 'bounced' || event === 'complained') {
      for (const r of recipients) suppress(r, event === 'bounced' ? 'bounce' : 'complaint', e.detail ?? '', providerId);
    }
    if (event === 'bounced') {
      // Tell the sender, like a bounce message would, and mark the message failed once every recipient has bounced.
      await bounceNotice(job, recipients.map((rcpt) => ({ rcpt, reason: e.detail || 'The receiving server rejected the message' }))).catch((err) => log.warn('Bounce notice failed', err));
      const sentTo: string[] = JSON.parse(job.recipients);
      const bounced = new Set(
        all<{ recipients: string }>(`SELECT recipients FROM delivery_log WHERE outbox_id = ? AND event = 'bounced'`, [job.id]).flatMap((r) => r.recipients.split(', ')),
      );
      if (job.message_id && sentTo.length && sentTo.every((r) => bounced.has(normalizeEmail(r)))) {
        run(`UPDATE messages SET status = 'failed', last_error = ? WHERE id = ?`, [detail, job.message_id]);
      }
    }
  }
  return matched;
}
