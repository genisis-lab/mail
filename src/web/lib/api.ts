export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

/** Requests under these paths act on the shared mailbox being viewed, if any. */
const MAILBOX_SCOPED = /^\/api\/(mail|compose|attachments|labels)(\/|\?|$)/;
let currentMailbox: number | null = null;
/**
 * The account this tab acts as. One browser can be signed in to several, so
 * every request names its account and never lands on another one.
 */
let currentAccount: number | null = null;

/** Point mail requests at a shared mailbox (null: the person's own). */
export function setApiMailbox(id: number | null) {
  currentMailbox = id;
}

export function getApiMailbox(): number | null {
  return currentMailbox;
}

/** Pin this tab's requests to one of the accounts signed in on this browser. */
export function setApiAccount(id: number | null) {
  currentAccount = id;
}

export function getApiAccount(): number | null {
  return currentAccount;
}

/** A link the browser opens itself (downloads, raw source, pictures): carry the account and mailbox in the query string. */
export function linkUrl(url: string, mailbox = currentMailbox): string {
  const params: string[] = [];
  if (currentAccount && url.startsWith('/api/')) params.push(`account=${currentAccount}`);
  if (mailbox && MAILBOX_SCOPED.test(url)) params.push(`mailbox=${mailbox}`);
  return params.length ? `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}` : url;
}

async function request<T>(method: string, url: string, data?: Json | FormData, mailbox = currentMailbox, account = currentAccount): Promise<T> {
  const headers: Record<string, string> = { 'X-Wren': '1' };
  if (account) headers['X-Wren-Account'] = String(account);
  if (mailbox && MAILBOX_SCOPED.test(url)) headers['X-Wren-Mailbox'] = String(mailbox);
  let body: BodyInit | undefined;
  if (data instanceof FormData) body = data;
  else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }
  const res = await fetch(url, { method, headers, body, credentials: 'same-origin' });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const err = new ApiError(parsed?.error || `Request failed (${res.status})`, res.status, parsed?.code);
    // This tab's account was signed out (a request for another account here says nothing about this one).
    if (res.status === 401 && account === currentAccount && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('wren:unauthorized'));
    // Something must happen before anything else (2-step setup, a new password): reload the session to show it.
    if (account === currentAccount && (parsed?.code === 'mfa_setup_required' || parsed?.code === 'password_change_required')) window.dispatchEvent(new CustomEvent('wren:mfa-required'));
    throw err;
  }
  return parsed as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, data?: Json | FormData) => request<T>('POST', url, data ?? {}),
  put: <T = any>(url: string, data?: Json) => request<T>('PUT', url, data ?? {}),
  del: <T = any>(url: string, data?: Json) => request<T>('DELETE', url, data),
};

export type Api = typeof api;

/**
 * The same client, pinned to one mailbox (a compose window keeps the mailbox it
 * was opened in), and optionally to another account signed in on this browser.
 */
export function apiFor(mailbox: number | null, account = currentAccount): Api {
  return {
    get: <T = any>(url: string) => request<T>('GET', url, undefined, mailbox, account),
    post: <T = any>(url: string, data?: Json | FormData) => request<T>('POST', url, data ?? {}, mailbox, account),
    put: <T = any>(url: string, data?: Json) => request<T>('PUT', url, data ?? {}, mailbox, account),
    del: <T = any>(url: string, data?: Json) => request<T>('DELETE', url, data, mailbox, account),
  };
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
