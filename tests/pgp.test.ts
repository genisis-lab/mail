import { beforeAll, describe, expect, it } from 'vitest';
import * as openpgp from 'openpgp';
import { harness } from './harness';
import { readPublicKey } from '../src/server/lib/pgp';
import {
  armoredIn,
  decryptFile,
  decryptMime,
  decryptText,
  encryptFile,
  resealFile,
  unsealFile,
  encryptText,
  importPrivateKey,
  pgpKind,
  plainText,
  publicKeyFrom,
  signText,
  signedPart,
  usableKeys,
  verifyCleartext,
  verifyDetached,
  verifySignedMime,
} from '../src/web/lib/pgp';

const att = (contentType: string, filename = 'x') => ({ id: 1, filename, contentType, size: 1, contentId: null, inline: false });

async function keyPair(name: string, email: string, passphrase = 'correct horse') {
  const k = await openpgp.generateKey({ userIDs: [{ name, email }], passphrase, format: 'armored' });
  const privateKey = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: k.privateKey }), passphrase });
  return { ...k, unlocked: privateKey };
}

let ann: Awaited<ReturnType<typeof keyPair>>;
let bob: Awaited<ReturnType<typeof keyPair>>;
let eve: Awaited<ReturnType<typeof keyPair>>;

beforeAll(async () => {
  [ann, bob, eve] = await Promise.all([keyPair('Ann', 'ann@wren.test'), keyPair('Bob Builder', 'bob@example.org'), keyPair('Eve', 'eve@example.org')]);
});

