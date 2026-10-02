/**
 * Passkeys (WebAuthn level 2): just what a mail server needs to register
 * and verify passkeys, on WebCrypto, without dependencies.
 *
 * Registration asks for "none" attestation, so the attestation statement
 * isn't checked; the credential's public key is taken from the
 * authenticator data. ES256 (P-256) and RS256 keys are supported, which
 * covers every platform authenticator and security key in common use.
 */
import { createHash } from 'node:crypto';

export const ES256 = -7;
export const RS256 = -257;

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(s, 'base64url'));
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());

export class WebAuthnError extends Error {}

// ── CBOR (RFC 8949), the subset authenticators produce ─────────────────────

type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/** Decode one CBOR item; returns it and the number of bytes it used. */
export function decodeCbor(data: Uint8Array, start = 0): { value: Cbor; end: number } {
  let pos = start;
  const need = (n: number) => {
    if (pos + n > data.length) throw new WebAuthnError('Truncated CBOR');
  };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new WebAuthnError('CBOR nested too deeply');
    need(1);
    const head = data[pos++];
    const major = head >> 5;
    const info = head & 31;
    const arg = (): number => {
      if (info < 24) return info;
      if (info === 24) return need(1), data[pos++];
      if (info === 25) return need(2), (pos += 2), view.getUint16(pos - 2);
      if (info === 26) return need(4), (pos += 4), view.getUint32(pos - 4);
      if (info === 27) {
        need(8);
        const v = view.getBigUint64(pos);
        pos += 8;
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('CBOR integer too large');
        return Number(v);
      }
      throw new WebAuthnError('Indefinite-length CBOR is not supported');
    };
    switch (major) {
      case 0:
        return arg();
      case 1:
        return -1 - arg();
      case 2: {
        const n = arg();
        need(n);
        pos += n;
        return data.slice(pos - n, pos);
      }
      case 3: {
        const n = arg();
        need(n);
        pos += n;
        return new TextDecoder().decode(data.subarray(pos - n, pos));
      }
      case 4: {
        const n = arg();
        if (n > 1000) throw new WebAuthnError('CBOR array too long');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = arg();
        if (n > 1000) throw new WebAuthnError('CBOR map too long');
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 6:
        arg(); // a tag: ignore it, keep the value
        return item(depth + 1);
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) return need(2), (pos += 2), view.getUint16(pos - 2);
        if (info === 26) return need(4), (pos += 4), view.getFloat32(pos - 4);
        if (info === 27) return need(8), (pos += 8), view.getFloat64(pos - 8);
        throw new WebAuthnError('Unsupported CBOR value');
      }
    }
  };
  const value = item(0);
  return { value, end: pos };
}

// ── Authenticator data ─────────────────────────────────────────────────────

export interface AuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credential?: { id: Uint8Array; publicKey: Map<Cbor, Cbor> };
}

export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new WebAuthnError('Authenticator data is too short');
  const flags = data[32];
  const out: AuthData = {
    rpIdHash: data.slice(0, 32),
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    signCount: new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0),
  };
  if (flags & 0x40) {
    if (data.length < 55) throw new WebAuthnError('Attested credential data is missing');
    const len = (data[53] << 8) | data[54];
    if (55 + len > data.length) throw new WebAuthnError('Credential id is truncated');
    const id = data.slice(55, 55 + len);
    const { value } = decodeCbor(data, 55 + len);
    if (!(value instanceof Map)) throw new WebAuthnError('Credential public key is not a COSE key');
    out.credential = { id, publicKey: value };
  }
  return out;
}

/** A COSE public key as a JWK WebCrypto can import. */
export function coseToJwk(key: Map<Cbor, Cbor>): { alg: number; jwk: JsonWebKey } {
  const kty = key.get(1);
  const alg = key.get(3);
  if (kty === 2 && alg === ES256 && key.get(-1) === 1) {
    const x = key.get(-2);
    const y = key.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new WebAuthnError('Bad P-256 key');
    return { alg: ES256, jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y), ext: true } };
  }
  if (kty === 3 && alg === RS256) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256) throw new WebAuthnError('Bad RSA key');
    return { alg: RS256, jwk: { kty: 'RSA', n: b64url(n), e: b64url(e), alg: 'RS256', ext: true } };
  }
  throw new WebAuthnError('This passkey uses an algorithm Wren doesn’t support');
}

