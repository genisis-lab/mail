/**
 * PGP (OpenPGP) in the browser. Private keys stay on this device: kept
 * passphrase-protected in this browser, one per account, and unlocked only in
 * this tab's memory. Encrypting, decrypting, signing and checking signatures
 * all happen here; nothing decrypted is sent to the server. OpenPGP.js loads
 * the first time it's needed, so the app itself doesn't get bigger.
 */
import type { Key, PrivateKey, VerifyMessageResult } from 'openpgp';
import type { MessageDetail } from '../../shared/types';

const openpgp = () => import('openpgp');

// ── Your key, in this browser ───────────────────────────────────────────────

const storageKey = (account: number) => `wren.pgp.${account}`;
/** Unlocked keys, for this tab only (never stored). */
const unlocked = new Map<number, PrivateKey>();

/** This account's private key in this browser (armored, passphrase-protected). */
export function storedKey(account: number): string | null {
  try {
    return localStorage.getItem(storageKey(account));
  } catch {
    return null;
  }
}

/** Keep a passphrase-protected private key in this browser. Throws when the browser won't store it. */
export function storeKey(account: number, armored: string) {
  localStorage.setItem(storageKey(account), armored);
  unlocked.delete(account);
}

export function forgetKey(account: number) {
  try {
    localStorage.removeItem(storageKey(account));
  } catch {
    /* blocked storage: nothing was kept */
  }
  unlocked.delete(account);
}

export function unlockedKey(account: number): PrivateKey | null {
  return unlocked.get(account) ?? null;
}

/** Open this account's key with its passphrase, for the rest of this tab's life. */
export async function unlockKey(account: number, passphrase: string): Promise<PrivateKey> {
  const armored = storedKey(account);
  if (!armored) throw new Error('There’s no PGP key in this browser. Add one in Settings → Encryption.');
  const { readPrivateKey, decryptKey } = await openpgp();
  const key = await decryptKey({ privateKey: await readPrivateKey({ armoredKey: armored }), passphrase }).catch(() => {
    throw new Error('That passphrase didn’t work');
  });
  unlocked.set(account, key);
  return key;
}

/** A new key pair for one address, protected by the passphrase. */
export async function createKey(name: string, email: string, passphrase: string): Promise<{ privateKey: string; publicKey: string }> {
  const { generateKey } = await openpgp();
  const { privateKey, publicKey } = await generateKey({ userIDs: [{ name, email }], passphrase, format: 'armored' });
  return { privateKey, publicKey };
}

/**
 * Check an imported private key opens with its passphrase and can encrypt;
 * one kept without a passphrase gets this one. Returns it passphrase-protected.
 */
export async function importPrivateKey(armored: string, passphrase: string): Promise<string> {
  const { readPrivateKey, decryptKey, encryptKey } = await openpgp();
  const key = await readPrivateKey({ armoredKey: armored.trim() }).catch(() => {
    throw new Error('That isn’t a PGP private key. It starts with -----BEGIN PGP PRIVATE KEY BLOCK-----');
  });
  await key.getEncryptionKey().catch(() => {
    throw new Error('This key can’t be used for encryption (it may have expired or been revoked)');
  });
  if (key.isDecrypted()) return (await encryptKey({ privateKey: key, passphrase })).armor();
  await decryptKey({ privateKey: key, passphrase }).catch(() => {
    throw new Error('That passphrase didn’t open this key');
  });
  return key.armor();
}

export async function publicKeyOf(armoredPrivate: string): Promise<string> {
  const { readPrivateKey } = await openpgp();
  return (await readPrivateKey({ armoredKey: armoredPrivate })).toPublic().armor();
}

export interface KeyInfo {
  fingerprint: string;
  userIds: string[];
  created: Date;
}

export async function keyInfo(armored: string): Promise<KeyInfo> {
  const { readKey } = await openpgp();
  const key = await readKey({ armoredKey: armored });
  return { fingerprint: key.getFingerprint().toUpperCase(), userIds: key.getUserIDs(), created: key.getCreationTime() };
}

/** "ABCD 1234 …": a fingerprint in groups of four, the way people compare them. */
export const formatFingerprint = (fp: string) => fp.replace(/(.{4})/g, '$1 ').trim();

/** Someone's public key to save, from pasted text or a key file (armored or binary). Refuses private keys. */
export async function publicKeyFrom(data: string | Uint8Array): Promise<string> {
  const { readKey } = await openpgp();
  const text = typeof data === 'string' ? data : /-----BEGIN PGP/.test(new TextDecoder().decode(data.subarray(0, 4096))) ? new TextDecoder().decode(data) : null;
  const key = await (text !== null ? readKey({ armoredKey: text.trim() }) : readKey({ binaryKey: data as Uint8Array })).catch(() => {
    throw new Error('That isn’t a PGP public key. It starts with -----BEGIN PGP PUBLIC KEY BLOCK-----');
  });
  if (key.isPrivate()) throw new Error('That’s a private key. Never share it; ask for the public key instead.');
  return key.armor();
}

