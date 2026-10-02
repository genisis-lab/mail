/**
 * Bounce messages (RFC 3464 delivery status notifications) and spam reports
 * (RFC 5965 abuse feedback) that come back by email. Providers without
 * event webhooks (SMTP relays, Cloudflare Email Service) report failures
 * this way, so reading them gives every provider bounce handling and the
 * suppression list.
 */
import type { DeliveryEvent } from '../providers/types.js';
import { normalizeEmail } from '../lib/addr.js';
import type { Parsed } from './parse.js';

const text = (b: Buffer) => b.toString('utf8');

/** "Name: value" lines, unfolded; blocks separated by blank lines. */
function fieldBlocks(body: string): Record<string, string>[] {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]+/g, ' ')
    .split(/\n\s*\n/)
    .map((block) => {
      const out: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return out;
    })
    .filter((b) => Object.keys(b).length);
}

const address = (v: string | undefined) => normalizeEmail((v ?? '').replace(/^[a-z0-9-]+;\s*/i, '').replace(/[<>]/g, ''));

/** The Message-ID of the message a report is about. */
function originalMessageId(p: Parsed): string | null {
  for (const a of p.attachments) {
    if (!/^(message\/rfc822|text\/rfc822-headers|message\/rfc822-headers|message\/global(-headers)?)$/i.test(a.contentType)) continue;
    const head = text(a.content).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
    const m = /^message-id:\s*<?([^>\s]+)>?/im.exec(head);
    if (m) return m[1];
  }
  // Some servers only thread the report to the original.
  return p.inReplyTo ?? null;
}

/** Statuses that mean the address itself is bad (vs. a message refused for its content or by policy). */
export function badMailbox(status: string, diagnostic: string): boolean {
  if (/^5\.1\.(1|2|3|6|10)$/.test(status) || status === '5.2.1') return true;
  return /^5\./.test(status) && /user unknown|no such (user|mailbox|recipient)|does not exist|unknown (user|recipient)|mailbox (unavailable|not found)|invalid (recipient|mailbox)|recipient (rejected|not found)|account (disabled|has been disabled)/i.test(diagnostic);
}

/** A bounce or spam report about a message, as delivery events; null when the message isn't one. */
export function readReport(p: Parsed): DeliveryEvent[] | null {
  const ct = (p.headers.get('content-type')?.[0] ?? '').toLowerCase();
  const dsnPart = p.attachments.find((a) => /^message\/(global-)?delivery-status$/i.test(a.contentType));
  const arfPart = p.attachments.find((a) => /^message\/feedback-report$/i.test(a.contentType));
  const isReport = ct.startsWith('multipart/report') || !!dsnPart || !!arfPart;
  if (!isReport) return null;
  const messageId = originalMessageId(p);

  if (arfPart || /report-type="?feedback-report/.test(ct)) {
    const fields = fieldBlocks(arfPart ? text(arfPart.content) : '')[0] ?? {};
    const rcpt = address(fields['original-rcpt-to'] ?? fields['removal-recipient']);
    return [{ messageId, type: 'complained', recipients: rcpt ? [rcpt] : [], detail: fields['feedback-type'] ?? 'abuse' }];
  }

  if (!dsnPart) return null;
  const events: DeliveryEvent[] = [];
  // The first block describes the reporting server; the rest are one per recipient.
  for (const r of fieldBlocks(text(dsnPart.content))) {
    const rcpt = address(r['final-recipient'] ?? r['original-recipient']);
    const action = (r['action'] ?? '').toLowerCase();
    if (!rcpt || !action) continue;
    const status = (/\d\.\d{1,3}\.\d{1,3}/.exec(r['status'] ?? '') ?? [''])[0];
    const diagnostic = (r['diagnostic-code'] ?? '').replace(/^[a-z-]+;\s*/i, '');
    const detail = [status, diagnostic].filter(Boolean).join(' ');
    if (action === 'failed') {
      const permanent = !status.startsWith('4');
      events.push({ messageId, type: 'bounced', recipients: [rcpt], permanent, suppress: permanent && badMailbox(status, diagnostic), detail });
    } else if (action === 'delayed') {
      events.push({ messageId, type: 'delayed', recipients: [rcpt], detail });
    } else if (action === 'delivered' || action === 'relayed' || action === 'expanded') {
      events.push({ messageId, type: 'delivered', recipients: [rcpt], detail: detail || action });
    }
  }
  return events;
}
