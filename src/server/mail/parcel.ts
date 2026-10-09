/**
 * Packages in shipping mail ("Your order has shipped", "Delivered: …"), so a
 * conversation can show where the parcel is, with View order and Track
 * package, like Gmail's order card.
 *
 * It reads the order markup shops put in their email for Gmail (schema.org
 * ParcelDelivery / Order as JSON-LD), carrier tracking links, and tracking
 * numbers in a carrier's format (UPS 1Z…, USPS, Amazon TBA…, international
 * post, checked with the carrier's check digit) or labelled "Tracking number";
 * then the order number, the item, the status and the expected day.
 *
 * Every email about the same package (same tracking number, or the same order
 * from the same shop) is put together into one card: the shop's order
 * confirmation, its shipping email, a forwarder's update, the delivery notice.
 * An order number belongs to the shop (or the sender's site); on domains many
 * senders share (Gmail, Shopify's t.shopifyemail.com) it belongs to the one
 * sender address, since every Shopify store's orders start at #1001.
 *
 * View order goes to the shop's own order page (Amazon, Walmart, Macy's,
 * Target…). Phones open those pages in the shop's app when it's installed,
 * since they're the apps' universal links / app links. A link taken from the
 * email is only used when it points at the sender's, the shop's or the
 * carrier's own site, and a sender name that borrows a shop's or carrier's
 * name from another domain isn't shown as that shop.
 */
import type { Parcel, ParcelStatus } from '../../shared/types.js';
import { all } from '../db/index.js';
import { domainOf } from '../lib/addr.js';
import { htmlToText } from './parse.js';

/** What one email says about a package (stored as JSON in messages.parcel; '' when there's none). */
export interface ParcelFacts {
  /** The sender's site (amazon.co.uk). */
  site: string;
  /** Whose order number it is: the shop, the sender's site, or (on a shared domain) the sender's address. */
  scope: string;
  /** An order confirmation from a shop we don't know: no card by itself, but it joins the package's card once it ships. */
  weak?: true;
  status?: ParcelStatus;
  /** Expected delivery day (UTC midnight). */
  eta?: number;
  /** The sender's name, when it isn't a shop or carrier we know. */
  merchant?: string;
  /** A carrier id from CARRIERS, or a carrier's name from the order markup. */
  carrier?: string;
  tracking?: string;
  order?: string;
  item?: string;
  items?: number;
  image?: string;
  orderUrl?: string;
  trackUrl?: string;
}

export interface ParcelInput {
  subject: string;
  text: string | null;
  html: string | null;
  from: { address: string; name?: string } | null;
  /** The email's date: "arriving Thursday" is counted from it. */
  date: number;
}

const DAY = 86_400_000;

// ── Carriers ────────────────────────────────────────────────────────────────

interface Carrier {
  name: string;
  sites: string[];
  track: (n: string) => string;
  /** How emails name the carrier, for tracking numbers that are only digits. */
  word?: RegExp;
}

const CARRIERS: Record<string, Carrier> = {
  ups: { name: 'UPS', sites: ['ups.com'], track: (n) => `https://www.ups.com/track?tracknum=${n}`, word: /\bUPS\b/ },
  usps: { name: 'USPS', sites: ['usps.com'], track: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`, word: /\b(?:USPS|U\.S\. Postal|Postal Service)\b/i },
  fedex: { name: 'FedEx', sites: ['fedex.com'], track: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`, word: /\bFed ?Ex\b/i },
  dhl: { name: 'DHL', sites: ['dhl.com', 'dhl.de', 'dhl.co.uk'], track: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}&submit=1`, word: /\bDHL\b/ },
  amazon: { name: 'Amazon', sites: ['amazon.com'], track: (n) => `https://track.amazon.com/tracking/${n}` },
  ontrac: { name: 'OnTrac', sites: ['ontrac.com', 'lasership.com'], track: (n) => `https://www.ontrac.com/tracking/?number=${n}`, word: /\b(?:OnTrac|LaserShip)\b/i },
  canadapost: { name: 'Canada Post', sites: ['canadapost.ca', 'canadapost-postescanada.ca', 'postescanada.ca'], track: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${n}`, word: /\bCanada Post\b/i },
  royalmail: { name: 'Royal Mail', sites: ['royalmail.com'], track: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`, word: /\bRoyal Mail\b/i },
};

