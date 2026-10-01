import { defineConfig } from 'vitest/config';

// The app runs on Cloudflare Workers; tests run its code in Node with an
// in-process platform (tests/test-platform.ts) and Node's built-in SQLite
// standing in for Durable Object SQLite, with the Durable Object limits enforced.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    pool: 'forks',
    // node:sqlite prints an "experimental" warning on load.
    execArgv: ['--no-warnings=ExperimentalWarning'],
    env: { WREN_SILENT: '1' },
  },
});
