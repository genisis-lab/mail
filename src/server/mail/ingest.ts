import type { Folder } from '../../shared/types.js';
import { all, get, insert, now, run } from '../db/index.js';
import { domainOf, formatAddr, isNoReply, matchesPattern, normalizeEmail } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../settings.js';
import { getPrefs, getUser, quotaBytes, userAddresses } from '../services/users.js';
import { isHostedDomain, recordCatchAllHit, resolveRecipient } from '../services/routing.js';
import { putBlob } from './blobs.js';
import { buildMime, textToHtml } from './compose.js';
import { applyFilters, toMatchable } from './filters.js';
import { enqueue, setLocalDeliver } from './outbound.js';
import { getHeader, parseMail, type Parsed } from './parse.js';
import { checkSpam, type SpamVerdict } from './spam.js';
import { storeMessage } from './store.js';
import { categorize } from './categorize.js';
import { readReport } from './dsn.js';
import { recordDeliveryEvents } from '../services/delivery-events.js';
import { verifyDomainsByRouting } from '../services/dns.js';
import { markRoundtripReceived, roundtripToken } from '../services/checklist.js';
import { notifyNewMail } from '../services/push.js';

const log = logger('ingest');

export interface IngestOptions {
  rcptTo?: string[];
  mailFrom?: string;
  source: string;
  providerId?: number | null;
  verdicts?: Record<string, string>;
  providerScore?: number;
  skipSpam?: boolean;
  /** Sender's user id for local deliveries (skips spam, enables trust). */
  localSenderId?: number | null;
}

export interface IngestResult {
  accepted: string[];
  rejected: { rcpt: string; reason: string }[];
  delivered: number;
}

const MAX_FORWARD_HOPS = 3;

