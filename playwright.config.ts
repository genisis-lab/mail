import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:8791';

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
  },
  webServer: {
    command: 'sh scripts/serve-browser-test.sh',
    url: baseURL + '/api/health',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
