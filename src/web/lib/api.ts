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

/** Point mail requests at a shared mailbox (null: the person's own). */
export function setApiMailbox(id: number | null) {
  currentMailbox = id;
}

export function getApiMailbox(): number | null {
  return currentMailbox;
}

/** A link the browser opens itself (raw source, downloads): carry the mailbox in the query string. */
export function mailboxUrl(url: string, mailbox = currentMailbox): string {
  if (!mailbox || !MAILBOX_SCOPED.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}mailbox=${mailbox}`;
}

async function request<T>(method: string, url: string, data?: Json | FormData, mailbox = currentMailbox): Promise<T> {
  const headers: Record<string, string> = { 'X-Wren': '1' };
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
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('wren:unauthorized'));
    if (parsed?.code === 'mfa_setup_required') window.dispatchEvent(new CustomEvent('wren:mfa-required'));
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

/** The same client, pinned to one mailbox (a compose window keeps the mailbox it was opened in). */
export function apiFor(mailbox: number | null): Api {
  return {
    get: <T = any>(url: string) => request<T>('GET', url, undefined, mailbox),
    post: <T = any>(url: string, data?: Json | FormData) => request<T>('POST', url, data ?? {}, mailbox),
    put: <T = any>(url: string, data?: Json) => request<T>('PUT', url, data ?? {}, mailbox),
    del: <T = any>(url: string, data?: Json) => request<T>('DELETE', url, data, mailbox),
  };
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
