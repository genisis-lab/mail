/**
 * App passwords: how mail apps sign in (an API key with the "mail" scope), as HTTP Basic (the
 * username is any of the person's addresses) or as a Bearer token. Shared by JMAP and by the admin
 * panel's native-app path, which also needs an unlock on top (services/admin-unlock.ts).
 */
import { getSettings } from '../settings.js';
import { mustChangePassword, mustSetup2fa, userAddresses, type UserRow } from '../services/users.js';
import { findApiKey } from './context.js';

function decodeBasic(value: string): { username: string; password: string } | null {
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0)));
    const i = text.indexOf(':');
    return i < 0 ? null : { username: text.slice(0, i).trim().toLowerCase(), password: text.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Who is calling, from "Authorization: Basic …" or "Authorization: Bearer …" with an app password. */
export function authenticateAppPassword(header: string | undefined): { user: UserRow; keyId: number } | null {
  if (!header) return null;
  const [scheme, value = ''] = header.trim().split(/\s+/, 2);
  if (/^bearer$/i.test(scheme)) return value ? findApiKey(value, 'mail') : null;
  if (!/^basic$/i.test(scheme)) return null;
  const creds = decodeBasic(value);
  if (!creds?.password) return null;
  const found = findApiKey(creds.password, 'mail');
  if (!found) return null;
  // The username is the person's sign-in address or any of their own addresses.
  const names = new Set([found.user.email.toLowerCase(), ...userAddresses(found.user.id)]);
  return names.has(creds.username) ? found : null;
}

/** Why this person's mail apps are refused right now (null: they aren't). */
export function appPasswordRefusal(user: UserRow): string | null {
  if (!getSettings()['jmap.enabled'] || user.kind !== 'person') return 'Mail apps aren’t turned on for this account';
  if (user.mail_apps_blocked) return 'An administrator turned off mail apps for this account';
  if (mustChangePassword(user)) return 'Sign in to Wren on the web and choose a new password first';
  if (mustSetup2fa(user)) return 'Sign in to Wren on the web and set up two-step sign-in first';
  return null;
}
