#!/usr/bin/env node
/**
 * Self-hosted mode (optional): run the same Wren Worker on your own machine or
 * in Docker, using workerd (Cloudflare's open-source Workers runtime) through
 * Wrangler's local mode. Data (SQLite Durable Object + message files) is kept
 * in DATA_DIR.
 *
 *   npm run serve                      # http://localhost:8787
 *   PORT=80 DATA_DIR=/srv/wren npm run serve
 *
 * Environment: PORT (8787), HOST (0.0.0.0), DATA_DIR (./data), PUBLIC_URL,
 * WREN_SECRET (optional), TRUST_PROXY=1 behind a reverse proxy.
 *
 * Cloudflare-network features (Email Routing, Email Service binding,
 * point-in-time recovery) need a real Cloudflare deployment; self-hosted Wren
 * sends and receives through providers such as Resend instead.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const INTERNAL = Number(process.env.INTERNAL_PORT || PORT + 1);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const SCHEDULE_MS = 5 * 60_000;

fs.mkdirSync(DATA_DIR, { recursive: true });

const vars = ['WREN_SELF_HOSTED:1'];
if (process.env.PUBLIC_URL) vars.push(`PUBLIC_URL:${process.env.PUBLIC_URL}`);
if (process.env.WREN_SECRET) vars.push(`WREN_SECRET:${process.env.WREN_SECRET}`);

const wrangler = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'wrangler',
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(INTERNAL),
    '--persist-to',
    DATA_DIR,
    '--show-interactive-dev-session=false',
    ...vars.flatMap((v) => ['--var', v]),
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);

// Pass through Wrangler's output, minus noise about Cloudflare-only dev features.
const quiet = /Request\.cf|Request was cancelled|makeAppropriateNetworkError|undici|node:internal|Scheduled Workers are not automatically|Proxy environment variables|^\s+at /;
for (const stream of [wrangler.stdout, wrangler.stderr]) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) if (line.trim() && !quiet.test(line)) console.log(line.replace(new RegExp(`127\\.0\\.0\\.1:${INTERNAL}`, 'g'), `${HOST}:${PORT}`));
  });
}
wrangler.on('exit', (code) => {
  console.error(`workerd exited (${code}).`);
  process.exit(code ?? 1);
});

const clientIp = (req) => {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
};

const server = http.createServer((req, res) => {
  // Wrangler's /cdn-cgi/* endpoints let anyone inject mail or trigger handlers. Never expose them.
  if (req.url?.startsWith('/cdn-cgi/')) {
    res.writeHead(404).end();
    return;
  }
  const headers = { ...req.headers, 'cf-connecting-ip': clientIp(req) };
  delete headers['x-forwarded-for'];
  const upstream = http.request({ host: '127.0.0.1', port: INTERNAL, method: req.method, path: req.url, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Wren is starting up. Try again in a few seconds.');
  });
  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`Wren (self-hosted) on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}, data in ${DATA_DIR}`);
});

// Wrangler doesn't run cron triggers locally; tick the safety-net schedule ourselves.
setInterval(() => {
  http.get({ host: '127.0.0.1', port: INTERNAL, path: '/cdn-cgi/handler/scheduled' }, (r) => r.resume()).on('error', () => {});
}, SCHEDULE_MS).unref();

const stop = () => {
  server.close();
  wrangler.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