/** Any carrier's number, for one we don't know. */
const anyCarrier = (n: string) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}`;

function carrierByName(name: string): string {
  const id = Object.entries(CARRIERS).find(([, c]) => c.word?.test(name) || c.name.toLowerCase() === name.toLowerCase())?.[0];
  return id ?? name.trim().slice(0, 40);
}

/** UPS 1Z: the last character checks the 15 before it (letters count as (code − 63) mod 10). */
function upsValid(n: string): boolean {
  let sum = 0;
  for (let i = 2; i < 17; i++) {
    const v = /\d/.test(n[i]) ? Number(n[i]) : (n.charCodeAt(i) - 63) % 10;
    sum += (i - 2) % 2 ? v * 2 : v;
  }
  return (10 - (sum % 10)) % 10 === Number(n[17]);
}

/** USPS (and other GS1 numbers): mod 10, weights 3 and 1 from the right. */
function mod10Valid(n: string): boolean {
  let sum = 0;
  for (let i = n.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(n[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(n[n.length - 1]);
}

/** International post (UPU S10, "RR123456785GB"): the 9th digit checks the 8 before it. */
function s10Valid(n: string): boolean {
  const w = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = w.reduce((s, x, i) => s + x * Number(n[2 + i]), 0);
  const c = 11 - (sum % 11);
  return (c === 10 ? 0 : c === 11 ? 5 : c) === Number(n[10]);
}

const S10_COUNTRY: Record<string, string> = { US: 'usps', CA: 'canadapost', GB: 'royalmail' };

/** Tracking numbers that are recognisable on their own (no label needed). */
function strongNumbers(text: string): { tracking: string; carrier?: string }[] {
  const found: { tracking: string; carrier?: string; at: number }[] = [];
  for (const m of text.matchAll(/\b1Z ?[0-9A-Z]{3} ?[0-9A-Z]{3} ?[0-9A-Z]{2} ?[0-9A-Z]{4} ?[0-9A-Z]{4}\b/gi)) {
    const n = m[0].replace(/ /g, '').toUpperCase();
    if (n.length === 18 && upsValid(n)) found.push({ tracking: n, carrier: 'ups', at: m.index ?? 0 });
  }
  for (const m of text.matchAll(/(?<![\d-])9[1-5]\d{2}(?: ?\d{4}){4} ?\d{2}(?![\d-])/g)) {
    const n = m[0].replace(/ /g, '');
    if (n.length === 22 && mod10Valid(n)) found.push({ tracking: n, carrier: 'usps', at: m.index ?? 0 });
  }
  for (const m of text.matchAll(/\bTBA\d{12}\b/g)) found.push({ tracking: m[0], carrier: 'amazon', at: m.index ?? 0 });
  for (const m of text.matchAll(/\b1LS\d{12,15}\b/g)) found.push({ tracking: m[0], carrier: 'ontrac', at: m.index ?? 0 });
  for (const m of text.matchAll(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/g)) {
    if (s10Valid(m[0])) found.push({ tracking: m[0], carrier: S10_COUNTRY[m[0].slice(-2)], at: m.index ?? 0 });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Carrier tracking pages in links (also inside a shop's click-tracking redirect). */
const TRACK_LINKS: [string, RegExp][] = [
  ['ups', /\bups\.com\/[^\s"'<>]*?[?&](?:tracknum|trackNums|InquiryNumber1|tracknumber)=([A-Z0-9]{10,35})/i],
  ['usps', /\busps\.com\/[^\s"'<>]*?[?&](?:tLabels|qtc_tLabels1|origTrackNum)=([A-Z0-9]{10,35})/i],
  ['fedex', /\bfedex\.com\/[^\s"'<>]*?[?&](?:trknbr|tracknumbers|tracknumber|trackingnumber)=(\d{10,34})/i],
  ['dhl', /\bdhl\.[a-z.]+\/[^\s"'<>]*?[?&](?:tracking-id|AWB|piececode|idc|trackingNumber)=([A-Z0-9]{8,35})/i],
  ['amazon', /\btrack\.amazon\.[a-z.]+\/tracking\/(TBA\d{12})/i],
  ['ontrac', /\bontrac\.com\/[^\s"'<>]*?[?&](?:number|tracking|trackingnumber)=([A-Z0-9]{8,35})/i],
  ['canadapost', /\bcanadapost[a-z-]*\.ca\/[^\s"'<>]*?(?:searchFor=|details\/)([A-Z0-9]{10,35})/i],
  ['royalmail', /\broyalmail\.com\/[^\s"'<>]*?tracking-results\/([A-Z0-9]{9,35})/i],
];

/** "Tracking number: …", "Tracking #", "Waybill", "AWB". */
const TRACK_LABEL = /\b(?:tracking(?:\s*(?:number|no\.?|num|#|id|code))?|waybill(?:\s*(?:number|no\.?))?|AWB)\s*(?:is\s*)?[:#]?\s*#?\s*/gi;
const LABELLED_NUMBER = /^([A-Z0-9][A-Z0-9-]{6,34}[A-Z0-9])\b/i;

/** Only digits: FedEx (12, 15, 20 or 22), DHL Express (10), next to the carrier's name. */
const DIGITS_FOR: [string, RegExp][] = [
  ['fedex', /(?<![\d-])(\d{12}|\d{15}|\d{20}|96\d{20})(?![\d-])/g],
  ['dhl', /(?<![\d-])(\d{10})(?![\d-])/g],
  ['ontrac', /\b([CD]\d{14})\b/g],
];

const SHIPPING_WORDS = /\b(?:track(?:ing)?|ship(?:ped|ping|ment|s)?|deliver(?:y|ed|ing)?|parcel|package|courier|dispatch(?:ed)?|in transit|waybill|arriv(?:ing|es|al))\b/i;

// ── Shops ───────────────────────────────────────────────────────────────────

interface Shop {
  name: string;
  sites: RegExp;
  /** The page for this order, when the shop has one we can address. */
  order?: (site: string, order: string) => string | null;
  /** The shop's list of orders. */
  orders?: (site: string) => string;
}

// Order pages checked against each shop's site (they ask you to sign in, then show the order).
const SHOPS: Shop[] = [
  {
    name: 'Amazon',
    sites: /^amazon\.(?:com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|com\.tr|ae|sa|eg|in|co\.jp|com\.au|sg)$/,
    order: (site, o) => (/^\d{3}-\d{7}-\d{7}$/.test(o) ? `https://www.${site}/gp/your-account/order-details?orderID=${o}` : null),
    orders: (site) => `https://www.${site}/gp/css/order-history`,
  },
  {
    name: 'Walmart',
    sites: /^walmart\.com$/,
    order: (_, o) => (/^\d[\d-]{8,}$/.test(o) ? `https://www.walmart.com/orders/${o.replace(/-/g, '')}` : null),
    orders: () => 'https://www.walmart.com/orders',
  },
  { name: 'Macy’s', sites: /^macys\.com$/, orders: () => 'https://www.macys.com/purchases' },
  { name: 'Target', sites: /^target\.com$/, orders: () => 'https://www.target.com/orders' },
  { name: 'Best Buy', sites: /^bestbuy\.com$/, orders: () => 'https://www.bestbuy.com/purchasehistory/purchases' },
  { name: 'eBay', sites: /^ebay\.(?:com|co\.uk|ca|de|com\.au)$/, orders: (site) => `https://www.${site}/mye/myebay/purchase` },
  { name: 'Etsy', sites: /^etsy\.com$/, orders: () => 'https://www.etsy.com/your/purchases' },
  { name: 'Temu', sites: /^temu\.com$/, orders: () => 'https://www.temu.com/bgt_orders.html' },
  { name: 'SHEIN', sites: /^shein\.com$/, orders: () => 'https://www.shein.com/user/orders/list' },
  { name: 'AliExpress', sites: /^aliexpress\.(?:com|us)$/, orders: () => 'https://www.aliexpress.com/p/order/index.html' },
  { name: 'Nike', sites: /^nike\.com$/, orders: () => 'https://www.nike.com/orders' },
  { name: 'Costco', sites: /^costco\.com$/, orders: () => 'https://www.costco.com/OrderStatusCmd' },
  { name: 'The Home Depot', sites: /^homedepot\.com$/, orders: () => 'https://www.homedepot.com/myaccount/purchase-history' },
  { name: 'Chewy', sites: /^chewy\.com$/, orders: () => 'https://www.chewy.com/app/account/orderhistory' },
  { name: 'Sephora', sites: /^sephora\.com$/, orders: () => 'https://www.sephora.com/purchase-history' },
  { name: 'Nordstrom', sites: /^nordstrom\.com$/, orders: () => 'https://www.nordstrom.com/my-account/purchases' },
  { name: 'Apple', sites: /^apple\.com$/, orders: () => 'https://www.apple.com/shop/order/list' },
  // Known by name; View order uses the link in their email.
  { name: 'Fashion Nova', sites: /^fashionnova\.com$/ },
  { name: 'Kohl’s', sites: /^kohls\.com$/ },
  { name: 'Lowe’s', sites: /^lowes\.com$/ },
  { name: 'Wayfair', sites: /^wayfair\.com$/ },
  { name: 'Ulta Beauty', sites: /^ulta\.com$/ },
  { name: 'IKEA', sites: /^ikea\.com$/ },
  { name: 'Zara', sites: /^zara\.com$/ },
  { name: 'H&M', sites: /^hm\.com$/ },
];

