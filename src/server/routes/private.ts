/**
 * Private links (mail/private.ts), opened by whoever has the link: no sign-in.
 * The content only goes to a browser holding a pass, which it gets by entering
 * the code emailed to one of the message's recipients.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { config } from '../config.js';
import { body, clientIp, rateLimit, type AppEnv } from '../http/context.js';
import { badRequest } from '../lib/http.js';
import { normalizeEmail } from '../lib/addr.js';
import { findLink, hasPass, linkAttachment, linkContent, sendLinkCode, verifyLinkCode } from '../mail/private.js';
import { attachmentResponse } from './mail.js';

export const privateRoutes = new Hono<AppEnv>();

/** Holds a browser's pass to one link; its path is that link's, so it goes nowhere else. */
const PASS_COOKIE = 'wren_private';

privateRoutes.use('*', async (c, next) => {
  await next();
  // The token is in the address: never cache it, pass it on, or let search engines list it.
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
});

// Expired, withdrawn and unknown links get the same answer, so tokens can't be probed.
const gone = (c: Context<AppEnv>) => c.json({ error: 'This message has expired or was withdrawn', code: 'gone' }, 404);

/** The link, and whether this browser has entered a code for it. */
function open(c: Context<AppEnv>) {
  const link = findLink(c.req.param('token') ?? '');
  return { link, unlocked: !!link && hasPass(link, getCookie(c, PASS_COOKIE)) };
}

privateRoutes.get('/:token', async (c) => {
  const { link, unlocked } = open(c);
  if (!link) return gone(c);
  // Only who it's from (the emailed notice says as much) until a code is entered.
  if (!unlocked) return c.json({ locked: true, from: { address: link.from_addr, name: link.from_name } });
  return c.json({ from: { address: link.from_addr, name: link.from_name }, subject: link.subject, date: link.date, ...(await linkContent(link)) });
});

privateRoutes.get('/:token/attachments/:id', async (c) => {
  const { link, unlocked } = open(c);
  const a = link && unlocked && linkAttachment(link, Number(c.req.param('id')));
  if (!a) return gone(c);
  return attachmentResponse(a, c.req.query('inline') === '1');
});

const email = z.string().trim().min(3).max(254);

/** Email a code to one of the recipients. The same answer whether or not the address got the message. */
privateRoutes.post('/:token/code', async (c) => {
  const input = await body(c, z.object({ email }));
  rateLimit(`private-code:ip:${clientIp(c)}`, 20, 60 * 60_000);
  const { link } = open(c);
  if (!link) return gone(c);
  rateLimit(`private-code:link:${link.id}`, 30, 60 * 60_000);
  rateLimit(`private-code:${link.id}:${normalizeEmail(input.email)}`, 3, 15 * 60_000);
  await sendLinkCode(link, input.email);
  return c.json({ ok: true });
});

privateRoutes.post('/:token/verify', async (c) => {
  const input = await body(c, z.object({ email, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }));
  rateLimit(`private-verify:ip:${clientIp(c)}`, 30, 15 * 60_000);
  const token = c.req.param('token');
  const link = findLink(token);
  if (!link) return gone(c);
  const granted = verifyLinkCode(link, input.email, input.code);
  if (!granted) throw badRequest('That code is wrong or has expired. Ask for a new one.', 'bad_code');
  setCookie(c, PASS_COOKIE, granted.pass, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'Strict',
    path: `/api/private/${token}`,
    expires: new Date(granted.expiresAt),
  });
  return c.json({ ok: true });
});
