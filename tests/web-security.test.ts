import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('offline shell', () => {
  it('keeps the page security policy when caching a navigation', async () => {
    let saved: Response | undefined;
    const cache = {
      put: async (_key: string, response: Response) => { saved = response; },
      keys: async () => [],
    };
    const context = vm.createContext({
      self: { addEventListener: () => {} },
      caches: { open: async () => cache },
    });
    vm.runInContext(readFileSync(new URL('../src/web/public/sw.js', import.meta.url), 'utf8'), context);
    const keepShell = vm.runInContext('keepShell', context) as (response: Response) => Promise<void>;
    const policy = "default-src 'self'; script-src 'self'";
    await keepShell(new Response('<html><body>Wren</body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy },
    }));
    expect(saved?.headers.get('Content-Security-Policy')).toBe(policy);
  });
});

describe('offline mail', () => {
  /** The service worker with an in-memory Cache API, and a network that answers `online` or fails. */
  function worker() {
    const stores = new Map<string, Map<string, Response>>();
    const keyOf = (k: string | { url: string }) => {
      const u = new URL(typeof k === 'string' ? k : k.url, 'https://mail.example');
      return u.pathname + u.search;
    };
    const open = async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        put: async (k: string, r: Response) => void m.set(keyOf(k), r),
        match: async (k: string) => m.get(keyOf(k))?.clone(),
        delete: async (k: string) => m.delete(keyOf(k)),
        keys: async () => [...m.keys()].map((k) => ({ url: `https://mail.example${k}` })),
      };
    };
    const handlers: Record<string, (e: any) => void> = {};
    let online = true;
    let answer: unknown = {};
    const context = vm.createContext({
      self: { addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn), location: { origin: 'https://mail.example' } },
      caches: { open, keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
      fetch: async () => {
        if (!online) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
      },
      URL,
      Response,
    });
    vm.runInContext(readFileSync(new URL('../src/web/public/sw.js', import.meta.url), 'utf8'), context);
    /** A request from a tab, as the app makes it. */
    const request = async (path: string, account?: number, method = 'GET') => {
      let response: Promise<Response> | undefined;
      let waited: Promise<unknown> = Promise.resolve();
      const req = { url: `https://mail.example${path}`, method, mode: 'cors', headers: new Headers(account ? { 'X-Wren-Account': String(account) } : {}) };
      handlers.fetch({ request: req, respondWith: (r: Promise<Response>) => (response = r), waitUntil: (p: Promise<unknown>) => (waited = p) });
      const res = response ? await response : undefined;
      await waited;
      return res ? await res.json() : undefined;
    };
    return {
      stores,
      request,
      set: (o: { online?: boolean; answer?: unknown }) => {
        if (o.online !== undefined) online = o.online;
        if (o.answer !== undefined) answer = o.answer;
      },
    };
  }

  it('keeps a copy per account, and signing out of one forgets only its copy', async () => {
    const w = worker();
    // A tab opened at /inbox asks without an account first: it's the first account (7).
    w.set({ answer: { user: { id: 7 }, accounts: 2 } });
    await w.request('/api/auth/me');
    w.set({ answer: { threads: ['seven'] } });
    await w.request('/api/mail/threads?view=inbox', 7);
    w.set({ answer: { user: { id: 9 }, accounts: 2 } });
    await w.request('/api/auth/me', 9);
    w.set({ answer: { threads: ['nine'] } });
    await w.request('/api/mail/threads?view=inbox&account=9', 9);
    expect([...w.stores.keys()].sort()).toEqual(['wren-mail-v2:7', 'wren-mail-v2:9', 'wren-mail-v2:default']);

    w.set({ online: false });
    expect(await w.request('/api/mail/threads?view=inbox', 9)).toEqual({ threads: ['nine'] });
    expect(await w.request('/api/mail/threads?view=inbox', 7)).toEqual({ threads: ['seven'] });
    expect(await w.request('/api/auth/me')).toEqual({ user: { id: 7 }, accounts: 2 });
    expect((await w.request('/api/mail/threads?view=inbox', 12)).code).toBe('offline');

    w.set({ online: true });
    await w.request('/api/auth/logout', 9, 'POST');
    expect(w.stores.has('wren-mail-v2:9')).toBe(false);
    expect(w.stores.has('wren-mail-v2:7')).toBe(true);
    // An account signed out on another device drops off the list: its copy goes too.
    w.set({ answer: { accounts: [] } });
    await w.request('/api/auth/accounts');
    expect([...w.stores.keys()]).toEqual([]);
  });
});
