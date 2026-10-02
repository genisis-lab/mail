/**
 * Inbox tabs: sort incoming mail into Primary, Updates (receipts, alerts,
 * notifications) and Promotions (newsletters, offers).
 *
 * It errs towards Primary: mail written by a person, without bulk-mail or
 * automation headers, always lands there. A sender the user moved to another
 * tab stays there (category_rules).
 */
import type { Category } from '../../shared/types.js';
import { get, listParam, IN_LIST } from '../db/index.js';
import { domainOf, normalizeEmail } from '../lib/addr.js';
import type { Parsed } from './parse.js';

export const CATEGORIES: Category[] = ['primary', 'updates', 'promotions'];

/** Headers bulk-mail services add (Mailchimp, SendGrid, Mailgun, Klaviyo, Braze…). */
const ESP_HEADERS = ['x-mailchimp-campaign', 'x-mc-user', 'x-campaign', 'x-campaignid', 'x-campaign-id', 'x-sg-eid', 'x-mailgun-tag', 'x-klaviyo', 'x-braze', 'x-marketo', 'x-hubspot', 'x-sfmc', 'x-iterable', 'x-cm-msg', 'x-emarsys', 'x-mailjet-campaign', 'x-sib-id', 'x-ccp'];
const PROMO_SUBJECT = /(\d+\s?% off|\bsale\b|\bdeals?\b|\bdiscount|\boffer\b|\bcoupon|promo code|free shipping|limited[- ]time|ends (today|tonight|soon)|last chance|don['’]t miss|\bexclusive\b|new arrivals|black friday|cyber monday|\bsave (up to )?[$£€]|\bnewsletter\b|\bwebinar\b)/i;
const UPDATE_SENDER = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|updates?|security|billing|invoices?|receipts?|orders?|bookings?|reservations?|confirmations?|tickets?|shipping|delivery|mailer-daemon|postmaster|bounces?|automated|system)([.+_-]|$)/;
const UPDATE_SUBJECT = /\b(receipt|invoice|your order|order (confirm|#|no\.?|number)|has shipped|out for delivery|delivered|tracking|payment|statement|subscription|renew|verify|verification|confirm your|is confirmed|security alert|sign[- ]?in|new login|password|2fa|one-time|code is|reminder|appointment|booking|reservation|itinerary|ticket|notification|mentioned you|commented|assigned to you|pull request|build (passed|failed)|alert:)/i;

const header = (p: Parsed, k: string) => p.headers.get(k)?.[0] ?? '';

export interface CategoryContext {
  userId: number;
  /** The sender is someone the user knows (a saved or corresponded-with contact). */
  knownContact: boolean;
  /** Mail from the server itself, or from another local user. */
  internal: boolean;
}

/** The tab a user has chosen for a sender (exact address, else the whole domain). */
export function learnedCategory(userId: number, sender: string): Category | null {
  const address = normalizeEmail(sender);
  if (!address) return null;
  const row = get<{ category: Category }>(
    `SELECT category FROM category_rules WHERE user_id = ? AND sender IN ${IN_LIST} ORDER BY length(sender) DESC LIMIT 1`,
    [userId, listParam([address, `@${domainOf(address)}`])],
  );
  return row?.category ?? null;
}

export function categorize(p: Parsed, ctx: CategoryContext): Category {
  if (ctx.internal) return 'primary';
  const sender = normalizeEmail(p.from?.address ?? '');
  const learned = sender ? learnedCategory(ctx.userId, sender) : null;
  if (learned) return learned;

  // A reply to something the user sent is a conversation.
  const refs = [p.inReplyTo, ...p.references].filter((x): x is string => !!x);
  if (refs.length && get(`SELECT 1 FROM messages WHERE user_id = ? AND direction = 'out' AND message_id IN ${IN_LIST} LIMIT 1`, [ctx.userId, listParam(refs.slice(-50))])) {
    return 'primary';
  }

  const local = sender.split('@')[0] ?? '';
  const precedence = header(p, 'precedence').toLowerCase().trim();
  const autoSubmitted = header(p, 'auto-submitted').toLowerCase().trim();
  const unsubscribe = p.headers.has('list-unsubscribe');
  const esp = ESP_HEADERS.some((h) => p.headers.has(h)) || /campaign|newsletter|marketing|promo/i.test(header(p, 'feedback-id'));
  const bulk = unsubscribe || esp || precedence === 'bulk' || precedence === 'list';
  const automated = (autoSubmitted !== '' && autoSubmitted !== 'no') || UPDATE_SENDER.test(local) || p.headers.has('x-auto-response-suppress');

  // Nothing automated about it: a person wrote this.
  if (!bulk && !automated && !p.listId) return 'primary';
  // Someone the user knows, writing one-to-one.
  if (ctx.knownContact && !bulk && !UPDATE_SENDER.test(local)) return 'primary';

  // Receipts, alerts, notifications and discussion lists are updates, even with an unsubscribe link;
  // other bulk mail (newsletters, offers) is promotions.
  const offer = PROMO_SUBJECT.test(p.subject);
  if (UPDATE_SUBJECT.test(p.subject) && !(offer && esp)) return 'updates';
  if (UPDATE_SENDER.test(local)) return offer && bulk ? 'promotions' : 'updates';
  if (p.headers.has('list-post')) return 'updates';
  if (bulk) return 'promotions';
  if (automated || p.listId) return 'updates';
  return 'primary';
}

/** The first link of each kind in a List-Unsubscribe header. */
export function parseListUnsubscribe(value: string): { http: string | null; mailto: string | null } {
  const parts = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return {
    http: parts.find((u) => /^https:\/\//i.test(u)) ?? null,
    mailto: parts.find((u) => /^mailto:/i.test(u)) ?? null,
  };
}
