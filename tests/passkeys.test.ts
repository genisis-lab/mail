import { createHash, webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/server/db/index';
import { decodeCbor, derToRaw } from '../src/server/lib/webauthn';
import { describeDevice } from '../src/server/services/signin-alerts';
import { harness, outbox } from './harness';

const h = harness();
const ORIGIN = 'http://localhost:8787';
const RP = 'localhost';
const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());

// ── A tiny CBOR encoder and a software authenticator ───────────────────────

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

/** IEEE P1363 (r‖s) to DER, as authenticators send it. */
function rawToDer(raw: Uint8Array) {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), Buffer.from(v)]);
  };
  const body = Buffer.concat([int(raw.slice(0, 32)), int(raw.slice(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

class Authenticator {
  id = webcrypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  keys!: CryptoKeyPair;
  async init() {
    this.keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return this;
  }
  authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([Buffer.from(sha(RP)), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }
  async create(challenge: string, origin = ORIGIN) {
    const jwk = await webcrypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, Buffer.from(this.id), cose]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(0x45, attested)],
      ]),
    );
    return { clientDataJSON: b64(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }))), attestationObject: b64(attestationObject) };
  }
  async get(challenge: string, opts: { origin?: string; uv?: boolean; bump?: boolean } = {}) {
    if (opts.bump !== false) this.counter++;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? ORIGIN }));
    const authData = this.authData(opts.uv === false ? 0x01 : 0x05);
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, Buffer.concat([authData, Buffer.from(sha(clientData))])));
    return { id: b64(this.id), response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(rawToDer(raw)) } };
  }
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
});

describe('passkeys', () => {
  let key: Authenticator;

  it('adds a passkey after the password is confirmed', async () => {
    expect((await h.call('POST', '/api/account/passkeys/options', { password: 'wrong' })).status).toBe(401);
    const opts = (await h.call('POST', '/api/account/passkeys/options', { password: 'a very long password' })).body;
    expect(opts).toMatchObject({ rp: { id: RP }, attestation: 'none', user: { name: 'admin@wren.test' } });
    expect(opts.user.id).not.toMatch(/admin|wren/);
    key = await new Authenticator().init();

    // A response for another site is refused, and its challenge is used up.
    const wrong = await h.call('POST', '/api/account/passkeys', { name: 'Evil', response: await key.create(opts.challenge, 'https://evil.example') });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/came from https:\/\/evil\.example/);

    const opts2 = (await h.call('POST', '/api/account/passkeys/options', { password: 'a very long password' })).body;
    const ok = await h.call('POST', '/api/account/passkeys', { name: 'MacBook Touch ID', response: await key.create(opts2.challenge), transports: ['internal', 'hybrid'] });
    expect(ok.status).toBe(200);
    const list = (await h.call('GET', '/api/account/passkeys')).body.passkeys;
    expect(list).toMatchObject([{ name: 'MacBook Touch ID', transports: ['internal', 'hybrid'], lastUsedAt: null }]);

    // The same authenticator can't be added twice.
    const opts3 = (await h.call('POST', '/api/account/passkeys/options', { password: 'a very long password' })).body;
    expect(opts3.excludeCredentials).toEqual([{ type: 'public-key', id: b64(key.id), transports: ['internal', 'hybrid'] }]);
    expect((await h.call('POST', '/api/account/passkeys', { name: 'Again', response: await key.create(opts3.challenge) })).body.error).toMatch(/already registered/);
  });

  it('signs in with the passkey, once per challenge', async () => {
    h.forget('pk');
    h.as('pk');
    const opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    expect(opts).toMatchObject({ rpId: RP, allowCredentials: [] });
    const assertion = await key.get(opts.challenge);
    const r = await h.call('POST', '/api/auth/passkey', assertion);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('admin@wren.test');
    expect((await h.call('GET', '/api/auth/me')).body.user.email).toBe('admin@wren.test');
    expect((await h.call('GET', '/api/account/passkeys')).body.passkeys[0].lastUsedAt).toBeGreaterThan(0);

    // Replaying it fails: the challenge is gone.
    h.forget('pk2');
    h.as('pk2');
    expect((await h.call('POST', '/api/auth/passkey', assertion)).status).toBe(401);
    // With an email, the account's passkeys are offered.
    expect((await h.call('POST', '/api/auth/passkey/options', { email: 'admin@wren.test' })).body.allowCredentials).toHaveLength(1);
  });

  it('refuses the wrong origin, a bad signature and a counter going backwards', async () => {
    h.as('pk2');
    let opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    expect((await h.call('POST', '/api/auth/passkey', await key.get(opts.challenge, { origin: 'https://phish.example' }))).status).toBe(401);

    opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    const forged = await key.get(opts.challenge);
    forged.response.signature = b64(rawToDer(webcrypto.getRandomValues(new Uint8Array(64))));
    expect((await h.call('POST', '/api/auth/passkey', forged)).status).toBe(401);

    opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    key.counter = get<{ sign_count: number }>('SELECT sign_count FROM passkeys')!.sign_count; // a copy still at the last counter
    const cloned = await key.get(opts.challenge, { bump: false });
    const r = await h.call('POST', '/api/auth/passkey', cloned);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/counter went backwards/);
    key.counter += 5;

    opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    const unknown = await (await new Authenticator().init()).get(opts.challenge);
    expect((await h.call('POST', '/api/auth/passkey', unknown)).body.error).toMatch(/isn’t registered here/);
  });

  it('still asks for the 2-step code when the passkey did not verify the user', async () => {
    run('UPDATE users SET totp_enabled = 1 WHERE email = ?', ['admin@wren.test']);
    h.forget('pk3');
    h.as('pk3');
    let opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    expect((await h.call('POST', '/api/auth/passkey', await key.get(opts.challenge, { uv: false }))).body).toEqual({ mfaRequired: true });
    expect((await h.call('GET', '/api/auth/me')).body).toMatchObject({ user: null, mfaPending: true });
    // With a PIN or biometric it's enough on its own.
    opts = (await h.call('POST', '/api/auth/passkey/options', {})).body;
    expect((await h.call('POST', '/api/auth/passkey', await key.get(opts.challenge))).body.user.email).toBe('admin@wren.test');
    run('UPDATE users SET totp_enabled = 0 WHERE email = ?', ['admin@wren.test']);
  });

  it('can be renamed and removed, and admins can remove them', async () => {
    h.as('admin');
    const [pk] = (await h.call('GET', '/api/account/passkeys')).body.passkeys;
    expect((await h.call('PUT', `/api/account/passkeys/${pk.id}`, { name: 'Laptop' })).status).toBe(200);
    const id = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
    expect((await h.call('GET', `/api/admin/users/${id}/detail`)).body.user.passkeys).toBe(1);
    expect((await h.call('DELETE', `/api/account/passkeys/${pk.id}`)).status).toBe(200);
    expect((await h.call('GET', '/api/account/passkeys')).body.passkeys).toEqual([]);
    expect((await h.call('DELETE', `/api/admin/users/${id}/passkeys`)).body.removed).toBe(0);
  });
});

