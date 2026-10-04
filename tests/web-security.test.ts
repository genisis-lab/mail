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
