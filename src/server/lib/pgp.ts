import crypto from 'node:crypto';
import { badRequest } from './http.js';

/**
 * Just enough OpenPGP (RFC 9580) for the server to check a public key someone
 * saves or publishes: it must be exactly one public key, never a private one.
 * Reads its fingerprint and the addresses in its user IDs. Signatures aren't
 * checked here; the browser's OpenPGP library does that before it uses a key.
 */
export interface PublicKeyInfo {
  fingerprint: string;
  /** The name in the first user ID. */
  name: string;
  /** Lower-cased addresses from the user IDs. */
  emails: string[];
}

const ARMOR = /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/;
const notAKey = () => badRequest('That isn’t a PGP public key. It starts with -----BEGIN PGP PUBLIC KEY BLOCK-----', 'pgp_invalid');

export function readPublicKey(armored: string): PublicKeyInfo {
  if (/PRIVATE KEY BLOCK/.test(armored)) throw badRequest('That’s a private key. Never share it; paste the public key instead.', 'pgp_private');
  const m = ARMOR.exec(armored);
  if (!m) throw notAKey();
  let lines = m[1].split(/\r?\n/).map((l) => l.trim());
  // Armor headers ("Comment: …") end at the first blank line; the optional checksum line is "=" and 4 characters.
  const blank = lines.indexOf('');
  if (blank !== -1 && lines.slice(0, blank).every((l) => /^[\w-]+: /.test(l))) lines = lines.slice(blank + 1);
  const b64 = lines.filter((l) => l && !/^=[A-Za-z0-9+/]{4}$/.test(l)).join('');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw notAKey();
  const packets = readPackets(new Uint8Array(Buffer.from(b64, 'base64')));

  if (packets.some((p) => p.tag === 5 || p.tag === 7)) throw badRequest('That’s a private key. Never share it; paste the public key instead.', 'pgp_private');
  if (packets[0]?.tag !== 6) throw notAKey();
  if (packets.filter((p) => p.tag === 6).length > 1) throw badRequest('Add one key at a time', 'pgp_invalid');
  const userIds = packets.filter((p) => p.tag === 13).map((p) => new TextDecoder().decode(p.body));
  if (!userIds.length) throw badRequest('This key has no name or address in it', 'pgp_invalid');

  const emails = [...new Set(userIds.map((u) => (/<([^<>\s]+@[^<>\s]+)>/.exec(u)?.[1] ?? (/^\S+@\S+$/.test(u.trim()) ? u.trim() : '')).toLowerCase()).filter(Boolean))];
  const name = userIds[0].replace(/<[^>]*>/, '').replace(/\([^)]*\)/, '').trim();
  return { fingerprint: fingerprint(packets[0].body), name: name.slice(0, 200), emails };
}

/** v4: SHA-1 of the key packet; v5 and v6: SHA-256 with a 4-byte length. */
function fingerprint(body: Uint8Array): string {
  const v = body[0];
  if (v !== 4 && v !== 5 && v !== 6) throw badRequest('This key uses a format Wren doesn’t support', 'pgp_invalid');
  const head = v === 4 ? Buffer.from([0x99, body.length >> 8, body.length & 0xff]) : Buffer.alloc(5);
  if (v !== 4) {
    head[0] = v === 5 ? 0x9a : 0x9b;
    head.writeUInt32BE(body.length, 1);
  }
  return crypto
    .createHash(v === 4 ? 'sha1' : 'sha256')
    .update(head)
    .update(body)
    .digest('hex')
    .toUpperCase();
}

function readPackets(bytes: Uint8Array): { tag: number; body: Uint8Array }[] {
  const out: { tag: number; body: Uint8Array }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const h = bytes[i++];
    if (!(h & 0x80)) throw notAKey();
    let tag: number;
    let len = 0;
    if (h & 0x40) {
      tag = h & 0x3f;
      const o = bytes[i++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + bytes[i++] + 192;
      else if (o === 255) {
        for (let k = 0; k < 4; k++) len = len * 256 + bytes[i++];
      } else throw notAKey(); // partial lengths never appear in keys
    } else {
      tag = (h >> 2) & 0x0f;
      const n = [1, 2, 4, 0][h & 3];
      if (!n) throw notAKey();
      for (let k = 0; k < n; k++) len = len * 256 + bytes[i++];
    }
    // NaN (ran past the end) fails this too.
    if (!(i + len <= bytes.length)) throw notAKey();
    out.push({ tag, body: bytes.subarray(i, i + len) });
    i += len;
  }
  return out;
}
