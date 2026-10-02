/**
 * One-click unsubscribe from mailing lists (List-Unsubscribe, RFC 2369 and
 * RFC 8058). Prefers the one-click HTTPS POST, then an unsubscribe email from
 * the address the list mails, and otherwise hands the link to the browser.
 */
import { get, now, run } from '../db/index.js';
import { domainOf, normalizeEmail } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { buildMime } from '../mail/compose.js';
import { putBlob } from '../mail/blobs.js';
import { enqueue } from '../mail/outbound.js';
import { parseListUnsubscribe } from '../mail/categorize.js';
import { isHostedDomain } from './routing.js';
import { getUser, userAddresses } from './users.js';

const log = logger('unsubscribe');

export type UnsubscribeResult = { method: 'one-click' | 'email'; sender: string } | { method: 'link'; url: string; sender: string };

/** Only public HTTPS hosts; never an IP address or a private name. */
export function isPublicHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    host.includes('.') &&
    !/^[\d.]+$/.test(host) &&
    !host.includes(':') &&
    !host.startsWith('[') &&
    !/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(host)
  );
}

export async function unsubscribe(userId: number, messageId: number): Promise<UnsubscribeResult> {
  const m = get<{ from_addr: string; subject: string; delivered_to: string | null; list_unsubscribe: string | null; list_unsubscribe_post: string | null }>(
    `SELECT from_addr, subject, delivered_to, list_unsubscribe, list_unsubscribe_post FROM messages WHERE id = ? AND user_id = ? AND direction = 'in'`,
    [messageId, userId],
  );
  if (!m?.list_unsubscribe) throw new Error('This message has no unsubscribe link');
  const { http, mailto } = parseListUnsubscribe(m.list_unsubscribe);
  const sender = normalizeEmail(m.from_addr);
  const done = (method: string) =>
    run(
      `INSERT INTO unsubscribes (user_id, sender, method, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, sender) DO UPDATE SET method = excluded.method, created_at = excluded.created_at`,
      [userId, sender, method, now()],
    );

  // RFC 8058: a POST with this exact body, no cookies, no redirects followed.
  if (http && isPublicHttpsUrl(http) && /List-Unsubscribe=One-Click/i.test(m.list_unsubscribe_post ?? '')) {
    try {
      const res = await fetch(http, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 400) {
        done('one-click');
        return { method: 'one-click', sender };
      }
      log.warn(`One-click unsubscribe for ${sender} returned ${res.status}`);
    } catch (err) {
      log.warn(`One-click unsubscribe for ${sender} failed`, err);
    }
  }

  if (mailto) {
    let target: URL | null = null;
    try {
      target = new URL(mailto);
    } catch {
      target = null;
    }
    const to = target ? normalizeEmail(decodeURIComponent(target.pathname)) : '';
    if (to && to.includes('@')) {
      const user = getUser(userId)!;
      // Write from the address the list mails, so it knows who to remove.
      const own = new Set(userAddresses(userId));
      const from = m.delivered_to && (own.has(m.delivered_to.toLowerCase()) || isHostedDomain(domainOf(m.delivered_to))) ? m.delivered_to : user.email;
      const subject = target?.searchParams.get('subject') || 'unsubscribe';
      const text = target?.searchParams.get('body') || 'unsubscribe';
      const { raw } = await buildMime({ from: { address: from, name: user.name }, to: [{ address: to }], subject, text, html: null, headers: { 'Auto-Submitted': 'auto-generated' } });
      enqueue({ kind: 'notice', userId, mailFrom: from, recipients: [to], rawBlob: await putBlob(raw), subject });
      done('email');
      return { method: 'email', sender };
    }
  }

  if (http && /^https?:\/\//i.test(http)) {
    done('link');
    return { method: 'link', url: http, sender };
  }
  throw new Error('This message has no unsubscribe link Wren can use');
}
