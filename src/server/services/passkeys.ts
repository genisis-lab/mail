/**
 * Passkeys: register them from Settings → Security, sign in with them
 * instead of a password. A passkey that verified the user (PIN, Face ID,
 * fingerprint) counts as two factors, so 2-step verification isn't asked
 * for again.
 */
import { config } from '../config.js';
import { all, get, insert, now, run } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { ES256, newChallenge, RS256, verifyAssertion, verifyRegistration, WebAuthnError, type AssertionResponse, type RegistrationResponse } from '../lib/webauthn.js';
import { getSettings } from '../settings.js';
import { getUser, getUserByEmail, type UserRow } from './users.js';

const CHALLENGE_MS = 5 * 60_000;
const MAX_PER_USER = 20;

export interface PasskeyRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  name: string;
  transports: string;
  created_at: number;
  last_used_at: number | null;
}

/** The relying party: this server's public origin. */
export function relyingParty() {
  const url = new URL(config.publicUrl);
  return { id: url.hostname, origin: url.origin, name: getSettings()['instance.name'] || 'Wren' };
}

/** An opaque, stable id for the user (no email or database id in it). */
const userHandle = (userId: number) => Buffer.from(sha256(`${config.secret}:passkey-user:${userId}`).slice(0, 32), 'hex').toString('base64url');

function saveChallenge(purpose: 'register' | 'login', userId: number | null): string {
  run('DELETE FROM webauthn_challenges WHERE expires_at < ?', [now()]);
  const challenge = newChallenge();
  run('INSERT INTO webauthn_challenges (challenge, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', [challenge, userId, purpose, now() + CHALLENGE_MS]);
  return challenge;
}

/** Use up a challenge the client echoed back (each one works once). */
function takeChallenge(clientDataJSON: string, purpose: 'register' | 'login', userId: number | null): string {
  let challenge = '';
  try {
    challenge = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')).challenge ?? '';
  } catch {
    throw new WebAuthnError('Client data is not JSON');
  }
  const row = get<{ user_id: number | null; expires_at: number }>('SELECT user_id, expires_at FROM webauthn_challenges WHERE challenge = ? AND purpose = ?', [challenge, purpose]);
  run('DELETE FROM webauthn_challenges WHERE challenge = ?', [challenge]);
  if (!row || row.expires_at < now() || (userId !== null && row.user_id !== userId)) throw new WebAuthnError('This passkey request expired. Try again.');
  return challenge;
}

export function listPasskeys(userId: number) {
  return all<PasskeyRow>('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', [userId]).map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    transports: JSON.parse(p.transports) as string[],
  }));
}

export function hasPasskey(userId: number): boolean {
  return !!get('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1', [userId]);
}

export function registrationOptions(user: UserRow) {
  const rp = relyingParty();
  const existing = all<{ credential_id: string; transports: string }>('SELECT credential_id, transports FROM passkeys WHERE user_id = ?', [user.id]);
  if (existing.length >= MAX_PER_USER) throw new WebAuthnError(`You can have up to ${MAX_PER_USER} passkeys. Remove one first.`);
  return {
    challenge: saveChallenge('register', user.id),
    rp: { id: rp.id, name: rp.name },
    user: { id: userHandle(user.id), name: user.email, displayName: user.name || user.email },
    pubKeyCredParams: [
      { type: 'public-key', alg: ES256 },
      { type: 'public-key', alg: RS256 },
    ],
    timeout: CHALLENGE_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
    excludeCredentials: existing.map((e) => ({ type: 'public-key', id: e.credential_id, transports: JSON.parse(e.transports) })),
  };
}

export function finishRegistration(user: UserRow, input: { name: string; response: RegistrationResponse; transports?: string[] }) {
  const rp = relyingParty();
  const challenge = takeChallenge(input.response.clientDataJSON, 'register', user.id);
  const cred = verifyRegistration(input.response, { challenge, origin: rp.origin, rpId: rp.id });
  if (get('SELECT 1 FROM passkeys WHERE credential_id = ?', [cred.credentialId])) throw new WebAuthnError('This passkey is already registered');
  const transports = (input.transports ?? []).filter((t) => /^[a-z-]{2,20}$/.test(t)).slice(0, 8);
  const id = insert(
    'INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, sign_count, name, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, cred.credentialId, cred.publicKey, cred.algorithm, cred.signCount, input.name.trim().slice(0, 60) || 'Passkey', JSON.stringify(transports), now()],
  );
  return { id };
}

/** Sign-in options. With an email, the user's passkeys are listed (for keys that can't be discovered). */
export function loginOptions(email?: string) {
  const rp = relyingParty();
  const user = email ? getUserByEmail(email) : undefined;
  const allow = user ? all<{ credential_id: string; transports: string }>('SELECT credential_id, transports FROM passkeys WHERE user_id = ?', [user.id]) : [];
  return {
    challenge: saveChallenge('login', null),
    rpId: rp.id,
    timeout: CHALLENGE_MS,
    userVerification: 'preferred',
    allowCredentials: allow.map((a) => ({ type: 'public-key', id: a.credential_id, transports: JSON.parse(a.transports) })),
  };
}

/** Check a passkey sign-in; returns the user and whether the passkey verified them. */
export async function finishLogin(input: { id: string; response: AssertionResponse }): Promise<{ user: UserRow; userVerified: boolean; passkeyName: string }> {
  const rp = relyingParty();
  const challenge = takeChallenge(input.response.clientDataJSON, 'login', null);
  const pk = get<PasskeyRow>('SELECT * FROM passkeys WHERE credential_id = ?', [input.id]);
  if (!pk) throw new WebAuthnError('This passkey isn’t registered here. Sign in with your password and add it in Settings → Security.');
  const result = await verifyAssertion(input.response, { publicKey: pk.public_key, algorithm: pk.algorithm, signCount: pk.sign_count }, { challenge, origin: rp.origin, rpId: rp.id });
  run('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?', [result.signCount, now(), pk.id]);
  const user = getUser(pk.user_id);
  if (!user) throw new WebAuthnError('This passkey’s account no longer exists');
  return { user, userVerified: result.userVerified, passkeyName: pk.name };
}
