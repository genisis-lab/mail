/**
 * Runtime configuration. Populated by the entry point via initConfig() from
 * process.env (Node) or the Worker's env bindings (Cloudflare).
 */

type Vars = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function bool(v: unknown, def: boolean): boolean {
  const s = str(v);
  if (s === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(s.toLowerCase());
}

function int(v: unknown, def: number): number {
  const n = Number.parseInt(str(v) ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  platform: 'node' as 'node' | 'workers',
  isProd: false,
  port: 3000,
  host: '0.0.0.0',
  dataDir: './data',
  dbPath: './data/wren.db',
  blobDir: './data/blobs',
  secret: '',
  publicUrl: 'http://localhost:3000',
  trustProxy: false,
  webDir: './dist/web',
  smtp: {
    enabled: false,
    port: 2525,
    host: '0.0.0.0',
    hostname: '',
    tlsKey: '',
    tlsCert: '',
    maxSizeMb: 50,
    submissionPort: 0,
  },
  workers: {
    queueIntervalMs: 1000,
  },
};

export type Config = typeof config;

export function initConfig(vars: Vars, opts: { platform: 'node' | 'workers'; resolvePath?: (p: string) => string; secret?: string }) {
  const resolve = opts.resolvePath ?? ((p: string) => p);
  const port = int(vars.PORT, 3000);
  const dataDir = resolve(str(vars.DATA_DIR) ?? './data');
  config.platform = opts.platform;
  config.isProd = str(vars.NODE_ENV) === 'production' || opts.platform === 'workers';
  config.port = port;
  config.host = str(vars.HOST) ?? '0.0.0.0';
  config.dataDir = dataDir;
  config.dbPath = `${dataDir}/wren.db`;
  config.blobDir = `${dataDir}/blobs`;
  config.secret = opts.secret ?? str(vars.WREN_SECRET) ?? '';
  config.publicUrl = (str(vars.PUBLIC_URL) ?? `http://localhost:${port}`).replace(/\/+$/, '');
  // Cloudflare always sits in front of a Worker, so its client IP header is trustworthy.
  config.trustProxy = opts.platform === 'workers' || bool(vars.TRUST_PROXY, false);
  config.webDir = resolve(str(vars.WEB_DIR) ?? './dist/web');
  config.smtp = {
    enabled: opts.platform === 'node' && bool(vars.SMTP_ENABLED, true),
    port: int(vars.SMTP_PORT, 2525),
    host: str(vars.SMTP_HOST) ?? '0.0.0.0',
    hostname: str(vars.SMTP_HOSTNAME) ?? '',
    tlsKey: str(vars.SMTP_TLS_KEY) ?? '',
    tlsCert: str(vars.SMTP_TLS_CERT) ?? '',
    maxSizeMb: int(vars.SMTP_MAX_SIZE_MB, 50),
    submissionPort: opts.platform === 'node' ? int(vars.SUBMISSION_PORT, 0) : 0,
  };
  config.workers = { queueIntervalMs: int(vars.QUEUE_INTERVAL_MS, 1000) };
  if (!config.secret || config.secret.length < 16) throw new Error('WREN_SECRET must be set (at least 16 characters)');
}
