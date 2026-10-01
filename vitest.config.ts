import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    pool: 'forks',
    env: {
      DATA_DIR: path.join(os.tmpdir(), `wren-test-${process.pid}-${Date.now()}`),
      WREN_SECRET: 'test-secret-0123456789abcdef',
      WREN_SILENT: '1',
      SMTP_ENABLED: 'false',
    },
  },
});