// ── Client data ────────────────────────────────────────────────────────────

interface Expect {
  challenge: string;
  origin: string;
  rpId: string;
}

function checkClientData(clientDataJSON: Uint8Array, type: 'webauthn.create' | 'webauthn.get', expect: Expect) {
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    cd = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new WebAuthnError('Client data is not JSON');
  }
  if (cd.type !== type) throw new WebAuthnError('Wrong ceremony type');
  if (cd.challenge !== expect.challenge) throw new WebAuthnError('The sign-in challenge doesn’t match; try again');
  if (cd.origin !== expect.origin) throw new WebAuthnError(`This passkey request came from ${cd.origin}, not ${expect.origin}`);
  if (cd.crossOrigin) throw new WebAuthnError('Cross-origin requests are not allowed');
}

function checkAuthData(a: AuthData, rpId: string) {
  if (!equal(a.rpIdHash, sha256(rpId))) throw new WebAuthnError('The passkey belongs to a different site');
  if (!a.userPresent) throw new WebAuthnError('The authenticator didn’t confirm you were present');
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── Ceremonies ─────────────────────────────────────────────────────────────

export interface RegistrationResponse {
  clientDataJSON: string;
  attestationObject: string;
}

export interface NewCredential {
  credentialId: string;
  publicKey: string; // JWK JSON
  algorithm: number;
  signCount: number;
  userVerified: boolean;
}

export function verifyRegistration(response: RegistrationResponse, expect: Expect): NewCredential {
  checkClientData(fromB64url(response.clientDataJSON), 'webauthn.create', expect);
  const { value } = decodeCbor(fromB64url(response.attestationObject));
  if (!(value instanceof Map)) throw new WebAuthnError('Attestation object is not a map');
  const authData = value.get('authData');
  if (!(authData instanceof Uint8Array)) throw new WebAuthnError('Authenticator data is missing');
  const a = parseAuthData(authData);
  checkAuthData(a, expect.rpId);
  if (!a.credential) throw new WebAuthnError('No credential was created');
  const { alg, jwk } = coseToJwk(a.credential.publicKey);
  return { credentialId: b64url(a.credential.id), publicKey: JSON.stringify(jwk), algorithm: alg, signCount: a.signCount, userVerified: a.userVerified };
}

export interface AssertionResponse {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Verify a sign-in; returns the new signature counter and whether the user was verified (PIN, biometrics). */
export async function verifyAssertion(
  response: AssertionResponse,
  stored: { publicKey: string; algorithm: number; signCount: number },
  expect: Expect,
): Promise<{ signCount: number; userVerified: boolean }> {
  const clientData = fromB64url(response.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expect);
  const authData = fromB64url(response.authenticatorData);
  const a = parseAuthData(authData);
  checkAuthData(a, expect.rpId);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(sha256(clientData), authData.length);
  const jwk = JSON.parse(stored.publicKey) as JsonWebKey;
  let ok = false;
  if (stored.algorithm === ES256) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64url(response.signature)), signed);
  } else if (stored.algorithm === RS256) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(response.signature), signed);
  }
  if (!ok) throw new WebAuthnError('The passkey signature is not valid');
  // A counter that goes backwards means the key may have been cloned. (Synced passkeys always send 0.)
  if (a.signCount !== 0 && stored.signCount !== 0 && a.signCount <= stored.signCount) throw new WebAuthnError('This passkey’s counter went backwards; it may have been copied');
  return { signCount: a.signCount, userVerified: a.userVerified };
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants r‖s. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30) throw new WebAuthnError('Bad signature');
  let pos = 2;
  if (der[1] & 0x80) pos = 2 + (der[1] & 0x7f);
  const part = () => {
    if (der[pos] !== 0x02) throw new WebAuthnError('Bad signature');
    const len = der[pos + 1];
    let int = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) throw new WebAuthnError('Bad signature');
    const out = new Uint8Array(32);
    out.set(int, 32 - int.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

/** A random challenge, base64url. */
export function newChallenge(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
