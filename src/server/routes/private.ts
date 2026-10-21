/** Private links (mail/private.ts), opened by whoever has the link: no sign-in. */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../http/context.js';
import { findLink, linkAttachment, linkContent } from '../mail/private.js';
import { attachmentResponse } from './mail.js';

export const privateRoutes = new Hono<AppEnv>();

privateRoutes.use('*', async (c, next) => {
  await next();
  // The token is in the address: never cache it, pass it on, or let search engines list it.
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
});

// Expired, withdrawn and unknown links get the same answer, so tokens can't be probed.
const gone = (c: Context<AppEnv>) => c.json({ error: 'This message has expired or was withdrawn', code: 'gone' }, 404);

privateRoutes.get('/:token', async (c) => {
  const link = findLink(c.req.param('token'));
  if (!link) return gone(c);
  return c.json({ from: { address: link.from_addr, name: link.from_name }, subject: link.subject, date: link.date, ...(await linkContent(link)) });
});

privateRoutes.get('/:token/attachments/:id', async (c) => {
  const link = findLink(c.req.param('token'));
  const a = link && linkAttachment(link, Number(c.req.param('id')));
  if (!a) return gone(c);
  return attachmentResponse(a, c.req.query('inline') === '1');
});
