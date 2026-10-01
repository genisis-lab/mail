import { Hono } from 'hono';
import { HttpError } from './lib/http.js';
import { logger } from './lib/log.js';
import { requireAdmin, requireApiKey, requireUser, requireUserReady, type AppEnv } from './http/context.js';
import { authRoutes, setupRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { attachmentRoutes, blockedRoutes, contactRoutes, filterRoutes, labelRoutes, mailRoutes } from './routes/mail.js';
import { apiV1Routes, composeRoutes } from './routes/compose.js';
import { adminRoutes, runtimeInfo } from './routes/admin.js';
import { inboundRoutes } from './routes/inbound.js';

const log = logger('http');

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Remote images in mail are gated client-side ("Show images").
  'img-src * data: blob:',
  "connect-src 'self'",
  "frame-src 'self' blob: data: about:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export function createApp() {
  runtimeInfo.startedAt = Date.now();
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as any);
    log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: 'Something went wrong on the server' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    if (!c.req.path.startsWith('/api/')) c.header('Content-Security-Policy', CSP);
  });

  // CSRF: cookie-authenticated mutating requests must carry our custom header,
  // which browsers can't send cross-site without a CORS preflight we never allow.
  app.use('/api/*', async (c, next) => {
    const m = c.req.method;
    const path = c.req.path;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !path.startsWith('/api/inbound/') && !path.startsWith('/api/v1/')) {
      if (c.req.header('x-wren') !== '1') return c.json({ error: 'Missing X-Wren header' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.route('/api/setup', setupRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/inbound', inboundRoutes as any);

  // Account routes stay reachable while 2FA setup is pending.
  app.use('/api/account/*', requireUser);
  app.route('/api/account', accountRoutes);

  for (const prefix of ['/api/mail', '/api/compose', '/api/attachments', '/api/labels', '/api/contacts', '/api/filters', '/api/blocked', '/api/admin']) {
    app.use(`${prefix}/*`, requireUserReady);
    app.use(prefix, requireUserReady);
  }
  app.use('/api/admin/*', requireAdmin);

  app.route('/api/mail', mailRoutes);
  app.route('/api/compose', composeRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/labels', labelRoutes);
  app.route('/api/contacts', contactRoutes);
  app.route('/api/filters', filterRoutes);
  app.route('/api/blocked', blockedRoutes);
  app.route('/api/admin', adminRoutes);

  app.use('/api/v1/*', requireApiKey);
  app.route('/api/v1', apiV1Routes);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // Everything outside /api/* is the single-page app, served by Workers static assets.
  return app;
}
