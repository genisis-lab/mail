/**
 * Pictures for people. Your own is uploaded in Settings; people on this server
 * show theirs. For everyone else Wren looks for a Gravatar (which many people
 * set up once for WordPress, GitHub, Slack…) and, for companies, the brand logo
 * they publish with BIMI, which is what Gmail, Yahoo and Apple Mail show next to
 * verified mail. Gmail and Yahoo don't make their users' own photos available.
 *
 * The server makes these lookups, never the browser, so nobody learns who
 * writes to you from your device; Gravatar sees only a hash of the address.
 * What's found, and what isn't, is kept for a week.
 */
import { get, now, run } from '../db/index.js';
import { getBlob, putBlob } from '../mail/blobs.js';
import { domainOf, normalizeEmail } from '../lib/addr.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest } from '../lib/http.js';
import { platform } from '../platform.js';

export interface Picture {
  data: Buffer;
  type: string;
}

const WEEK = 7 * 86_400_000;
/** A failed lookup (network trouble) is tried again after this long. */
const RETRY = 3_600_000;
export const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_GRAVATAR_BYTES = 512 * 1024;
/** BIMI's own limit for a logo. */
const MAX_LOGO_BYTES = 32 * 1024;

/** The image type from the file's first bytes (not what the sender claims). */
export function imageType(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  const b = data;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export async function setUserAvatar(userId: number, data: Uint8Array): Promise<number> {
  if (!data.length) throw badRequest('Choose a picture');
  if (data.length > MAX_AVATAR_BYTES) throw badRequest('That picture is too large (1 MB at most)');
  const type = imageType(data);
  if (!type) throw badRequest('Use a JPEG, PNG, GIF or WebP picture');
  const blob = await putBlob(data);
  const at = now();
  run('UPDATE users SET avatar_blob = ?, avatar_type = ?, avatar_at = ? WHERE id = ?', [blob, type, at, userId]);
  return at;
}

export function clearUserAvatar(userId: number) {
  run('UPDATE users SET avatar_blob = NULL, avatar_type = NULL, avatar_at = ? WHERE id = ?', [now(), userId]);
}

/** Read a response body, giving up past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function gravatar(address: string): Promise<Picture | null> {
  // d=404: no picture means a 404, not Gravatar's generic placeholder.
  const res = await fetch(`https://gravatar.com/avatar/${sha256(address)}?s=160&d=404`, { signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gravatar answered ${res.status}`);
  const data = await readCapped(res, MAX_GRAVATAR_BYTES);
  const type = data && imageType(data);
  return data && type ? { data, type } : null;
}

/** example.co.uk → example.co.uk; mail.example.com → example.com (close enough for BIMI and DMARC). */
function orgDomain(domain: string): string {
  const parts = domain.split('.');
  const twoLevel = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

async function txtRecord(name: string, version: RegExp): Promise<string | null> {
  return (await platform().dns.txt(name)).find((t) => version.test(t.trim())) ?? null;
}

/** A tag's value from a DMARC or BIMI record ("v=BIMI1; l=https://…"). */
const tag = (record: string, key: string) => new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]*)`, 'i').exec(record)?.[1]?.trim() ?? '';

async function bimiLogo(domain: string): Promise<Picture | null> {
  const org = orgDomain(domain);
  // BIMI only counts for domains whose DMARC turns away mail that fails it,
  // otherwise anyone could send as them wearing their logo.
  const dmarc = (await txtRecord(`_dmarc.${domain}`, /^v=DMARC1/i)) ?? (org !== domain ? await txtRecord(`_dmarc.${org}`, /^v=DMARC1/i) : null);
  if (!dmarc) return null;
  const policy = tag(dmarc, domain === org || !tag(dmarc, 'sp') ? 'p' : 'sp').toLowerCase();
  const pct = tag(dmarc, 'pct');
  if (!['quarantine', 'reject'].includes(policy) || (pct && pct !== '100')) return null;

  const record = (await txtRecord(`default._bimi.${domain}`, /^v=BIMI1/i)) ?? (org !== domain ? await txtRecord(`default._bimi.${org}`, /^v=BIMI1/i) : null);
  const url = record ? tag(record, 'l') : '';
  if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await readCapped(res, MAX_LOGO_BYTES);
  if (!data || !/<svg[\s>]/i.test(data.subarray(0, 4096).toString('utf8'))) return null;
  return { data, type: 'image/svg+xml' };
}

/** A cached lookup: what was found (or that nothing was) stays for a week. */
async function cached(key: string, source: string, find: () => Promise<Picture | null>, allowLookup: () => boolean): Promise<Picture | null> {
  const row = get<{ blob: string | null; content_type: string | null; checked_at: number }>('SELECT blob, content_type, checked_at FROM avatar_cache WHERE key = ?', [key]);
  const fresh = row && now() - row.checked_at < WEEK;
  const earlier = async () => (row?.blob ? { data: await getBlob(row.blob), type: row.content_type ?? 'application/octet-stream' } : null);
  if (fresh || !allowLookup()) return earlier();
  let pic: Picture | null;
  try {
    pic = await find();
  } catch {
    // Couldn't ask (offline, timeout): keep any earlier answer and try again in a while.
    run(
      `INSERT INTO avatar_cache (key, source, blob, content_type, checked_at) VALUES (?, ?, NULL, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET checked_at = excluded.checked_at`,
      [key, source, now() - WEEK + RETRY],
    );
    return earlier();
  }
  const blob = pic ? await putBlob(pic.data) : null;
  run(
    `INSERT INTO avatar_cache (key, source, blob, content_type, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET source = excluded.source, blob = excluded.blob, content_type = excluded.content_type, checked_at = excluded.checked_at`,
    [key, source, blob, pic?.type ?? null, now()],
  );
  return pic;
}

/**
 * The picture for an address: someone on this server's own, else (when the
 * viewer wants sender pictures) their Gravatar, else their company's BIMI logo.
 */
export async function pictureFor(
  address: string,
  opts: { lookups: boolean; /** False once someone has asked for too many new lookups. */ allowLookup?: () => boolean },
): Promise<{ picture: Picture; local: boolean } | null> {
  const allow = opts.allowLookup ?? (() => true);
  const addr = normalizeEmail(address);
  if (!addr || !addr.includes('@')) return null;
  const local = get<{ avatar_blob: string | null; avatar_type: string | null }>(
    `SELECT u.avatar_blob, u.avatar_type FROM addresses a JOIN users u ON u.id = a.user_id WHERE a.address = ? AND a.user_id IS NOT NULL LIMIT 1`,
    [addr],
  );
  if (local?.avatar_blob) return { picture: { data: await getBlob(local.avatar_blob), type: local.avatar_type ?? 'image/jpeg' }, local: true };
  if (!opts.lookups) return null;
  const found = await cached(addr, 'gravatar', () => gravatar(addr), allow);
  if (found) return { picture: found, local: false };
  // A brand logo is for companies, not for people on this server.
  if (local) return null;
  const domain = domainOf(addr);
  if (!domain || get('SELECT 1 FROM domains WHERE name = ?', [domain])) return null;
  const logo = await cached(`@${domain}`, 'bimi', () => bimiLogo(domain), allow);
  return logo ? { picture: logo, local: false } : null;
}
