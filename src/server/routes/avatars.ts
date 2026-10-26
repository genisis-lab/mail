import { Hono } from 'hono';
import { rateLimit, type AppEnv } from '../http/context.js';
import { pictureFor } from '../services/avatars.js';
import { getPrefs } from '../services/users.js';
import { sha256 } from '../lib/crypto.js';

/** Pictures for the people in your mail; see services/avatars.ts. */
export const avatarRoutes = new Hono<AppEnv>();

avatarRoutes.get('/:address', async (c) => {
  c.header('Vary', 'Cookie, X-Wren-Account');
  const user = c.get('user');
  const found = await pictureFor(c.req.param('address'), {
    lookups: getPrefs(user.id).senderPictures,
    // New lookups make the server call out: plenty for real mail, not for trawling addresses.
    allowLookup: () => {
      try {
        rateLimit(`avatars:${user.id}`, 600, 3_600_000);
        return true;
      } catch {
        return false;
      }
    },
  });
  c.header('X-Content-Type-Options', 'nosniff');
  if (!found) {
    c.header('Cache-Control', 'private, max-age=60');
    return c.body(null, 404);
  }
  c.header('Content-Type', found.picture.type);
  // People here can change theirs; a looked-up picture was already checked within the week.
  c.header('Cache-Control', `private, max-age=${found.local ? 300 : 86_400}, must-revalidate`);
  const etag = `"${sha256(found.picture.data)}"`;
  c.header('ETag', etag);
  // A brand logo is an SVG from the sender's server: opened on its own it must not run anything.
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  return c.body(new Uint8Array(found.picture.data));
});