describe('PGP in the browser', () => {
  it('encrypts to several keys, decrypts, and checks the signature inside', async () => {
    const armored = await encryptText('Meet at 6\n\nBring the map', [bob.publicKey, ann.publicKey], ann.unlocked);
    expect((await openpgp.readMessage({ armoredMessage: armored })).getEncryptionKeyIDs().every((id) => id.toHex() === '0000000000000000')).toBe(true);
    const m = { text: `Hi\n${armored}\n-- \nsent from Wren`, html: null, attachments: [] };
    expect(pgpKind(m)).toBe('encrypted');
    expect(armoredIn(m)).toBe(armored.trim());
    expect(await decryptText(armoredIn(m)!, bob.unlocked, [ann.publicKey])).toEqual({ text: 'Meet at 6\n\nBring the map', signature: 'valid' });
    // The sender reads their own Sent copy.
    expect((await decryptText(armored, ann.unlocked, [])).text).toBe('Meet at 6\n\nBring the map');
    // Signed by a key nobody saved for the sender.
    expect((await decryptText(armored, bob.unlocked, [eve.publicKey])).signature).toBe('unknown');
    await expect(decryptText(armored, eve.unlocked, [])).rejects.toThrow();
  });

  it('encrypts attachments as .pgp files that keep their name', async () => {
    const data = new Uint8Array([1, 2, 3, 250]);
    const sealed = await encryptFile(data, 'plan.pdf', [bob.publicKey]);
    expect(await decryptFile(sealed, bob.unlocked)).toEqual({ data, filename: 'plan.pdf' });
  });

  it('re-encrypts saved attachments for changed recipients and never trusts a .pgp filename', async () => {
    const bytes = new TextEncoder().encode('Confidential attachment');
    const original = await encryptFile(bytes, 'plans.txt', [ann.publicKey, bob.publicKey]);
    const updated = await resealFile(original, 'plans.txt.pgp', [ann.publicKey, eve.publicKey], ann.unlocked);
    expect(updated.filename).toBe('plans.txt.pgp');
    expect((await decryptFile(updated.data, eve.unlocked)).data).toEqual(bytes);
    await expect(decryptFile(updated.data, bob.unlocked)).rejects.toThrow();
    await expect(resealFile(original, 'plans.txt.pgp', [eve.publicKey], undefined)).rejects.toThrow(/Unlock/);
    const disguised = await resealFile(bytes, 'not-encrypted.pgp', [bob.publicKey], undefined);
    expect((await decryptFile(disguised.data, bob.unlocked)).data).toEqual(bytes);
  });

  it('restores sender-only draft attachments when encryption is turned off', async () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const encrypted = await encryptFile(data, 'plan.pdf', [ann.publicKey]);
    // Before the toggle, a recipient without the sender’s key cannot read the upload.
    await expect(decryptFile(encrypted, bob.unlocked)).rejects.toThrow();
    expect(await unsealFile(encrypted, 'plan.pdf.pgp', ann.unlocked)).toEqual({ data, filename: 'plan.pdf' });
    // Only remove the outer draft-encryption layer, including for original .pgp files.
    const nested = await encryptFile(encrypted, 'original.pgp', [ann.publicKey]);
    expect(await unsealFile(nested, 'original.pgp.pgp', ann.unlocked)).toEqual({ data: encrypted, filename: 'original.pgp' });
  });

  it('keeps ordinary attachments unchanged and refuses to unlock with a missing or wrong key', async () => {
    const data = new TextEncoder().encode('An ordinary attachment');
    expect((await unsealFile(data, 'ordinary.txt', undefined)).data).toBe(data);
    expect(await unsealFile(data, 'ordinary.pgp', undefined)).toEqual({ data, filename: 'ordinary.pgp' });
    const encrypted = await encryptFile(data, 'ordinary.txt', [ann.publicKey]);
    await expect(unsealFile(encrypted, 'ordinary.txt.pgp', undefined)).rejects.toThrow(/Unlock/);
    await expect(unsealFile(encrypted, 'ordinary.txt.pgp', bob.unlocked)).rejects.toThrow();
  });

  it('checks cleartext signatures and spots a changed message', async () => {
    const signed = await signText('Pay 10 euros', ann.unlocked);
    const m = { text: signed, html: null, attachments: [] };
    expect(pgpKind(m)).toBe('signed');
    expect(await verifyCleartext(armoredIn(m, true)!, [ann.publicKey])).toEqual({ text: 'Pay 10 euros', signature: 'valid' });
    expect((await verifyCleartext(signed.replace('10', '99'), [ann.publicKey])).signature).toBe('bad');
    expect((await verifyCleartext(signed, [bob.publicKey])).signature).toBe('unknown');
  });

  it('decrypts PGP/MIME and checks multipart/signed', async () => {
    const inner = 'Content-Type: multipart/mixed; boundary="in"\r\n\r\n--in\r\nContent-Type: text/plain\r\n\r\nSecret plans\r\n--in\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="a.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--in--\r\n';
    const sealed = await openpgp.encrypt({ message: await openpgp.createMessage({ text: inner }), encryptionKeys: await openpgp.readKey({ armoredKey: bob.publicKey }), signingKeys: ann.unlocked });
    expect(pgpKind({ text: null, html: null, attachments: [att('application/pgp-encrypted'), att('application/octet-stream', 'encrypted.asc')] })).toBe('encrypted-mime');
    const r = await decryptMime(new TextEncoder().encode(sealed), bob.unlocked, [ann.publicKey]);
    expect(r).toMatchObject({ text: 'Secret plans', signature: 'valid', attachments: [{ filename: 'a.bin', data: new Uint8Array([1, 2, 3]) }] });

    // multipart/signed, as Thunderbird sends it: the first part, headers and all, is what's signed.
    const part = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello there\r\n';
    const sig = await openpgp.sign({ message: await openpgp.createMessage({ text: part }), signingKeys: ann.unlocked, detached: true });
    const raw = `From: ann@wren.test\r\nContent-Type: multipart/signed; micalg=pgp-sha256;\r\n protocol="application/pgp-signature"; boundary="sig"\r\n\r\n--sig\r\n${part}\r\n--sig\r\nContent-Type: application/pgp-signature\r\n\r\n${sig}\r\n--sig--\r\n`;
    const signed = signedPart(new TextEncoder().encode(raw.replace(/\r\n/g, '\n')))!;
    expect(new TextDecoder().decode(signed)).toBe(part);
    expect(await verifyDetached(signed, sig, [ann.publicKey])).toBe('valid');
    const wrapped = `Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/html\r\n\r\n<p>Pay the attacker instead</p>\r\n--outer\r\n${raw}\r\n--outer--\r\n`;
    const verified = await verifySignedMime(new TextEncoder().encode(wrapped), sig, [ann.publicKey]);
    expect(verified.signature).toBe('valid');
    expect(verified.text).toContain('Hello there');
    expect(JSON.stringify(verified)).not.toContain('attacker');
    const wrappedEncrypted = await encryptText(wrapped, [bob.publicKey]);
    const opened = await decryptMime(new TextEncoder().encode(wrappedEncrypted), bob.unlocked, [ann.publicKey]);
    expect(opened.signature).toBe('valid');
    expect(opened.text).toContain('Hello there');
    expect(JSON.stringify(opened)).not.toContain('attacker');
    expect(await verifyDetached(signedPart(new TextEncoder().encode(raw.replace('Hello', 'Jello')))!, sig, [ann.publicKey])).toBe('bad');
    expect(pgpKind({ text: 'Hello there', html: null, attachments: [att('application/pgp-signature', 'signature.asc')] })).toBe('signed-mime');
  });

  it('reads keys people paste, and refuses private ones where a public one belongs', async () => {
    expect(await publicKeyFrom(`  ${bob.publicKey}\n`)).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    await expect(publicKeyFrom(bob.privateKey)).rejects.toThrow(/private key/);
    await expect(publicKeyFrom('hello')).rejects.toThrow(/isn’t a PGP public key/);
    await expect(importPrivateKey(bob.privateKey, 'wrong')).rejects.toThrow(/passphrase/);
    expect(await importPrivateKey(bob.privateKey, 'correct horse')).toContain('PRIVATE KEY BLOCK');
    // A key kept without a passphrase gets the one chosen on import.
    const bare = await openpgp.generateKey({ userIDs: [{ email: 'c@example.org' }], format: 'armored' });
    const imported = await importPrivateKey(bare.privateKey, 'new pass');
    await expect(openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: imported }), passphrase: 'new pass' })).resolves.toBeTruthy();
    const expired = await openpgp.generateKey({ userIDs: [{ email: 'old@example.org' }], keyExpirationTime: 1, date: new Date(Date.now() - 86_400_000), format: 'armored' });
    expect(await usableKeys([bob.publicKey, expired.publicKey, 'junk'])).toEqual([bob.publicKey]);
  });

  it('turns the editor’s HTML into the plain text that gets encrypted', () => {
    expect(plainText('<div>Hi &amp; bye<br>line 2</div><p><br></p><p>a &lt;b&gt;</p>')).toBe('Hi & bye\nline 2\n\na <b>');
  });
});

