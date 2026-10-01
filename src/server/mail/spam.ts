import { getSettings } from '../settings.js';
import { domainOf } from '../lib/addr.js';
import { logger } from '../lib/log.js';
import { getHeader, type Parsed } from './parse.js';

const log = logger('spam');

export interface SpamVerdict {
  score: number;
  isSpam: boolean;
  reasons: string[];
  auth: Record<string, string>;
  engine: 'builtin' | 'rspamd' | 'provider' | 'off';
}

const SPAMMY = [
  /\bviagra\b/i,
  /\bcialis\b/i,
  /\bcasino\b/i,
  /\bcrypto(currency)? (giveaway|airdrop)\b/i,
  /\bwire transfer\b/i,
  /\bwinner\b.*\bprize\b/i,
  /\bclaim your (prize|reward)\b/i,
  /\bact now\b/i,
  /\b100% free\b/i,
  /\bverify your account\b.*\b(suspend|locked)\b/i,
  /\bnigerian? prince\b/i,
  /\binheritance\b.*\bbeneficiary\b/i,
  /\bbitcoin\b.*\bdouble\b/i,
];

/** Parse Authentication-Results headers into {spf, dkim, dmarc}. */
export function parseAuthResults(p: Parsed): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = p.headers.get('authentication-results');
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  for (const v of values) {
    for (const key of ['spf', 'dkim', 'dmarc', 'arc']) {
      const m = new RegExp(`\\b${key}=([a-z]+)`, 'i').exec(v);
      if (m && !out[key]) out[key] = m[1].toLowerCase();
    }
  }
  const rspf = getHeader(p, 'received-spf');
  if (!out.spf && rspf) out.spf = rspf.split(/\s/)[0].toLowerCase();
  return out;
}

function builtinScore(p: Parsed, auth: Record<string, string>, providerScore?: number): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };

  if (auth.spf === 'fail') add(3, 'SPF fail');
  else if (auth.spf === 'softfail') add(1, 'SPF softfail');
  if (auth.dkim === 'fail') add(2, 'DKIM fail');
  if (auth.dmarc === 'fail') add(4, 'DMARC fail');
  if (auth.dkim === 'pass' && auth.spf === 'pass') add(-1, 'SPF+DKIM pass');
  if (auth.spam === 'fail') add(6, 'provider spam verdict');

  const flag = getHeader(p, 'x-spam-flag').toLowerCase();
  const status = getHeader(p, 'x-spam-status').toLowerCase();
  if (flag.startsWith('yes') || status.startsWith('yes')) add(5, 'upstream X-Spam flag');

  if (typeof providerScore === 'number' && Number.isFinite(providerScore)) {
    // Provider scores are usually SpamAssassin-scale (5 = spam).
    const s = Math.max(-3, Math.min(10, providerScore));
    if (s !== 0) add(Number(s.toFixed(1)), 'provider score');
  }

  if (!p.messageId) add(1, 'no Message-ID');
  if (!p.headers.has('date')) add(1, 'no Date header');
  if (!p.from) add(2, 'no From');
  const subject = p.subject;
  if (subject.length > 8 && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) add(1.5, 'ALL-CAPS subject');
  if (/!!!|\$\$\$/.test(subject)) add(1, 'shouty subject');

  const body = `${subject}\n${p.text ?? ''}\n${p.html ?? ''}`;
  let hits = 0;
  for (const re of SPAMMY) if (re.test(body)) hits++;
  if (hits) add(Math.min(4, hits * 1.2), `${hits} spam phrase(s)`);

  if (p.html && !p.text) add(0.5, 'HTML only');
  const links = (p.html ?? p.text ?? '').match(/https?:\/\//g)?.length ?? 0;
  if (links > 25) add(1, 'many links');

  if (p.from?.name && /@/.test(p.from.name)) {
    const nameDomain = /@([a-z0-9.-]+)/i.exec(p.from.name)?.[1]?.toLowerCase();
    if (nameDomain && nameDomain !== domainOf(p.from.address)) add(2, 'display name spoofs another address');
  }
  if (p.replyTo && p.from && domainOf(p.replyTo.split(',')[0]) !== domainOf(p.from.address) && !p.listId) {
    add(0.5, 'Reply-To on different domain');
  }
  if (/\.(exe|scr|js|vbs|bat|cmd|jar|msi|com|pif)$/i.test(p.attachments.map((a) => a.filename).join(' '))) {
    add(4, 'executable attachment');
  }
  return { score, reasons };
}

async function rspamdScore(raw: Buffer, envelope: { from?: string; rcpt?: string[] }): Promise<{ score: number; reasons: string[] } | null> {
  const s = getSettings();
  if (!s['spam.rspamdUrl']) return null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'message/rfc822' };
    if (s['spam.rspamdPassword']) headers.Password = s['spam.rspamdPassword'];
    if (envelope.from) headers.From = envelope.from;
    if (envelope.rcpt?.length) headers.Rcpt = envelope.rcpt[0];
    const res = await fetch(`${s['spam.rspamdUrl'].replace(/\/+$/, '')}/checkv2`, {
      method: 'POST',
      headers,
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const symbols = Object.values(data.symbols ?? {}) as { name: string; score: number }[];
    return {
      score: Number(data.score ?? 0),
      reasons: symbols
        .filter((x) => x.score)
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
        .slice(0, 12)
        .map((x) => `${x.score > 0 ? '+' : ''}${x.score.toFixed(1)} ${x.name}`),
    };
  } catch (err) {
    log.warn('rspamd check failed, falling back to built-in scoring', err);
    return null;
  }
}

export async function checkSpam(
  p: Parsed,
  raw: Buffer,
  opts: { verdicts?: Record<string, string>; providerScore?: number; mailFrom?: string; rcptTo?: string[] } = {},
): Promise<SpamVerdict> {
  const s = getSettings();
  const auth = { ...parseAuthResults(p), ...(opts.verdicts ?? {}) };
  if (!s['spam.enabled']) return { score: 0, isSpam: false, reasons: [], auth, engine: 'off' };
  const rs = await rspamdScore(raw, { from: opts.mailFrom, rcpt: opts.rcptTo });
  const result = rs ?? builtinScore(p, auth, opts.providerScore);
  const score = Math.round(result.score * 10) / 10;
  return { score, isSpam: score >= s['spam.threshold'], reasons: result.reasons, auth, engine: rs ? 'rspamd' : 'builtin' };
}
