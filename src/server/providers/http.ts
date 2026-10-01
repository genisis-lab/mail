import { ProviderError, type OutboundEmail, type ProviderContext } from './types.js';
import { formatAddr } from '../lib/addr.js';
import type { Addr } from '../../shared/types.js';

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  timeoutMs?: number;
}

/** Perform an HTTP request and return parsed JSON (or text). Maps failures to ProviderError. */
export async function request<T = any>(ctx: ProviderContext, url: string, opts: RequestOpts = {}): Promise<{ data: T; res: Response }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new ProviderError(`Network error: ${(err as Error).message}`, false);
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new ProviderError(`HTTP ${res.status}: ${extractError(data) || res.statusText}`, permanent, res.status);
  }
  return { data: data as T, res };
}

function extractError(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 300);
  const candidates = [
    data.message,
    data.Message,
    data.error?.message,
    typeof data.error === 'string' ? data.error : undefined,
    data.errors?.[0]?.message,
    data.errors?.[0]?.description,
    data.ErrorMessage,
    data.detail,
    data.Errors?.[0]?.ErrorMessage,
  ].filter(Boolean);
  return candidates.length ? String(candidates[0]).slice(0, 300) : JSON.stringify(data).slice(0, 300);
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export const b64 = (b: Buffer) => b.toString('base64');

/**
 * Headers worth passing through JSON APIs so threading survives
 * (In-Reply-To, References, List-Unsubscribe…). Most JSON APIs assign their
 * own Message-ID, so it is only included when a provider opts in.
 */
export function threadingHeaders(email: OutboundEmail, includeMessageId = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(email.headers)) {
    if (!v) continue;
    if (!includeMessageId && k.toLowerCase() === 'message-id') continue;
    out[k] = v;
  }
  return out;
}

export function addrString(a: Addr): string {
  return formatAddr(a);
}

/** Envelope recipients split back into to/cc/bcc for JSON APIs that need explicit lists. */
export function envelopeLists(email: OutboundEmail): { to: Addr[]; cc: Addr[]; bcc: Addr[] } {
  const want = new Set(email.envelope.to.map((x) => x.toLowerCase()));
  const pick = (list: Addr[]) => list.filter((a) => want.has(a.address.toLowerCase()));
  const to = pick(email.to);
  const cc = pick(email.cc);
  const bcc = pick(email.bcc);
  // Recipients present in the envelope but not in any header (e.g. forwards) go to bcc.
  const listed = new Set([...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()));
  for (const r of email.envelope.to) if (!listed.has(r.toLowerCase())) bcc.push({ address: r });
  if (!to.length && (cc.length || bcc.length)) {
    // Many APIs require at least one "to"; promote the first cc/bcc.
    const first = cc.shift() ?? bcc.shift();
    if (first) to.push(first);
  }
  return { to, cc, bcc };
}

export function requireFields(cfg: Record<string, any>, keys: string[]) {
  for (const k of keys) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') throw new ProviderError(`Missing configuration: ${k}`, true);
  }
}