const shopFor = (site: string | undefined) => (site ? SHOPS.find((s) => s.sites.test(site)) : undefined);

const SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|ne|or|gob)$/;

/** The registrable part of a host: shipment-tracking.amazon.co.uk → amazon.co.uk. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1];
  return parts.slice(SECOND_LEVEL.test(parts[parts.length - 2]) && tld.length === 2 ? -3 : -2).join('.');
}

/** Names that only a shop's or carrier's own domain may use. */
const BRAND_NAMES = new RegExp(
  `\\b(?:${[...SHOPS.map((s) => s.name.replace(/[’']s$/, '')), ...Object.values(CARRIERS).map((c) => c.name)]
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

/** The sender's name as the shop's name, unless it borrows a brand from another domain. */
function merchantName(name: string | undefined, site: string): string | undefined {
  const clean = (name ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.includes('@') || clean.length > 60) return site || undefined;
  if (BRAND_NAMES.test(clean) && !shopFor(site) && !isCarrierSite(site)) return site || undefined;
  return clean;
}

const isCarrierSite = (site: string) => Object.values(CARRIERS).some((c) => c.sites.includes(site));
const carrierOfSite = (site: string) => Object.entries(CARRIERS).find(([, c]) => c.sites.includes(site))?.[0];

/** Domains many senders share (free mail, store platforms): there, an order number belongs to one sender address. */
const SHARED = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'shopifyemail.com', 'returnscentermail.com']);
/** A platform's sites its senders' links may point to (a Shopify store's order page). */
const PLATFORM_LINKS: Record<string, string[]> = { 'shopifyemail.com': ['shopify.com', 'myshopify.com'] };

/** The carrier named closest to the tracking number. */
function nearestCarrier(text: string, at: number): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const [id, c] of Object.entries(CARRIERS)) {
    if (!c.word) continue;
    for (const m of text.matchAll(new RegExp(c.word.source, `${c.word.flags}g`))) {
      const d = Math.abs((m.index ?? 0) - at);
      if (!best || d < best.d) best = { id, d };
    }
  }
  return best?.id;
}

// ── Status, dates, order numbers ────────────────────────────────────────────

const STATUSES: [ParcelStatus, RegExp][] = [
  ['cancelled', /\b(?:order|item|shipment)s?\s+(?:has been\s+|have been\s+|was\s+|were\s+|is\s+)?cancell?ed\b|\bcancell?ation\s+(?:confirmed|confirmation)\b|\bcancell?ed\s*:/gi],
  ['returned', /\breturn(?:ed)?\s+(?:to sender|received|processed|complete)\b|\brefund(?:ed|\s+issued|\s+processed)\b/gi],
  ['delivered', /\bdelivered\b|\bdelivery complete/gi],
  ['out_for_delivery', /\bout for delivery\b/gi],
  ['ready_for_pickup', /\b(?:ready|available)\s+(?:for|to)\s+(?:pick ?-?up|collect(?:ion)?)\b/gi],
  ['delayed', /\bdelay(?:ed)?\b|\brunning late\b|\bdelivery exception\b|\b(?:missed|attempted) delivery\b|\bdelivery attempt\b|\bunable to deliver\b/gi],
  ['in_transit', /\bin transit\b|\bon (?:its|the|their) way\b|\barriving\b|\barrives\b|\bon the move\b/gi],
  ['shipped', /\bshipped\b|\bdispatched\b|\bshipment (?:confirmation|notification)\b|\bhas been sent\b|\blabel created\b|\bshipping (?:confirmation|update)\b/gi],
  ['ordered', /\border (?:confirmed|confirmation|received|placed)\b|\bthanks? (?:you )?for (?:your|the) (?:order|purchase)\b|\bwe(?:['’]ve| have) (?:received|got) your order\b/gi],
];
/** "…when your items have shipped", "…will be delivered": not happened yet. */
const NOT_YET = /\b(?:when|once|after|soon as|until|if|be|get|gets|being|will|we['’]ll)\b[^.!?\n]{0,30}$/i;

function statusIn(s: string): ParcelStatus | undefined {
  for (const [status, re] of STATUSES) {
    for (const m of s.matchAll(re)) if (!NOT_YET.test(s.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) return status;
  }
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const WD = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?';
const ETA_CUE = /\b(?:arriving|arrives?|arrival(?: date)?|expected(?: delivery| arrival)?(?: date)?|estimated(?: delivery| arrival)?(?: date)?|delivery (?:date|by|estimate)|deliver(?:ed|s)? (?:by|on)|get it (?:by|on)|should (?:arrive|be delivered)|will (?:arrive|be delivered))\b/gi;
const DATE_AFTER_CUE = new RegExp(
  `^[\\s:,-]*(?:(?:by|on|is|for|between)\\s+)*(?:(today)|(tomorrow)|(?:${WD},?\\s+)?(?:${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON})(?:,?\\s+(\\d{4}))?|${WD}\\b)`,
  'i',
);

/** The expected delivery day after an "Arriving" / "Estimated delivery" cue, as UTC midnight. */
function findEta(s: string, base: number): number | undefined {
  const b = new Date(base);
  const today = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  for (const cue of s.matchAll(ETA_CUE)) {
    const m = s.slice((cue.index ?? 0) + cue[0].length, (cue.index ?? 0) + cue[0].length + 60).match(DATE_AFTER_CUE);
    if (!m) continue;
    if (m[1]) return today;
    if (m[2]) return today + DAY;
    const month = m[4] ?? m[7];
    if (month) {
      const day = Number(m[5] ?? m[6]);
      let year = m[8] ? Number(m[8]) : b.getUTCFullYear();
      let t = Date.UTC(year, MONTHS.indexOf(month.toLowerCase()), day);
      // "Jan 3" in an email from late December is next year.
      if (!m[8] && t < today - 60 * DAY) t = Date.UTC(++year, MONTHS.indexOf(month.toLowerCase()), day);
      if (day >= 1 && day <= 31 && new Date(t).getUTCDate() === day) return t;
      continue;
    }
    const weekday = m[9];
    if (weekday) return today + ((WEEKDAYS.indexOf(weekday.toLowerCase()) - b.getUTCDay() + 7) % 7) * DAY;
  }
  return undefined;
}

const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/;
const ORDER_LABEL = /\border\b\s*(?:number|no\.?|num|id|#|confirmation(?:\s*number)?)?\s*(?:is\s*)?[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{2,28}[A-Z0-9])\b/gi;

function findOrder(...texts: string[]): string | undefined {
  for (const t of texts) {
    const amazon = t.match(AMAZON_ORDER);
    if (amazon) return amazon[0];
    for (const m of t.matchAll(ORDER_LABEL)) if ((m[1].match(/\d/g)?.length ?? 0) >= 4) return m[1].toUpperCase();
  }
  return undefined;
}

// ── Links and markup ────────────────────────────────────────────────────────

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");

/** A link we're willing to put on a button: https (http is upgraded), on one of `sites`. */
function safeUrl(raw: unknown, sites: Set<string>): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  try {
    const u = new URL(decodeEntities(raw.trim()));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (u.username || u.password || !sites.has(siteOf(u.hostname))) return undefined;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return undefined;
  }
}

interface Link {
  href: string;
  text: string;
}

function linksIn(html: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    const alt = [...m[2].matchAll(/\balt\s*=\s*["']([^"']*)["']/gi)].map((a) => a[1]).join(' ');
    out.push({ href: decodeEntities(href[1] ?? href[2] ?? href[3] ?? ''), text: `${htmlToText(m[2])} ${alt}`.replace(/\s+/g, ' ').trim() });
    if (out.length >= 400) break;
  }
  return out;
}

/** The link and the URLs it may redirect to (click trackers carry them encoded). */
function unwrap(href: string): string {
  let s = href;
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(s);
      if (next === s) break;
      s = `${s} ${next}`;
    } catch {
      break;
    }
  }
  return s;
}

const ORDER_LINK = /\b(?:view|see|check|manage|review)\s+(?:your\s+|my\s+|the\s+)?order(?:\s+(?:details|status))?\b|\border\s+(?:details|status)\b|\byour orders\b|\bview (?:details|receipt)\b/i;
const TRACK_LINK = /\btrack(?:\s+(?:your|my|this|the))?\s+(?:package|parcel|shipment|delivery|order|item)s?\b|^track$|\btracking (?:details|info(?:rmation)?|number|page)\b/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const nameOf = (v: unknown): string | undefined => str(v) ?? str(obj(v)?.name);
const types = (o: Json) => list(o['@type']).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''));

function markup(html: string): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = obj(v);
    if (!o) return;
    if (o['@graph']) walk(o['@graph'], depth + 1);
    out.push(o);
  };
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()), 0);
    } catch {
      // Not JSON; ignore it.
    }
  }
  return out;
}

const ORDER_STATUS: Record<string, ParcelStatus> = {
  OrderDelivered: 'delivered',
  OrderInTransit: 'in_transit',
  OrderProcessing: 'ordered',
  OrderPaymentDue: 'ordered',
  OrderPickupAvailable: 'ready_for_pickup',
  OrderProblem: 'delayed',
  OrderReturned: 'returned',
  OrderCancelled: 'cancelled',
};
const orderStatus = (v: unknown) => ORDER_STATUS[(str(v) ?? '').replace(/^https?:\/\/schema\.org\//, '')];

const dayOf = (v: unknown): number | undefined => {
  const t = Date.parse(str(v) ?? '');
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** schema.org ParcelDelivery / Order, the markup Gmail reads. */
function fromMarkup(html: string): Partial<ParcelFacts> & { merchantName?: string; carrierName?: string } {
  const objs = markup(html);
  const parcel = objs.find((o) => types(o).includes('ParcelDelivery')) ?? objs.map((o) => obj(o.orderDelivery)).find(Boolean);
  const order = objs.find((o) => types(o).includes('Order')) ?? obj(parcel?.partOfOrder);
  if (!parcel && !order) return {};
  const shipped = list(parcel?.itemShipped).map(obj).filter((x): x is Json => !!x);
  const offered = list(order?.acceptedOffer).map((a) => obj(obj(a)?.itemOffered) ?? obj(a)).filter((x): x is Json => !!x);
  const items = shipped.length ? shipped : offered;
  const first = items[0];
  const image = first ? str(first.image) ?? str(obj(first.image)?.url) ?? str(list(first.image)[0]) : undefined;
  return {
    tracking: str(parcel?.trackingNumber)?.replace(/\s/g, '').toUpperCase(),
    trackUrl: str(parcel?.trackingUrl),
    carrierName: nameOf(parcel?.carrier) ?? nameOf(parcel?.provider),
    eta: dayOf(parcel?.expectedArrivalUntil) ?? dayOf(parcel?.expectedArrivalFrom),
    order: str(order?.orderNumber)?.replace(/^#/, '').toUpperCase(),
    orderUrl: str(order?.url),
    merchantName: nameOf(order?.merchant) ?? nameOf(order?.seller),
    status: orderStatus(order?.orderStatus) ?? orderStatus(parcel?.deliveryStatus),
    item: first ? str(first.name) : undefined,
    items: items.length > 1 ? items.length : undefined,
    image: image && /^https:\/\//i.test(image) ? image : undefined,
  };
}

// ── Finding a package in one email ──────────────────────────────────────────

const TEXT_LIMIT = 60_000;

/** What the email says about a package, or null when it isn't about one. */
export function findParcel(input: ParcelInput): ParcelFacts | null {
  const subject = input.subject ?? '';
  const html = (input.html ?? '').slice(0, 400_000);
  const text = [input.text ?? '', html ? htmlToText(html) : ''].join('\n').slice(0, TEXT_LIMIT);
  const full = `${subject}\n${text}`;
  const sender = input.from?.address ?? '';
  const site = siteOf(domainOf(sender));
  const shop = shopFor(site);
  const links = html ? linksIn(html) : [];
  const md = html ? fromMarkup(html) : {};
  const shipping = SHIPPING_WORDS.test(full);

  // The tracking number: markup, a carrier's link, a number in a carrier's own format, a labelled one, digits by a carrier's name.
  let tracking = md.tracking;
  let carrier = md.carrierName ? carrierByName(md.carrierName) : undefined;
  if (!tracking) {
    const hay = [...links.map((l) => unwrap(l.href)), full];
    outer: for (const h of hay) {
      for (const [id, re] of TRACK_LINKS) {
        const m = h.match(re);
        if (m) {
          tracking = m[1].toUpperCase();
          carrier = id;
          break outer;
        }
      }
    }
  }
  if (!tracking && shipping) {
    const strong = strongNumbers(full)[0];
    if (strong) ({ tracking, carrier } = strong);
  }
  if (!tracking) {
    for (const m of full.matchAll(TRACK_LABEL)) {
      const after = full.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
      const n = after.match(LABELLED_NUMBER)?.[1];
      if (!n || n.length < 8 || (n.match(/\d/g)?.length ?? 0) < 5) continue;
      tracking = n.replace(/-/g, '').toUpperCase();
      break;
    }
  }
  if (!tracking && shipping) {
    for (const [id, re] of DIGITS_FOR) {
      const word = CARRIERS[id].word!;
      for (const m of full.matchAll(re)) {
        const at = m.index ?? 0;
        if (word.test(full.slice(Math.max(0, at - 150), at + m[0].length + 80))) {
          tracking = m[1];
          carrier = id;
          break;
        }
      }
      if (tracking) break;
    }
  }
  if (tracking && !carrier) {
    // A labelled number: which carrier, by its shape, the carrier sending the email, or the carrier named nearest to it.
    carrier =
      (/^1Z[0-9A-Z]{16}$/.test(tracking) && 'ups') ||
      (/^TBA\d{12}$/.test(tracking) && 'amazon') ||
      (/^9[1-5]\d{20}$/.test(tracking) && 'usps') ||
      (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(tracking) && S10_COUNTRY[tracking.slice(-2)]) ||
      carrierOfSite(site) ||
      nearestCarrier(full, Math.max(0, full.toUpperCase().indexOf(tracking))) ||
      undefined;
  }

  const head = text.slice(0, 600);
  const status = md.status ?? statusIn(subject) ?? statusIn(head);
  const order = md.order ?? findOrder(subject, text);
  const strong = !!tracking || !!md.order || (!!shop && !!order && (shipping || !!statusIn(subject)));
  // A shop we don't know: its order confirmation waits (without a card) for the shipping email with the same order number.
  const weak = !strong && !!order && status === 'ordered' && shipping;
  if (!strong && !weak) return null;

  // Links from the email, only on the sender's, the shop's or the carrier's own site.
  const own = new Set([site, ...(PLATFORM_LINKS[site] ?? [])].filter(Boolean));
  const carrierSites = new Set([...own, ...(carrier && CARRIERS[carrier] ? CARRIERS[carrier].sites : [])]);
  const orderUrl = safeUrl(md.orderUrl, own) ?? links.map((l) => (ORDER_LINK.test(l.text) ? safeUrl(l.href, own) : undefined)).find(Boolean);
  const trackUrl =
    safeUrl(md.trackUrl, carrierSites) ??
    links.map((l) => (TRACK_LINK.test(l.text) || (tracking && l.text.replace(/\s/g, '').toUpperCase() === tracking) ? safeUrl(l.href, carrierSites) : undefined)).find(Boolean);

  const quoted = subject.match(/["“]([^"”]{3,140})["”]/)?.[1] ?? subject.match(/\border of\s+(.{3,140}?)\s+(?:has|have)\s+(?:shipped|been)/i)?.[1];
  const more = subject.match(/\band (\d{1,3}) more items?\b/i);
  const facts: ParcelFacts = {
    site,
    scope: shop ? `shop:${shop.name}` : SHARED.has(site) ? `from:${sender.toLowerCase()}` : `site:${site}`,
    weak: weak ? true : undefined,
    status,
    eta: md.eta ?? findEta(`${subject}\n${text.slice(0, 4000)}`, input.date),
    merchant: shop || isCarrierSite(site) ? undefined : merchantName(md.merchantName ?? input.from?.name, site),
    carrier,
    tracking,
    order,
    item: (md.item ?? quoted)?.trim().slice(0, 200),
    items: md.items ?? (more ? Number(more[1]) + 1 : undefined),
    image: md.image,
    orderUrl,
    trackUrl,
  };
  for (const k of Object.keys(facts) as (keyof ParcelFacts)[]) if (facts[k] === undefined) delete facts[k];
  return facts;
}

// ── One card from every email about the package ─────────────────────────────

export interface ParcelRow {
  id: number;
  date: number;
  facts: ParcelFacts;
  threadId?: number;
}

export function readFacts(json: string | null | undefined): ParcelFacts | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ParcelFacts;
  } catch {
    return null;
  }
}

/** The user's recent package emails (outside Spam and Trash), newest first. */
export function parcelRows(userId: number): ParcelRow[] {
  return all<{ id: number; date: number; parcel: string; thread_id: number }>(
    `SELECT id, date, parcel, thread_id FROM messages WHERE user_id = ? AND parcel <> '' AND folder NOT IN ('spam','trash','drafts') ORDER BY date DESC LIMIT 1000`,
    [userId],
  ).flatMap((r) => {
    const facts = readFacts(r.parcel);
    return facts ? [{ id: r.id, date: r.date, facts, threadId: r.thread_id }] : [];
  });
}

const WINDOW = 120 * DAY;
const orderKey = (f: ParcelFacts) => (f.order ? `${f.scope ?? `site:${f.site}`}|${f.order}` : null);

/**
 * The emails about the same package as `seed`: the same tracking number, or
 * the same order from the same shop or sender. Two steps, so a shop's order confirmation
 * (order number only) joins a forwarder's update (tracking number only)
 * through the shop's shipping email (both).
 */
export function relatedRows(rows: ParcelRow[], seed: ParcelRow): ParcelRow[] {
  const group = new Map<number, ParcelRow>([[seed.id, seed]]);
  for (let step = 0; step < 2; step++) {
    const trackings = new Set([...group.values()].map((r) => r.facts.tracking).filter(Boolean));
    const orders = new Set([...group.values()].map((r) => orderKey(r.facts)).filter(Boolean));
    for (const r of rows) {
      if (group.has(r.id) || Math.abs(r.date - seed.date) > WINDOW) continue;
      if ((r.facts.tracking && trackings.has(r.facts.tracking)) || (orderKey(r.facts) && orders.has(orderKey(r.facts)))) group.set(r.id, r);
    }
  }
  return [...group.values()].sort((a, b) => a.date - b.date || a.id - b.id);
}

/** Statuses a later email can't take a delivered package back to. */
const BEFORE_DELIVERY = new Set<ParcelStatus>(['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delayed']);

export function buildParcel(group: ParcelRow[], seed: ParcelRow): Parcel {
  const newest = [...group].reverse();
  // A shop's own emails know the order best; a forwarder's or carrier's know the parcel.
  const fromShop = newest.filter((r) => shopFor(r.facts.site));
  const prefer = fromShop.length ? fromShop : newest;
  const pick = <K extends keyof ParcelFacts>(k: K, rows: ParcelRow[] = newest): ParcelFacts[K] | undefined => rows.find((r) => r.facts[k] !== undefined)?.facts[k];

  let status: ParcelStatus | null = null;
  let statusAt = seed.date;
  for (const r of group) {
    const s = r.facts.status;
    if (!s || (status === 'delivered' && BEFORE_DELIVERY.has(s))) continue;
    status = s;
    statusAt = r.date;
  }

  const tracking = seed.facts.tracking ?? pick('tracking');
  const withTracking = newest.filter((r) => r.facts.tracking === tracking);
  const carrier = pick('carrier', withTracking);
  const known = carrier ? CARRIERS[carrier] : undefined;
  const orderRow = prefer.find((r) => r.facts.order) ?? newest.find((r) => r.facts.order);
  const order = orderRow?.facts.order;
  const site = orderRow?.facts.site ?? prefer[0]?.facts.site ?? seed.facts.site;
  const shop = shopFor(site);
  const merchant = shop?.name ?? pick('merchant', prefer) ?? null;

  // A shop's own page for the order, its link in its own email, then its list of orders; never another site's link.
  const orderUrl = shop ? ((order && shop.order?.(site, order)) || pick('orderUrl', prefer) || shop.orders?.(site) || null) : pick('orderUrl') ?? null;
  const trackUrl = tracking ? (known ? known.track(tracking) : pick('trackUrl', withTracking) ?? anyCarrier(tracking)) : pick('trackUrl') ?? null;
  // Once it's on its way, the newest estimate counts; a delivered package needs none.
  const eta = status === 'delivered' || status === 'cancelled' || status === 'returned' ? null : pick('eta') ?? null;

  return {
    messageId: seed.id,
    status,
    statusAt,
    eta,
    merchant,
    carrier: known?.name ?? carrier ?? null,
    tracking: tracking ?? null,
    order: order ?? null,
    item: pick('item', prefer) ?? pick('item') ?? null,
    items: pick('items', prefer) ?? pick('items') ?? null,
    image: pick('image', prefer) ?? pick('image') ?? null,
    orderUrl,
    trackUrl,
    emails: group.length,
  };
}

/** The package card for a message's facts, joined with the user's other emails about it (none from order confirmations alone). */
export function parcelFor(rows: ParcelRow[], seed: ParcelRow): Parcel | null {
  const group = relatedRows(rows, seed);
  return group.some((r) => !r.facts.weak) ? buildParcel(group, seed) : null;
}

/**
 * Every package in `rows` (newest first), each once: its card from all its
 * emails, opened from its newest email's conversation. Order confirmations
 * still waiting for their shipping email aren't packages yet.
 */
export function listPackages(rows: ParcelRow[]): (Parcel & { threadId: number })[] {
  const seen = new Set<number>();
  const out: (Parcel & { threadId: number })[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    const group = relatedRows(rows, r);
    for (const g of group) seen.add(g.id);
    if (!group.some((g) => !g.facts.weak)) continue;
    const seed = group[group.length - 1];
    out.push({ ...buildParcel(group, seed), threadId: seed.threadId ?? 0 });
  }
  return out;
}

export type ParcelNote = Pick<Parcel, 'status' | 'merchant' | 'item'>;

/**
 * For a notification about new mail: where its package is now, told by all
 * its emails ("Out for delivery · Macy's"). `rows` loads a mailbox's package
 * emails once per request.
 */
export function parcelNote(rows: (userId: number) => ParcelRow[], userId: number, m: { id: number; date: number; parcel: string | null }): ParcelNote | null {
  const facts = readFacts(m.parcel);
  if (!facts || facts.weak) return null;
  const p = parcelFor(rows(userId), { id: m.id, date: m.date, facts });
  return p?.status ? { status: p.status, merchant: p.merchant, item: p.item } : null;
}

/** parcelRows, loaded once per mailbox within one request. */
export function parcelRowsOnce(): (userId: number) => ParcelRow[] {
  const loaded = new Map<number, ParcelRow[]>();
  return (userId) => {
    if (!loaded.has(userId)) loaded.set(userId, parcelRows(userId));
    return loaded.get(userId)!;
  };
}
