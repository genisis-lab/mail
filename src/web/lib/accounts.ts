/**
 * Several accounts in one browser, like Gmail. The first one signed in lives at
 * /inbox, each one added after it at /u/<id>/inbox. A tab is one account for as
 * long as it's open (every request names it), so switching opens the other
 * account's address.
 */
import { useQuery } from '@tanstack/react-query';
import { api, getApiAccount } from './api';
import { forgetMailbox } from './mailbox';
import { clearOutbox, flushOutbox } from './outbox';
import { pushEndpoint, pushHere } from './pwa';

const prefix = /^\/u\/([1-9]\d{0,14})(?=\/|$)/.exec(window.location.pathname);
/** This tab's address prefix: '' for the first account, /u/<id> for the others. */
export const ACCOUNT_BASE = prefix ? prefix[0] : '';
/** The account this tab's address names, if it names one. */
export const URL_ACCOUNT = prefix ? Number(prefix[1]) : null;

export interface BrowserAccount {
  id: number;
  email: string;
  name: string;
  avatarAt: number | null;
  /** The first account: its pages have no /u/<id> prefix. */
  default: boolean;
  /** Notifications while a tab is open are on for it. */
  notify: boolean;
  /** Unread conversations in its inbox (Primary, with inbox tabs). */
  unread: number;
  /** Its newest inbox message, to notice new mail. */
  latestId: number;
}

interface AccountsResponse {
  accounts: BrowserAccount[];
  max: number;
}

/** Every account signed in on this browser, for the switcher. */
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountsResponse>('/api/auth/accounts'),
    staleTime: 20_000,
    // With several accounts, keep their unread counts current and notice their new mail, in background tabs too.
    refetchInterval: (q) => ((q.state.data?.accounts.length ?? 0) > 1 ? 30_000 : false),
    refetchIntervalInBackground: true,
  });
}

/** Where an account signed in here lives in the app. */
export function accountHref(account: Pick<BrowserAccount, 'id' | 'default'>, path = '/inbox'): string {
  return `${account.default ? '' : `/u/${account.id}`}${path}`;
}

/** Open another account signed in here. */
export function openAccount(account: Pick<BrowserAccount, 'id' | 'default'>, path = '/inbox') {
  window.location.assign(accountHref(account, path));
}

/** Where to go once signed in: back where the person was, unless that was a sign-in page. */
export function landingPath(next: string | null | undefined): string {
  return !next || /^\/(login|add-account|register|forgot|reset)(\/|$)/.test(next) ? '/inbox' : next;
}

/**
 * Just signed in to an account. A tab that already belonged to one (or names
 * one in its address) opens the new account at its own address; on a fresh
 * tab this returns false and the app simply carries on as that account.
 */
export async function openSignedIn(userId: number, next = '/inbox'): Promise<boolean> {
  await pushHere(userId);
  if (!ACCOUNT_BASE && getApiAccount() === null) return false;
  const list = await api.get<AccountsResponse>('/api/auth/accounts').catch(() => null);
  const account = list?.accounts.find((a) => a.id === userId) ?? { id: userId, default: false };
  openAccount(account, landingPath(next));
  return true;
}

/**
 * Sign out of this tab's account, or of every account on this browser. This
 * device stops getting their notifications, and the accounts still signed in
 * here carry on (the first of them at /inbox).
 */
export async function signOut(everyone = false): Promise<void> {
  const self = getApiAccount();
  const ids = everyone ? ((await api.get<AccountsResponse>('/api/auth/accounts').catch(() => null))?.accounts.map((a) => a.id) ?? []) : self ? [self] : [];
  // Send anything still waiting from offline; what's left goes with the session.
  for (const id of ids) await flushOutbox(id, () => {}).catch(() => {});
  const endpoint = await pushEndpoint();
  const r = await api.post<{ remaining: number }>(`/api/auth/logout${everyone ? '?all=1' : ''}`, endpoint ? { endpoint } : {});
  const who = everyone || !self ? undefined : self;
  clearOutbox(who);
  forgetMailbox(who);
  window.location.assign(r.remaining ? '/inbox' : '/login');
}