describe('PGP keys on the server', () => {
  it('reads a public key’s fingerprint and addresses, and refuses anything else', async () => {
    const info = readPublicKey(bob.publicKey);
    expect(info).toEqual({ fingerprint: (await openpgp.readKey({ armoredKey: bob.publicKey })).getFingerprint().toUpperCase(), name: 'Bob Builder', emails: ['bob@example.org'], armored: bob.publicKey.trim() });
    expect(readPublicKey(`Here's my key:\n${bob.publicKey}\nThanks`).armored).toBe(bob.publicKey.trim());
    // Armor headers and the old checksum line are fine.
    const withHeaders = bob.publicKey.replace('-----BEGIN PGP PUBLIC KEY BLOCK-----\n', '-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: hi\n');
    expect(readPublicKey(withHeaders).fingerprint).toBe(info.fingerprint);
    expect(() => readPublicKey(bob.privateKey)).toThrow(/private key/);
    // A secret key packet dressed up as a public key block.
    const disguised = bob.privateKey.replace(/PRIVATE KEY BLOCK/g, 'PUBLIC KEY BLOCK');
    expect(() => readPublicKey(disguised)).toThrow(/private key/);
    expect(() => readPublicKey('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnot base64!\n-----END PGP PUBLIC KEY BLOCK-----')).toThrow(/isn’t a PGP public key/);
    expect(() => readPublicKey('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxsBN\n-----END PGP PUBLIC KEY BLOCK-----')).toThrow(/isn’t a PGP public key/);
    const two = (await openpgp.readKey({ armoredKey: bob.publicKey })).write();
    const both = new Uint8Array([...two, ...(await openpgp.readKey({ armoredKey: eve.publicKey })).write()]);
    expect(() => readPublicKey(openpgp.armor(openpgp.enums.armor.publicKey, both))).toThrow(/one key/);
  });

  it('saves, lists, looks up and removes keys, and publishes your own to people on the server', async () => {
    const h = harness();
    await h.setup();
    await h.login('admin@wren.test', 'a very long password', 'admin');
    expect((await h.call('POST', '/api/admin/users', { email: 'ann@wren.test', name: 'Ann', password: 'another long password' })).status).toBe(200);

    // Only a public key, within the size limit.
    expect((await h.call('POST', '/api/me/pgp/keys', { armored: bob.privateKey })).body.code).toBe('pgp_private');
    expect((await h.call('POST', '/api/me/pgp/keys', { armored: 'x'.repeat(100_001) })).status).toBe(400);
    const saved = await h.call('POST', '/api/me/pgp/keys', { armored: bob.publicKey });
    expect(saved.body.key).toMatchObject({ name: 'Bob Builder', emails: ['bob@example.org'], fingerprint: readPublicKey(bob.publicKey).fingerprint });
    // Saving it again replaces it rather than adding a second copy.
    expect((await h.call('POST', '/api/me/pgp/keys', { armored: bob.publicKey })).body.updated).toBe(true);
    expect((await h.call('GET', '/api/me/pgp')).body).toMatchObject({ published: null, keys: [{ id: saved.body.key.id }] });

    // Ann publishes her key; someone else's key can't be published as hers.
    await h.login('ann@wren.test', 'another long password', 'ann');
    expect((await h.call('PUT', '/api/me/pgp/published', { armored: eve.publicKey })).body.code).toBe('pgp_not_yours');
    expect((await h.call('PUT', '/api/me/pgp/published', { armored: ann.publicKey })).status).toBe(200);
    expect((await h.call('GET', '/api/me/pgp')).body.published.fingerprint).toBe(readPublicKey(ann.publicKey).fingerprint);
    // Ann can't see or remove the admin's saved keys.
    expect((await h.call('DELETE', `/api/me/pgp/keys/${saved.body.key.id}`)).status).toBe(404);

    h.as('admin');
    const look = await h.call('POST', '/api/me/pgp/lookup', { addresses: ['Bob@Example.org', 'ann@wren.test', 'nobody@example.org'] });
    expect(Object.keys(look.body.keys).sort()).toEqual(['ann@wren.test', 'bob@example.org']);
    expect(look.body.keys['ann@wren.test'][0].armored).toContain('PUBLIC KEY BLOCK');
    // Ann's key isn't a key the admin saved, so it doesn't show in their list.
    expect((await h.call('GET', '/api/me/pgp')).body.keys).toHaveLength(1);

    expect((await h.call('DELETE', `/api/me/pgp/keys/${saved.body.key.id}`)).status).toBe(200);
    h.as('ann');
    expect((await h.call('DELETE', '/api/me/pgp/published')).status).toBe(200);
    h.as('admin');
    expect((await h.call('POST', '/api/me/pgp/lookup', { addresses: ['bob@example.org', 'ann@wren.test'] })).body.keys).toEqual({});
  });

  it('sends a plain-text (encrypted) message as text/plain only, exactly as written', async () => {
    const h = harness();
    await h.setup();
    await h.login('admin@wren.test', 'a very long password');
    const armored = await encryptText('top secret', [bob.publicKey]);
    const draft = await h.call('POST', '/api/compose/drafts', { to: 'bob@example.org', subject: 'Plans', html: '<p>ignored</p>', text: armored });
    const d = await h.call('GET', `/api/compose/drafts/${draft.body.id}`);
    expect(d.body.text).toBe(armored);
    expect(d.body.html).toBeFalsy();
    expect(d.body.snippet).toBe('Encrypted message');
    const sent = await h.call('POST', '/api/compose/send', { to: 'bob@example.org', subject: 'Plans', text: armored, draftId: draft.body.id });
    expect(sent.status).toBe(200);
    const raw = await (await h.request(`/api/mail/messages/${sent.body.id}/raw`)).text();
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).not.toContain('text/html');
    expect(raw).not.toContain('top secret');
    const { default: PostalMime } = await import('postal-mime');
    const parsed = await PostalMime.parse(raw);
    expect((await decryptText(parsed.text!, bob.unlocked, [])).text).toBe('top secret');
  });
});