function logInbound(opts: IngestOptions, p: Parsed | null, rcpt: string, status: string, reason: string, size: number) {
  insert(
    `INSERT INTO inbound_log (source, provider_id, mail_from, rcpt_to, subject, message_id, size, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.source, opts.providerId ?? null, opts.mailFrom ?? p?.from?.address ?? '', rcpt, p?.subject ?? '', p?.messageId ?? null, size, status, reason, now()],
  );
}

function isGloballyBlocked(sender: string): boolean {
  return all<{ pattern: string }>('SELECT pattern FROM blocked_senders WHERE user_id IS NULL').some((r) => matchesPattern(sender, r.pattern));
}

function isUserBlocked(userId: number, sender: string): boolean {
  return all<{ pattern: string }>('SELECT pattern FROM blocked_senders WHERE user_id = ?', [userId]).some((r) => matchesPattern(sender, r.pattern));
}

function contactInfo(userId: number, address: string) {
  return get<{ saved: number; times_contacted: number }>('SELECT saved, times_contacted FROM contacts WHERE user_id = ? AND email = ?', [userId, address.toLowerCase()]);
}

/** Main entry point: every inbound message (SMTP, webhook, local) flows through here. */
export async function ingest(raw: Buffer, opts: IngestOptions): Promise<IngestResult> {
  const result: IngestResult = { accepted: [], rejected: [], delivered: 0 };
  let p: Parsed;
  try {
    p = await parseMail(raw);
  } catch (err) {
    log.warn('Failed to parse message', err);
    logInbound(opts, null, (opts.rcptTo ?? []).join(', '), 'error', 'unparseable message', raw.length);
    throw err;
  }

  // Envelope recipients, or fall back to header recipients on hosted domains.
  let rcpts = (opts.rcptTo ?? []).map(normalizeEmail).filter(Boolean);
  if (!rcpts.length) {
    rcpts = [...p.deliveredTo, ...p.to.map((a) => a.address), ...p.cc.map((a) => a.address)].filter((a) => isHostedDomain(domainOf(a)));
  }
  rcpts = [...new Set(rcpts)];
  const sender = normalizeEmail(p.from?.address ?? opts.mailFrom ?? '');

  if (!opts.localSenderId && sender && isGloballyBlocked(sender)) {
    for (const r of rcpts) {
      result.rejected.push({ rcpt: r, reason: 'sender blocked' });
      logInbound(opts, p, r, 'rejected', 'sender blocked by administrator', raw.length);
    }
    return result;
  }

  // Resolve every recipient to local users / external forwards.
  const userTargets = new Map<number, string>(); // userId -> address it was delivered to
  const externalTargets = new Map<string, string>(); // external address -> hosted address it came through
  for (const r of rcpts) {
    const res = resolveRecipient(r);
    if (!res.userIds.length && !res.external.length) {
      result.rejected.push({ rcpt: r, reason: res.reason ?? 'no such mailbox' });
      logInbound(opts, p, r, 'rejected', res.reason ?? 'no such mailbox', raw.length);
      continue;
    }
    result.accepted.push(r);
    if (res.catchAll) recordCatchAllHit(r, p.from?.address ?? opts.mailFrom ?? '', p.subject);
    for (const u of res.userIds) if (!userTargets.has(u)) userTargets.set(u, r);
    for (const e of res.external) if (!externalTargets.has(e)) externalTargets.set(e, r);
  }
  if (!userTargets.size && !externalTargets.size) return result;
  if (opts.source === 'cloudflare-routing') verifyDomainsByRouting(result.accepted);
  // A bounce or spam report about something we sent: record it like a provider's webhook would (any provider).
  const report = opts.localSenderId ? null : readReport(p);
  if (report?.length) {
    await recordDeliveryEvents(null, report, { notify: false, userIds: [...userTargets.keys()] }).catch((err) => log.warn('Could not read bounce report', err));
  }
  const roundtrip = roundtripToken(p, getHeader(p, 'x-wren-roundtrip'));
  if (roundtrip) markRoundtripReceived(roundtrip);

  const rawBlob = await putBlob(raw);
  const spam: SpamVerdict | null =
    opts.skipSpam || opts.localSenderId
      ? null
      : await checkSpam(p, raw, { verdicts: opts.verdicts, providerScore: opts.providerScore, mailFrom: opts.mailFrom, rcptTo: rcpts });

  for (const [userId, rcpt] of userTargets) {
    try {
      const outcome = await deliverToUser(userId, rcpt, p, raw, rawBlob, spam, opts);
      if (outcome.stored) result.delivered++;
      logInbound(opts, p, rcpt, outcome.status, outcome.reason, raw.length);
      if (outcome.status === 'rejected') {
        result.accepted = result.accepted.filter((a) => a !== rcpt);
        result.rejected.push({ rcpt, reason: outcome.reason });
      }
    } catch (err) {
      log.error(`Delivery to user ${userId} failed`, err);
      logInbound(opts, p, rcpt, 'error', (err as Error).message, raw.length);
    }
  }

  // A recognised delivery test has done its job: keep it out of the inbox (it stays searchable in All Mail).
  if (roundtrip && p.messageId && result.delivered) {
    run(`UPDATE messages SET folder = 'archive', is_read = 1 WHERE message_id = ? AND direction = 'in' AND user_id IN (SELECT value FROM json_each(?))`, [
      p.messageId,
      JSON.stringify([...userTargets.keys()]),
    ]);
  }

  // Group members outside this server.
  if (externalTargets.size && !(spam?.isSpam ?? false)) {
    const byVia = new Map<string, string[]>();
    for (const [ext, via] of externalTargets) byVia.set(via, [...(byVia.get(via) ?? []), ext]);
    for (const [via, list] of byVia) {
      await forwardCopy(p, raw, via, list, null).catch((err) => log.warn('Group forward failed', err));
    }
  }

  if (opts.providerId) run('UPDATE providers SET received_count = received_count + 1 WHERE id = ?', [opts.providerId]);
  return result;
}

async function deliverToUser(
  userId: number,
  rcpt: string,
  p: Parsed,
  raw: Buffer,
  rawBlob: string,
  spam: SpamVerdict | null,
  opts: IngestOptions,
): Promise<{ stored: boolean; status: string; reason: string }> {
  const user = getUser(userId);
  if (!user) return { stored: false, status: 'rejected', reason: 'no such user' };

  if (p.messageId && get('SELECT 1 FROM messages WHERE user_id = ? AND message_id = ? AND direction = ?', [userId, p.messageId, 'in'])) {
    return { stored: false, status: 'duplicate', reason: 'already delivered' };
  }
  if (user.used_bytes + raw.length > quotaBytes(user)) {
    return { stored: false, status: 'rejected', reason: 'mailbox full' };
  }

  const prefs = getPrefs(userId);
  const sender = normalizeEmail(p.from?.address ?? '');
  const filters = applyFilters(userId, toMatchable(p));
  const a = filters.actions;
  const contact = sender ? contactInfo(userId, sender) : undefined;
  const threshold = getSettings()['spam.threshold'];

  let folder: Folder = 'inbox';
  let reason = '';
  const blocked = sender && isUserBlocked(userId, sender);
  const spammy = spam?.isSpam && !(contact && spam.score < threshold + 5);
  if (blocked) {
    folder = 'spam';
    reason = 'sender blocked by user';
  } else if (a.alwaysSpam) {
    folder = 'spam';
    reason = 'filter';
  } else if (spammy && !a.neverSpam) {
    folder = 'spam';
    reason = `spam score ${spam!.score}`;
  } else if (a.trash) {
    folder = 'trash';
  } else if (a.skipInbox) {
    folder = 'archive';
  }

  const fwd = prefs.forwarding;
  let isRead = !!a.markRead;
  if (folder === 'inbox' && fwd.enabled && fwd.to) {
    if (fwd.keep === 'archive') folder = 'archive';
    if (fwd.keep === 'trash') folder = 'trash';
    if (fwd.keep === 'read') isRead = true;
  }

  const important = !!a.important || (!p.listId && !!contact && contact.times_contacted >= 3);
  const category = categorize(p, {
    userId,
    knownContact: !!contact && (!!contact.saved || contact.times_contacted > 0),
    internal: opts.source === 'system' || !!opts.localSenderId,
  });
  const unsubscribe = getHeader(p, 'list-unsubscribe');

  const id = await storeMessage({
    userId,
    folder,
    direction: 'in',
    messageId: p.messageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    from: p.from,
    to: p.to,
    cc: p.cc,
    replyTo: p.replyTo,
    subject: p.subject,
    text: p.text,
    html: p.html,
    date: p.date,
    size: raw.length,
    rawBlob,
    attachments: p.attachments,
    isRead,
    isStarred: !!a.star,
    isImportant: important,
    source: opts.source,
    spamScore: spam?.score ?? null,
    authResults: spam ? { ...spam.auth, engine: spam.engine, reasons: spam.reasons.join('; ') } : null,
    labelIds: filters.labelIds.filter((l) => !!get('SELECT 1 FROM labels WHERE id = ? AND user_id = ?', [l, userId])),
    deliveredTo: rcpt,
    category,
    listUnsubscribe: unsubscribe || null,
    listUnsubscribePost: getHeader(p, 'list-unsubscribe-post') || null,
  });
  if (folder === 'trash') run('UPDATE messages SET trashed_at = ? WHERE id = ?', [now(), id]);
  if (folder === 'inbox' && !isRead && opts.source !== 'system') notifyNewMail(userId);

  if (folder !== 'spam') {
    const targets = [...filters.forwardTo, ...(fwd.enabled && fwd.to ? [fwd.to] : [])];
    if (targets.length && getSettings()['mail.allowExternalForwarding']) {
      await forwardCopy(p, raw, rcpt, targets, userId).catch((err) => log.warn('Forward failed', err));
    }
    if (prefs.vacation.enabled) {
      await maybeAutoReply(userId, rcpt, p).catch((err) => log.warn('Auto-reply failed', err));
    }
  }
  return { stored: true, status: folder === 'spam' ? 'spam' : 'accepted', reason: reason || folder };
}

function forwardHops(p: Parsed): number {
  return (p.headers.get('x-wren-forwarded') ?? []).flatMap((v) => v.split(',')).filter((v) => v.trim()).length;
}

/**
 * Forward a copy to external addresses. The From is rewritten to the hosted
 * address (so SPF/DKIM/DMARC pass at the provider) and Reply-To points back
 * to the original sender.
 */
async function forwardCopy(p: Parsed, raw: Buffer, via: string, to: string[], userId: number | null) {
  if (forwardHops(p) >= MAX_FORWARD_HOPS) {
    log.warn(`Not forwarding message ${p.messageId}: hop limit reached`);
    return;
  }
  const targets = to.map(normalizeEmail).filter((t) => t && t !== via.toLowerCase());
  if (!targets.length) return;
  const origName = p.from?.name || p.from?.address || 'Unknown sender';
  const prior = getHeader(p, 'x-wren-forwarded');
  const { raw: fwdRaw } = await buildMime({
    from: { address: via, name: `${origName} via ${via}`.slice(0, 120) },
    to: p.to.length ? p.to : [{ address: via }],
    cc: p.cc,
    replyTo: p.replyTo || (p.from ? formatAddr(p.from) : null),
    subject: p.subject,
    html: p.html ?? (p.text ? textToHtml(p.text) : null),
    text: p.text,
    inReplyTo: p.inReplyTo,
    references: p.references,
    attachments: p.attachments,
    headers: {
      'X-Wren-Forwarded': prior ? `${prior}, ${via}` : via,
      'X-Original-From': p.from ? formatAddr(p.from) : '',
      ...(p.messageId ? { 'X-Original-Message-ID': `<${p.messageId}>` } : {}),
    },
  });
  enqueue({ kind: 'forward', userId, mailFrom: via, recipients: targets, rawBlob: await putBlob(fwdRaw), subject: p.subject });
}

const AUTOREPLY_INTERVAL = 4 * 24 * 3600 * 1000;

async function maybeAutoReply(userId: number, rcpt: string, p: Parsed) {
  const prefs = getPrefs(userId);
  const v = prefs.vacation;
  const t = now();
  if (!v.enabled || (v.startAt && t < v.startAt) || (v.endAt && t > v.endAt)) return;
  if (p.automated || !p.from) return;
  const replyTo = normalizeEmail((p.replyTo?.split(',')[0] ?? '') || p.from.address);
  if (!replyTo || isNoReply(replyTo)) return;
  const mine = userAddresses(userId);
  if (mine.includes(replyTo)) return;
  if (v.contactsOnly && !contactInfo(userId, replyTo)) return;
  const last = get<{ sent_at: number }>('SELECT sent_at FROM autoreply_log WHERE user_id = ? AND sender = ?', [userId, replyTo]);
  if (last && t - last.sent_at < AUTOREPLY_INTERVAL) return;
  // Claim the slot before any await so concurrent deliveries can't double-reply.
  run(
    'INSERT INTO autoreply_log (user_id, sender, sent_at) VALUES (?, ?, ?) ON CONFLICT(user_id, sender) DO UPDATE SET sent_at = excluded.sent_at',
    [userId, replyTo, t],
  );

  const user = getUser(userId)!;
  const fromAddr = mine.includes(rcpt.toLowerCase()) ? rcpt : user.email;
  const subject = v.subject || `Re: ${p.subject}`;
  const html = /<[a-z][\s\S]*>/i.test(v.message) ? v.message : textToHtml(v.message);
  const { raw } = await buildMime({
    from: { address: fromAddr, name: user.name },
    to: [{ address: replyTo }],
    subject,
    html,
    inReplyTo: p.messageId,
    references: p.messageId ? [...p.references, p.messageId] : p.references,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', Precedence: 'auto_reply' },
  });
  enqueue({ kind: 'autoreply', userId, mailFrom: fromAddr, recipients: [replyTo], rawBlob: await putBlob(raw), subject });
}

// Outbound mail to hosted addresses is delivered straight into local mailboxes.
setLocalDeliver(async (raw, rcpt, mailFrom, userId) => {
  const res = await ingest(raw, { rcptTo: rcpt, mailFrom, source: 'local', localSenderId: userId ?? undefined, skipSpam: !!userId });
  return { accepted: res.accepted, rejected: res.rejected };
});
