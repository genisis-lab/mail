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

async function request<T>(method: string, url: string, data?: Json | FormData): Promise<T> {
  const headers: Record<string, string> = { 'X-Wren': '1' };
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
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