describe('sign-in alerts', () => {
  const alerts = async () => (await outbox('notice')).filter((j) => /^New sign-in/.test(j.subject));

  it('emails when a new device signs in, not for the first one or a known one', async () => {
    await h.call('POST', '/api/admin/users', { email: 'nia@wren.test', name: 'Nia', password: 'nia password 123' });
    const before = (await alerts()).length;
    h.forget('nia-laptop');
    await h.login('nia@wren.test', 'nia password 123', 'nia-laptop'); // first device: recorded quietly
    await h.call('POST', '/api/auth/logout');
    await h.login('nia@wren.test', 'nia password 123', 'nia-laptop'); // same browser
    expect((await alerts()).length).toBe(before);

    h.forget('nia-phone');
    h.as('nia-phone');
    await h.call('POST', '/api/auth/login', { email: 'nia@wren.test', password: 'nia password 123' }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    const sent = await alerts();
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.subject).toBe('New sign-in: Safari on iOS');
    expect(sent.at(-1)!.to).toEqual(['nia@wren.test']);
    expect(sent.at(-1)!.text).toMatch(/Signed in with your password/);

    // Turned off in settings: nothing.
    await h.call('PUT', '/api/account/prefs', { signInAlerts: false });
    h.forget('nia-tablet');
    await h.login('nia@wren.test', 'nia password 123', 'nia-tablet');
    expect((await alerts()).length).toBe(before + 1);
  });

  it('names browsers and systems', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox on Linux');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(describeDevice('curl/8.0')).toBe('A browser');
  });
});

describe('webauthn helpers', () => {
  it('decodes CBOR and DER signatures', () => {
    const { value, end } = decodeCbor(cbor(new Map<unknown, unknown>([['a', 1], [-2, new Uint8Array([1, 2])]])));
    expect(end).toBeGreaterThan(0);
    expect((value as Map<unknown, unknown>).get('a')).toBe(1);
    expect([...((value as Map<unknown, unknown>).get(-2) as Uint8Array)]).toEqual([1, 2]);
    const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect([...derToRaw(rawToDer(raw))]).toEqual([...raw]);
    expect(() => decodeCbor(new Uint8Array([0x5f]))).toThrow(/Indefinite/);
  });
});
