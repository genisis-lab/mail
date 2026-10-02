/** Browser side of passkeys: turn the server's options into WebAuthn calls and the results back into JSON. */
import { api } from './api';

const toBuf = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

/** A friendly default name for a passkey made on this device. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  return 'Passkey';
}

/** Turn the browser's errors into something a person can act on. */
function explain(err: unknown): Error {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') return new Error('The passkey request was cancelled or timed out.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for your account.');
  if (name === 'SecurityError') return new Error('Passkeys only work on the address Wren is set up for (its PUBLIC_URL), over HTTPS.');
  return err instanceof Error ? err : new Error(String(err));
}

interface CreateOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: { type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }[];
}

/** Add a passkey to the signed-in account. */
export async function addPasskey(password: string, name: string): Promise<void> {
  const o = await api.post<CreateOptions>('/api/account/passkeys/options', { password });
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: toBuf(o.challenge),
        user: { ...o.user, id: toBuf(o.user.id) },
        excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })),
      },
    })) as PublicKeyCredential;
  } catch (err) {
    throw explain(err);
  }
  const r = cred.response as AuthenticatorAttestationResponse;
  await api.post('/api/account/passkeys', {
    name,
    response: { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject) },
    transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
  });
}

/** Sign in with a passkey. Returns whether the 2-step code is still needed. */
export async function signInWithPasskey(email?: string): Promise<{ mfaRequired?: boolean }> {
  const o = await api.post<{ challenge: string; rpId: string; timeout: number; userVerification: UserVerificationRequirement; allowCredentials: { type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }[] }>(
    '/api/auth/passkey/options',
    email ? { email } : {},
  );
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: toBuf(c.id) })) },
    })) as PublicKeyCredential;
  } catch (err) {
    throw explain(err);
  }
  const r = cred.response as AuthenticatorAssertionResponse;
  return api.post('/api/auth/passkey', {
    id: cred.id,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: r.userHandle ? toB64(r.userHandle) : null,
    },
  });
}
