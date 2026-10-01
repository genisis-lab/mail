import type { Addr } from '../../shared/types.js';
import { all, get, insert, now, run } from '../db/index.js';
import { decryptJson } from '../lib/crypto.js';
import { domainOf, parseAddresses } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../settings.js';
import { availableOnThisPlatform, getProviderDef } from '../providers/registry.js';
import { ProviderError, type OutboundEmail, type ProviderContext } from '../providers/types.js';
import { isHostedDomain } from '../services/routing.js';
import { getBlob } from './blobs.js';
import { getHeader, parseMail } from './parse.js';
import { storeMessage } from './store.js';
import { escapeHtml } from './compose.js';

const log = logger('outbound');

export interface ProviderRow {
  id: number;
  name: string;
  type: string;
  config: string;
  enabled: number;
  is_default: number;
  inbound_token: string;
}

export interface OutboxRow {
  id: number;
  kind: 'user' | 'forward' | 'autoreply' | 'notice' | 'test' | 'api';
  message_id: number | null;
  user_id: number | null;
  mail_from: string;
  recipients: string;
  raw_blob: string;
  subject: string;
  provider_id: number | null;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

export const providerContext: ProviderContext = { fetch: (...args) => fetch(...args) };

export function loadProvider(id: number | null | undefined): (ProviderRow & { cfg: Record<string, any> }) | null {
  if (!id) return null;
  const row = get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
  if (!row) return null;
  let cfg: Record<string, any> = {};
  try {
    cfg = decryptJson(row.config);
  } catch (err) {
    log.error(`Cannot decrypt config for provider ${row.name}; was WREN_SECRET changed?`, err);
  }
  return { ...row, cfg };
}

/** Which outbound provider(s) handle mail from this domain. */
export function providersForDomain(domain: string): { primary: number | null; fallback: number | null } {
  const d = get<{ provider_id: number | null; fallback_provider_id: number | null }>(
    'SELECT provider_id, fallback_provider_id FROM domains WHERE name = ?',
    [domain.toLowerCase()],
  );
  const usable = (id: number | null | undefined) => {
    if (!id) return null;
    const p = get<{ type: string; enabled: number }>('SELECT type, enabled FROM providers WHERE id = ?', [id]);
    const def = p && getProviderDef(p.type);
    return p && p.enabled && def?.send && availableOnThisPlatform(def) ? id : null;
  };
  let primary = usable(d?.provider_id);
  if (!primary) {
    const def = all<{ id: number; type: string }>('SELECT id, type FROM providers WHERE enabled = 1 AND is_default = 1 ORDER BY id');
    primary = def.find((p) => {
      const d = getProviderDef(p.type);
      return d?.send && availableOnThisPlatform(d);
    })?.id ?? null;
  }
  const fallback = usable(d?.fallback_provider_id);
  return { primary, fallback: fallback !== primary ? fallback : null };
}

export interface EnqueueInput {
  kind: OutboxRow['kind'];
  userId?: number | null;
  messageId?: number | null;
  mailFrom: string;
  recipients: string[];
  rawBlob: string;
  subject?: string;
  sendAt?: number;
  providerId?: number | null;
}

export function enqueue(input: EnqueueInput): number {
  const rawBlob = input.rawBlob;
  const ts = now();
  return insert(
    `INSERT INTO outbox (kind, message_id, user_id, mail_from, recipients, raw_blob, subject, provider_id, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    [
      input.kind,
      input.messageId ?? null,
      input.userId ?? null,
      input.mailFrom,
      JSON.stringify([...new Set(input.recipients.map((r) => r.toLowerCase()))]),
      rawBlob,
      input.subject ?? '',
      input.providerId ?? null,
      input.sendAt ?? ts,
      ts,
      ts,
    ],
  );
}

const PASS_HEADERS = ['in-reply-to', 'references', 'message-id', 'auto-submitted', 'list-unsubscribe', 'list-unsubscribe-post', 'x-auto-response-suppress'];

/** Turn a stored raw message into the structured form adapters use. */
export async function toOutboundEmail(raw: Buffer, envelope: { from: string; to: string[] }): Promise<OutboundEmail> {
  const p = await parseMail(raw);
  const headers: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    let v = '';
    if (h === 'message-id' && p.messageId) v = `<${p.messageId}>`;
    else if (h === 'in-reply-to' && p.inReplyTo) v = `<${p.inReplyTo}>`;
    else if (h === 'references' && p.references.length) v = p.references.map((r) => `<${r}>`).join(' ');
    else if (!['message-id', 'in-reply-to', 'references'].includes(h)) v = getHeader(p, h);
    if (v) headers[h.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase()).replace('Message-Id', 'Message-ID')] = v;
  }
  return {
    from: p.from ?? { address: envelope.from },
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    replyTo: p.replyTo ? parseAddresses(p.replyTo) : [],
    subject: p.subject,
    text: p.text,
    html: p.html,
    headers,
    attachments: p.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      contentId: a.contentId,
      inline: a.inline,
    })),
    raw,
    messageId: p.messageId ?? '',
    envelope,
  };
}

function backoffMs(attempt: number): number {
  const steps = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3600_000, 4 * 3600_000];
  return steps[Math.min(attempt - 1, steps.length - 1)];
}

function logDelivery(job: OutboxRow, event: string, providerId: number | null, recipients: string[], detail = '') {
  insert(
    'INSERT INTO delivery_log (message_id, user_id, provider_id, event, recipients, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [job.message_id, job.user_id, providerId, event, recipients.join(', '), detail.slice(0, 2000), now()],
  );
}

/** Store a "delivery failed" notice in the sender's inbox, threaded with the original. */
export async function bounceNotice(job: OutboxRow, failed: { rcpt: string; reason: string }[]) {
  if (!job.user_id || !['user', 'api'].includes(job.kind)) return;
  const msg = job.message_id
    ? get<{ message_id: string | null; thread_id: number; subject: string }>('SELECT message_id, thread_id, subject FROM messages WHERE id = ?', [job.message_id])
    : undefined;
  const domain = domainOf(job.mail_from) || 'localhost';
  const rows = failed.map((f) => `<li><b>${escapeHtml(f.rcpt)}</b> — ${escapeHtml(f.reason)}</li>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif"><h3 style="margin:0 0 8px">Address not reached</h3>
<p>Your message <b>${escapeHtml(msg?.subject || job.subject || '(no subject)')}</b> couldn’t be delivered to:</p><ul>${rows}</ul>
<p style="color:#666;font-size:13px">If the problem is temporary you can open the message in Sent and press “Retry”.</p></div>`;
  const text = `Your message "${msg?.subject || job.subject}" couldn't be delivered to:\n${failed.map((f) => `  ${f.rcpt}: ${f.reason}`).join('\n')}`;
  await storeMessage({
    userId: job.user_id,
    folder: 'inbox',
    direction: 'in',
    messageId: `bounce.${job.id}.${Date.now()}@${domain}`,
    inReplyTo: msg?.message_id ?? null,
    references: msg?.message_id ? [msg.message_id] : [],
    threadId: msg?.thread_id ?? null,
    from: { address: `mailer-daemon@${domain}`, name: 'Mail Delivery Subsystem' },
    to: [{ address: job.mail_from }],
    cc: [],
    replyTo: null,
    subject: `Delivery Status Notification (Failure)`,
    text,
    html,
    date: now(),
    size: html.length,
    rawBlob: null,
    attachments: [],
    source: 'system',
  });
}

function markProvider(providerId: number, ok: boolean, error?: string) {
  if (ok) run('UPDATE providers SET sent_count = sent_count + 1, last_used_at = ? WHERE id = ?', [now(), providerId]);
  else run('UPDATE providers SET failed_count = failed_count + 1, last_error = ?, last_error_at = ? WHERE id = ?', [error ?? '', now(), providerId]);
}

/** Local delivery is injected to avoid an import cycle with the ingest pipeline. */
type LocalDeliver = (raw: Buffer, rcpt: string[], mailFrom: string, userId: number | null) => Promise<{ accepted: string[]; rejected: { rcpt: string; reason: string }[] }>;
let localDeliver: LocalDeliver | null = null;
export function setLocalDeliver(fn: LocalDeliver) {
  localDeliver = fn;
}

async function deliver(job: OutboxRow) {
  const recipients: string[] = JSON.parse(job.recipients);
  const raw = await getBlob(job.raw_blob);
  const settings = getSettings();
  const local = settings['mail.localDelivery'] ? recipients.filter((r) => isHostedDomain(domainOf(r))) : [];
  const external = recipients.filter((r) => !local.includes(r));
  const failures: { rcpt: string; reason: string }[] = [];
  let providerMessageId: string | null = null;
  let usedProvider: number | null = null;

  if (local.length && localDeliver) {
    const res = await localDeliver(raw, local, job.mail_from, job.user_id);
    failures.push(...res.rejected);
    if (res.accepted.length) logDelivery(job, 'delivered', null, res.accepted, 'Local delivery');
    // Never deliver locally twice on retries.
    run('UPDATE outbox SET recipients = ? WHERE id = ?', [JSON.stringify(external), job.id]);
  }

  if (external.length) {
    const ids = job.provider_id ? { primary: job.provider_id, fallback: null } : providersForDomain(domainOf(job.mail_from));
    if (!ids.primary) {
      failures.push(...external.map((rcpt) => ({ rcpt, reason: `No outbound provider is configured for ${domainOf(job.mail_from)}` })));
      return finish(job, failures, null, null, failures.length >= recipients.length);
    }
    const email = await toOutboundEmail(raw, { from: job.mail_from, to: external });
    let lastErr: ProviderError | null = null;
    for (const pid of [ids.primary, ids.fallback].filter((x): x is number => !!x)) {
      const p = loadProvider(pid);
      const def = p && getProviderDef(p.type);
      if (!p || !def?.send) continue;
      try {
        const result = await def.send(p.cfg, email, providerContext);
        providerMessageId = result.providerMessageId ?? null;
        usedProvider = pid;
        markProvider(pid, true);
        logDelivery(job, 'sent', pid, external, result.detail ?? `via ${p.name}`);
        lastErr = null;
        break;
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError((err as Error).message);
        lastErr = e;
        markProvider(pid, false, e.message);
        logDelivery(job, e.permanent ? 'rejected' : 'deferred', pid, external, `${p.name}: ${e.message}`);
        log.warn(`Send via ${p.name} failed (${e.permanent ? 'permanent' : 'temporary'}): ${e.message}`);
      }
    }
    if (lastErr) {
      const attempts = job.attempts + 1;
      if (!lastErr.permanent && attempts < settings['mail.maxRetries']) {
        run(`UPDATE outbox SET status = 'queued', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
          attempts,
          now() + backoffMs(attempts),
          lastErr.message,
          now(),
          job.id,
        ]);
        if (job.message_id) run(`UPDATE messages SET status = 'queued', last_error = ? WHERE id = ?`, [`Retrying: ${lastErr.message}`, job.message_id]);
        // Local failures are final even if the external part will be retried.
        if (failures.length) await bounceNotice(job, failures);
        return;
      }
      failures.push(...external.map((rcpt) => ({ rcpt, reason: lastErr!.message })));
      return finish(job, failures, usedProvider, null, failures.length >= recipients.length);
    }
  }
  return finish(job, failures, usedProvider, providerMessageId, failures.length >= recipients.length);
}

async function finish(job: OutboxRow, failures: { rcpt: string; reason: string }[], providerId: number | null, providerMessageId: string | null, allFailed: boolean) {
  const ts = now();
  const status = allFailed ? 'failed' : 'sent';
  const error = failures.length ? failures.map((f) => `${f.rcpt}: ${f.reason}`).join('; ') : null;
  run(`UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ?, provider_message_id = ?, provider_id = COALESCE(?, provider_id), updated_at = ? WHERE id = ?`, [
    status,
    error,
    providerMessageId,
    providerId,
    ts,
    job.id,
  ]);
  if (job.message_id) {
    run(
      `UPDATE messages SET status = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
         provider_id = COALESCE(?, provider_id), provider_message_id = COALESCE(?, provider_message_id), is_scheduled = 0
       WHERE id = ?`,
      [status, error, status, ts, providerId, providerMessageId, job.message_id],
    );
  }
  if (failures.length) {
    logDelivery(job, 'failed', providerId, failures.map((f) => f.rcpt), error ?? '');
    await bounceNotice(job, failures);
  }
}

let running = false;

/** Process due outbox jobs. Safe to call repeatedly; only one run at a time. */
export async function processQueue(limit = 20): Promise<number> {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    const due = all<OutboxRow>(`SELECT * FROM outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`, [now(), limit]);
    const claimed = due.filter((j) => run(`UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'`, [now(), j.id]).changes === 1);
    for (const j of claimed) if (j.message_id) run(`UPDATE messages SET status = 'sending' WHERE id = ?`, [j.message_id]);
    const concurrency = 4;
    for (let i = 0; i < claimed.length; i += concurrency) {
      await Promise.all(
        claimed.slice(i, i + concurrency).map(async (job) => {
          try {
            await deliver(job);
          } catch (err) {
            log.error(`Outbox job ${job.id} crashed`, err);
            const attempts = job.attempts + 1;
            run(`UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
              attempts >= getSettings()['mail.maxRetries'] ? 'failed' : 'queued',
              attempts,
              now() + backoffMs(attempts),
              (err as Error).message,
              now(),
              job.id,
            ]);
          }
          processed++;
        }),
      );
    }
  } finally {
    running = false;
  }
  return processed;
}

/** Jobs interrupted by a crash/restart go back to the queue. */
export function recoverQueue() {
  run(`UPDATE outbox SET status = 'queued' WHERE status = 'sending'`);
  run(`UPDATE messages SET status = 'queued' WHERE status = 'sending'`);
}

/** Cancel a queued (scheduled / undo-able) send. Returns true if it was still cancellable. */
export function cancelOutbox(messageId: number): boolean {
  const r = run(`UPDATE outbox SET status = 'cancelled', updated_at = ? WHERE message_id = ? AND status = 'queued'`, [now(), messageId]);
  return r.changes > 0;
}

export function retryOutbox(outboxId: number): boolean {
  const job = get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [outboxId]);
  if (!job || !['failed', 'cancelled'].includes(job.status)) return false;
  // Re-derive recipients from the stored message if the job already consumed them.
  let recipients: string[] = JSON.parse(job.recipients);
  if (!recipients.length && job.message_id) {
    const m = get<{ to_json: string; cc_json: string; bcc_json: string }>('SELECT to_json, cc_json, bcc_json FROM messages WHERE id = ?', [job.message_id]);
    if (m) recipients = [...JSON.parse(m.to_json), ...JSON.parse(m.cc_json), ...JSON.parse(m.bcc_json)].map((a: Addr) => a.address);
  }
  run(`UPDATE outbox SET status = 'queued', recipients = ?, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`, [
    JSON.stringify(recipients),
    now(),
    now(),
    outboxId,
  ]);
  if (job.message_id) run(`UPDATE messages SET status = 'queued', last_error = NULL WHERE id = ?`, [job.message_id]);
  return true;
}

