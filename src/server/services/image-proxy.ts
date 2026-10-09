/**
 * Pictures in mail, fetched through Wren (like Gmail's image proxy). The
 * sender's server sees Cloudflare fetch the picture, never the reader's IP
 * address, device or browser, and the reader's browser keeps its copy for a
 * day.
 *
 * The Worker answers /api/img/<sig>?u=<url> itself, without the Durable Object:
 * one Worker request per picture, no database work, bandwidth free. It only
 * fetches URLs Wren signed (pictures in mail it has shown), so it can't be used
 * as an open proxy, and only passes on images.
 *
 * Self-hosted Wren loads pictures directly instead: a server on a home or
 * office network could otherwise be made to fetch addresses on that network.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { isPublicHttpsUrl } from './unsubscribe.js';

export const IMAGE_PATH = '/api/img/';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 300;
const UA = 'Mozilla/5.0 (compatible; WrenImageProxy/1.0; +https://github.com/genisis-lab/mail)';

/** The proxy's own key, derived from the server secret: the Worker gets this, never the secret. */
export function imageKey(secret: string): string {
  return crypto.createHmac('sha256', secret).update('wren-image-proxy-v1').digest('base64url');
}

export function signImage(url: string, key: string): string {
  return crypto.createHmac('sha256', key).update(url).digest('base64url').slice(0, 22);
}

let cached: { secret: string; key: string } | null = null;
const serverKey = () => {
  if (cached?.secret !== config.secret) cached = { secret: config.secret, key: imageKey(config.secret) };
  return cached.key;
};

/** An image address as the page will see it: trimmed, protocol-relative made https, http(s) only. */
export function normalizeImageUrl(raw: string): string | null {
  const t = raw.trim();
  const abs = t.startsWith('//') ? `https:${t}` : t;
  return /^https?:\/\/[^\s]+$/i.test(abs) && abs.length <= 2048 ? abs : null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The remote pictures in an email's HTML (img src, background, CSS url()). */
export function remoteImages(html: string): string[] {
  const text = decodeEntities(html);
  const found = new Set<string>();
  const add = (raw: string | undefined) => {
    const u = raw ? normalizeImageUrl(raw) : null;
    if (u) found.add(u);
  };
  for (const m of text.matchAll(/\b(?:src|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) add(m[2]);
  return [...found].slice(0, MAX_IMAGES);
}

/** Whether this server proxies pictures (not when self-hosted). */
export const proxyOn = () => config.imageProxy;

/** Signatures for an email's remote pictures ({url: sig}); the page loads them through /api/img/. */
export function signedImages(html: string | null | undefined): Record<string, string> | undefined {
  if (!html || !proxyOn()) return undefined;
  const urls = remoteImages(html);
  if (!urls.length) return undefined;
  const key = serverKey();
  return Object.fromEntries(urls.map((u) => [u, signImage(u, key)]));
}

/** The proxied address of one picture (a package's product photo), or null. */
export function proxiedImage(url: string | null | undefined): string | null {
  const u = url ? normalizeImageUrl(url) : null;
  if (!u || !proxyOn()) return null;
  return `${IMAGE_PATH}${signImage(u, serverKey())}?u=${encodeURIComponent(u)}`;
}

const deny = (status: number, message: string) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const IMAGE_HEADERS = {
  // Opened on its own, an SVG still can't run anything.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

export interface ServeOptions {
  fetch?: typeof fetch;
  /** The edge cache (caches.default in the Worker). */
  cache?: Cache | null;
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Answer /api/img/<sig>?u=<url> with the picture, or an error. */
export async function serveImage(request: Request, key: string, opts: ServeOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405, 'Method not allowed');
  const url = new URL(request.url);
  const sig = url.pathname.slice(IMAGE_PATH.length);
  const target = url.searchParams.get('u') ?? '';
  const expected = target ? signImage(target, key) : '';
  if (!target || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return deny(403, 'Not a picture Wren showed');
  if (!isPublicHttpsUrl(target.replace(/^http:/i, 'https:'))) return deny(400, 'Not a public address');

  const cacheKey = new Request(`${url.origin}${url.pathname}?u=${encodeURIComponent(target)}`);
  const hit = await opts.cache?.match(cacheKey).catch(() => undefined);
  if (hit) return withHeaders(hit.body, hit.headers.get('Content-Type') ?? 'application/octet-stream');

  let upstream: Response;
  try {
    upstream = await (opts.fetch ?? fetch)(target, {
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*;q=0.9,*/*;q=0.5', 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return deny(502, 'The picture couldn’t be fetched');
  }
  if (!upstream.ok) return deny(502, `The picture’s server answered ${upstream.status}`);
  const type = (upstream.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(type)) return deny(415, 'Not a picture');
  if (Number(upstream.headers.get('Content-Length') ?? 0) > MAX_BYTES) return deny(413, 'Picture too large');
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return deny(413, 'Picture too large');

  if (opts.cache) {
    const stored = new Response(body.slice(0), { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
    const put = opts.cache.put(cacheKey, stored).catch(() => {});
    if (opts.waitUntil) opts.waitUntil(put);
  }
  return withHeaders(body, type);
}

function withHeaders(body: BodyInit | null, type: string): Response {
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', ...IMAGE_HEADERS } });
}