async function readKeys(armored: string[]): Promise<Key[]> {
  const { readKey } = await openpgp();
  const keys = await Promise.all(armored.map((a) => readKey({ armoredKey: a }).catch(() => null)));
  return keys.filter((k): k is Key => !!k);
}

/** The keys that can still be encrypted to (not expired or revoked). */
export async function usableKeys(armored: string[]): Promise<string[]> {
  const { readKey } = await openpgp();
  const ok = await Promise.all(armored.map((a) => readKey({ armoredKey: a }).then((k) => k.getEncryptionKey().then(() => true)).catch(() => false)));
  return armored.filter((_, i) => ok[i]);
}

// ── Encrypting and signing ──────────────────────────────────────────────────

export async function encryptText(text: string, keys: string[], signingKey?: PrivateKey): Promise<string> {
  const { createMessage, encrypt } = await openpgp();
  return encrypt({ message: await createMessage({ text }), encryptionKeys: await readKeys(keys), signingKeys: signingKey });
}

/** An attachment as a binary .pgp file; the original name travels inside it. */
export async function encryptFile(data: Uint8Array, filename: string, keys: string[], signingKey?: PrivateKey): Promise<Uint8Array> {
  const { createMessage, encrypt } = await openpgp();
  return encrypt({ message: await createMessage({ binary: data, filename }), encryptionKeys: await readKeys(keys), signingKeys: signingKey, format: 'binary' });
}

/** Cleartext-signed text: readable anywhere, checkable with your public key. */
export async function signText(text: string, signingKey: PrivateKey): Promise<string> {
  const { createCleartextMessage, sign } = await openpgp();
  return sign({ message: await createCleartextMessage({ text }), signingKeys: signingKey });
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** valid: signed by a key known for the sender. bad: that key, but it doesn't check out. unknown: a key you don't have. */
export type SignatureStatus = 'valid' | 'bad' | 'unknown';

const PGP_MESSAGE = /^[ \t]*-----BEGIN PGP MESSAGE-----[\s\S]*?^[ \t]*-----END PGP MESSAGE-----/m;
const CLEARSIGNED = /^[ \t]*-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?^[ \t]*-----END PGP SIGNATURE-----/m;

type Body = Pick<MessageDetail, 'text' | 'html' | 'attachments'>;

/** How a message uses PGP: encrypted or signed, inline in the text or as PGP/MIME. */
export function pgpKind(m: Body): 'encrypted' | 'encrypted-mime' | 'signed' | 'signed-mime' | null {
  if (m.attachments.some((a) => a.contentType === 'application/pgp-encrypted')) return 'encrypted-mime';
  const text = bodyText(m);
  if (PGP_MESSAGE.test(text)) return 'encrypted';
  if (m.attachments.some((a) => a.contentType === 'application/pgp-signature')) return 'signed-mime';
  if (CLEARSIGNED.test(text)) return 'signed';
  return null;
}

/** The armored block of an inline encrypted (or, with `signed`, cleartext-signed) message. */
export function armoredIn(m: Body, signed = false): string | null {
  return (signed ? CLEARSIGNED : PGP_MESSAGE).exec(bodyText(m))?.[0].replace(/^[ \t]+/gm, '') ?? null;
}

function bodyText(m: Pick<Body, 'text' | 'html'>): string {
  if (m.text) return m.text;
  if (!m.html) return '';
  return decodeEntities(m.html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|pre|li|tr)>/gi, '\n').replace(/<[^>]+>/g, ''));
}

const decodeEntities = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Which of the sender's keys made the signature, and whether it checks out. */
async function signatureStatus(signatures: VerifyMessageResult['signatures'], keys: Key[]): Promise<SignatureStatus | null> {
  if (!signatures.length) return null;
  const known = signatures.find((s) => keys.some((k) => k.getKeys(s.keyID).length));
  if (!known) return 'unknown';
  return known.verified.then(
    () => 'valid' as const,
    () => 'bad' as const,
  );
}

async function readAnyMessage(data: string | Uint8Array) {
  const { readMessage } = await openpgp();
  if (typeof data === 'string') return readMessage({ armoredMessage: data });
  const head = new TextDecoder().decode(data.subarray(0, 100));
  return /-----BEGIN PGP MESSAGE-----/.test(head) ? readMessage({ armoredMessage: new TextDecoder().decode(data) }) : readMessage({ binaryMessage: data });
}

/** Decrypt an inline PGP message; `senderKeys` check a signature inside it. */
export async function decryptText(armored: string, key: PrivateKey, senderKeys: string[]): Promise<{ text: string; signature: SignatureStatus | null }> {
  const { decrypt } = await openpgp();
  const verificationKeys = await readKeys(senderKeys);
  const r = await decrypt({ message: await readAnyMessage(armored), decryptionKeys: key, verificationKeys });
  return { text: r.data, signature: await signatureStatus(r.signatures, verificationKeys) };
}

