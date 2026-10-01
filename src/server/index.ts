// Node.js / Docker entry point.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { APP_NAME, APP_VERSION } from '../shared/brand.js';
import { config, initConfig } from './config.js';
import { openDb, closeDb } from './db/index.js';
import { verifyEncryptionKey } from './services/backup.js';
import { nodeSqlDriver } from './db/node.js';
import { setPlatform } from './platform.js';
import { nodePlatform } from './node-platform.js';
import { logger } from './lib/log.js';
import { createApp } from './app.js';
import { startNodeJobs, stopJobs } from './jobs.js';
import { startMxServer, startSubmissionServer } from './smtp/server.js';
import './mail/ingest.js';

const log = logger('wren');

/** WREN_SECRET from the environment, or generated once and kept in DATA_DIR. */
function loadSecret(dataDir: string): string {
  if (process.env.WREN_SECRET && process.env.WREN_SECRET.length >= 16) return process.env.WREN_SECRET;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  log.warn(`WREN_SECRET not set; generated one at ${file}. Back it up — it encrypts provider credentials.`);
  return secret;
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');
initConfig(process.env, { platform: 'node', resolvePath: (p) => path.resolve(p), secret: loadSecret(dataDir) });
const driver = nodeSqlDriver(config.dbPath);
setPlatform(nodePlatform(driver.db));
openDb(driver);
config.keyMismatch = !verifyEncryptionKey();

const app = createApp({
  mountStatic(app) {
    const indexFile = path.join(config.webDir, 'index.html');
    if (!fs.existsSync(indexFile)) {
      app.get('/', (c) => c.text('Wren API is running. Build the web app with `npm run build:web` (or use `npm run dev`).'));
      return;
    }
    const root = path.relative(process.cwd(), config.webDir) || '.';
    app.use(
      '/assets/*',
      async (c, next) => {
        await next();
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
      serveStatic({ root }),
    );
    app.use('*', serveStatic({ root }));
    const html = fs.readFileSync(indexFile, 'utf8');
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    });
  },
});

const http = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(`${APP_NAME} ${APP_VERSION} listening on http://${config.host}:${info.port} (public URL ${config.publicUrl})`);
});
const mx = startMxServer();
const submission = startSubmissionServer();
startNodeJobs(config.workers.queueIntervalMs);

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`Received ${signal}, shutting down…`);
  stopJobs();
  mx?.close();
  submission?.close();
  http.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
