import { all, openDb } from '../src/server/db/index';
import { invalidateSettings } from '../src/server/settings';
import { createApp } from '../src/server/app';
import { getBlob } from '../src/server/mail/blobs';
import { processQueue } from '../src/server/mail/outbound';
import { nodeSqlDriver } from './sqlite';
import { withDurableObjectLimits } from './do-limits';
import '../src/server/mail/ingest';

/** A fresh database and app, plus a tiny cookie-keeping client. */
export function harness() {
  openDb(withDurableObjectLimits(nodeSqlDriver(':memory:')));
  invalidateSettings();
  const app = createApp();
  const jars: Record<string, string> = {};
  let current = 'default';

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = jars[current];
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Wren': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set && set.includes('wren_sid=')) jars[current] = set.split(';')[0];
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    app,
    call,
    /** A raw request as the current identity, for downloads. */
    request(path: string, init: RequestInit = {}) {
      const cookie = jars[current];
      return app.request(path, { ...init, headers: { 'X-Wren': '1', ...(cookie ? { cookie } : {}), ...((init.headers as Record<string, string>) ?? {}) } });
    },
    /** Switch to another signed-in identity (separate cookie jar). */
    as(name: string) {
      current = name;
    },
    async setup(email = { provider: 'later' as const }) {
      return call('POST', '/api/setup', { instanceName: 'Fernhill', domain: 'wren.test', localPart: 'admin', name: 'Ada Admin', password: 'a very long password', email });
    },
    async login(address: string, password: string, jar = address) {
      current = jar;
      return call('POST', '/api/auth/login', { email: address, password });
    },
  };
}

/** Outbox jobs with their decoded raw message. */
export async function outbox(kind = 'notice') {
  const rows = all<{ id: number; recipients: string; raw_blob: string; subject: string; status: string }>('SELECT * FROM outbox WHERE kind = ? ORDER BY id', [kind]);
  return Promise.all(
    rows.map(async (r) => {
      const raw = (await getBlob(r.raw_blob)).toString('utf8');
      return { ...r, to: JSON.parse(r.recipients) as string[], raw, text: decodeQP(raw) };
    }),
  );
}

function decodeQP(raw: string) {
  return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** First link to `path` in a message, and its token. */
export function linkIn(text: string, path: string): { url: string; token: string } {
  const m = new RegExp(`https?://[^\\s"<>]*${path.replace('/', '\\/')}\\?[^\\s"<>]*?(?:token|invite)=([A-Za-z0-9_-]+)[^\\s"<>]*`).exec(text);
  if (!m) throw new Error(`No ${path} link in message`);
  return { url: m[0].replace(/&amp;/g, '&'), token: m[1] };
}

export { processQueue };