/** An encrypted attachment (name.pgp): the file and its name. */
export async function decryptFile(data: Uint8Array, key: PrivateKey): Promise<{ data: Uint8Array; filename: string }> {
  const { decrypt } = await openpgp();
  const r = await decrypt({ message: await readAnyMessage(data), decryptionKeys: key, format: 'binary' });
  return { data: r.data, filename: r.filename };
}

export interface DecryptedFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface DecryptedMime {
  text: string | null;
  html: string | null;
  attachments: DecryptedFile[];
  signature: SignatureStatus | null;
}

/** Decrypt a PGP/MIME message (its encrypted.asc part): inside is a whole MIME message, read here with postal-mime. */
export async function decryptMime(data: Uint8Array, key: PrivateKey, senderKeys: string[]): Promise<DecryptedMime> {
  const { decrypt } = await openpgp();
  const verificationKeys = await readKeys(senderKeys);
  const r = await decrypt({ message: await readAnyMessage(data), decryptionKeys: key, verificationKeys, format: 'binary' });
  const { default: PostalMime } = await import('postal-mime');
  const email = await PostalMime.parse(r.data, { attachmentEncoding: 'arraybuffer' });
  // Signed, then encrypted as a second layer: what's inside is itself multipart/signed.
  const sig = email.attachments.find((a) => a.mimeType === 'application/pgp-signature');
  let signature = await signatureStatus(r.signatures, verificationKeys);
  const signed = sig && !signature ? signedPart(r.data) : null;
  if (sig && signed) signature = await verifyDetached(signed, new TextDecoder().decode(sig.content as ArrayBuffer), senderKeys);
  return {
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments
      .filter((a) => a !== sig)
      .map((a) => ({ filename: a.filename || 'attachment', contentType: a.mimeType || 'application/octet-stream', data: new Uint8Array(a.content as ArrayBuffer) })),
    signature,
  };
}

/** Check a cleartext-signed message. Returns the text that was signed. */
export async function verifyCleartext(armored: string, senderKeys: string[]): Promise<{ text: string; signature: SignatureStatus }> {
  const { readCleartextMessage, verify } = await openpgp();
  const message = await readCleartextMessage({ cleartextMessage: armored });
  const keys = await readKeys(senderKeys);
  const r = await verify({ message, verificationKeys: keys });
  return { text: message.getText(), signature: (await signatureStatus(r.signatures, keys)) ?? 'unknown' };
}

/** Check a detached signature (PGP/MIME's signature.asc) over the signed bytes. */
export async function verifyDetached(data: Uint8Array, armoredSignature: string, senderKeys: string[]): Promise<SignatureStatus> {
  const { readSignature, createMessage, verify, enums } = await openpgp();
  const signature = await readSignature({ armoredSignature });
  const keys = await readKeys(senderKeys);
  const textMode = signature.packets[0]?.signatureType === enums.signature.text;
  const message = await (textMode ? createMessage({ text: new TextDecoder().decode(data) }) : createMessage({ binary: data }));
  const r = await verify({ message, signature, verificationKeys: keys });
  return (await signatureStatus(r.signatures, keys)) ?? 'unknown';
}

/**
 * RFC 3156: what a multipart/signed message signs is its first part exactly as
 * sent, MIME headers included, with CRLF line ends. Found in the raw message.
 */
export function signedPart(raw: Uint8Array): Uint8Array | null {
  // One character per byte, so the bytes come back out unchanged.
  let s = '';
  for (let i = 0; i < raw.length; i += 8192) s += String.fromCharCode(...raw.subarray(i, i + 8192));
  const header = /^content-type:[ \t]*multipart\/signed((?:[^\r\n]|\r?\n[ \t])*)/im.exec(s);
  const boundary = header && /boundary="?([^";\r\n]+)"?/i.exec(header[1])?.[1];
  if (!header || !boundary) return null;
  const delimiter = `--${boundary}`;
  const first = s.indexOf(delimiter, header.index + header[0].length);
  const start = first === -1 ? -1 : s.indexOf('\n', first) + 1;
  const end = start > 0 ? s.indexOf(`\n${delimiter}`, start) : -1;
  if (end === -1) return null;
  // The line break before the next delimiter belongs to the delimiter.
  const part = s.slice(start, end).replace(/\r$/, '').replace(/\r?\n/g, '\r\n');
  return Uint8Array.from(part, (ch) => ch.charCodeAt(0));
}

// ── Compose ─────────────────────────────────────────────────────────────────

/**
 * The compose editor's HTML as the plain text an encrypted or signed message carries.
 * shortcut: quoted text loses its "> " marks and pictures are dropped; fine for plain-text PGP mail, revisit if people ask.
 */
export function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text back into the compose editor. */
export const plainToHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

export const isPgpMessage = (text: string | null | undefined) => !!text && PGP_MESSAGE.test(text);

/** The text inside a cleartext-signed message, to edit it again (a signed send that was undone). */
export function cleartextOf(text: string): string | null {
  const m = /-----BEGIN PGP SIGNED MESSAGE-----\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n-----BEGIN PGP SIGNATURE-----/.exec(text);
  return m ? m[1].replace(/^- /gm, '') : null;
}
