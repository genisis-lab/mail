/**
 * JMAP over HTTP (RFC 8620): the session resource, the API endpoint, blob
 * upload and download, and the EventSource push stream.
 *
 * Mail apps sign in with an app password (an API key with the "mail" scope),
 * as HTTP Basic (the username is any of the person's addresses) or as a
 * Bearer token. The account password is never accepted here: it can't be
 * limited to mail or revoked on its own, and it would sidestep two-step
 * sign-in.
 */
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { get, now, run } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { z } from 'zod';
import { body, clientIp } from '../http/context.js';
import { authenticateAppPassword } from '../http/app-password.js';
import { getSettings } from '../settings.js';
import { mustChangePassword, mustSetup2fa, type UserRow } from '../services/users.js';
import { adminRole, askWeb, finishUnlock, lockAdmin, sendEmailCode, startUnlock } from '../services/admin-unlock.js';
import { readBlob, storeUploadBlob } from './blobs.js';
import { problem } from './errors.js';
import { accountId } from './ids.js';
import { eventSource } from './push.js';
import { accountFor, CAP, LIMITS, processRequest, sharedAccounts } from './request.js';
import { MAX_DELAYED_SEND } from './submission.js';
// The method handlers register themselves.
import './mailbox.js';
import './email.js';
import './submission.js';
import './extras.js';
import './contacts.js';
import './wren.js';

type JmapEnv = { Variables: { user: UserRow; keyId: number } };

const FAILURES_ALLOWED = 20;
const FAILURE_WINDOW_MS = 15 * 60_000;

/** Sign-in failures by IP, in the same table as the login form's limits. */
function failureCount(ip: string): number {
  const row = get<{ count: number; reset_at: number }>('SELECT count, reset_at FROM login_attempts WHERE key = ?', [`jmap:${ip}`]);
  return row && row.reset_at > now() ? row.count : 0;
}

function noteFailure(ip: string) {
  const ts = now();
  run(
    `INSERT INTO login_attempts (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END`,
    [`jmap:${ip}`, ts + FAILURE_WINDOW_MS, ts, ts],
  );
}

function unauthorized() {
  const res = problem('about:blank', 'Sign in with your email address and an app password from Wren’s Settings', 401);
  res.headers.set('WWW-Authenticate', 'Basic realm="Wren", charset="UTF-8"');
  return res;
}

/** Requests in flight per person (maxConcurrentRequests and maxConcurrentUpload). */
const inFlight = new Map<string, number>();

async function limited(key: string, max: number, limit: string, fn: () => Promise<Response>): Promise<Response> {
  const n = inFlight.get(key) ?? 0;
  if (n >= max) return problem('limit', 'Too many requests at once', 400, { limit });
  inFlight.set(key, n + 1);
  try {
    return await fn();
  } finally {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  }
}

const maxUploadBytes = () => getSettings()['limits.maxAttachmentMb'] * 1024 * 1024;
const base = () => config.publicUrl.replace(/\/+$/, '');

function session(user: UserRow) {
  const id = accountId(user.id);
  const maxUpload = maxUploadBytes();
  const mail = {
    maxMailboxesPerEmail: null,
    maxMailboxDepth: 1,
    maxSizeMailboxName: 80,
    maxSizeAttachmentsPerEmail: maxUpload,
    emailQuerySortOptions: ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject', 'hasKeyword'],
    mayCreateTopLevelMailbox: true,
  };
  // FUTURERELEASE's arguments (RFC 4865) are the longest hold and the latest release time; the time counts from the start of the day, so the session changes only daily.
  const day = Math.floor(now() / 86_400_000) * 86_400_000;
  const latest = new Date(day + MAX_DELAYED_SEND * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const submission = { maxDelayedSend: MAX_DELAYED_SEND, submissionExtensions: { FUTURERELEASE: [String(MAX_DELAYED_SEND), latest] } };
  const s = {
    capabilities: {
      [CAP.core]: {
        maxSizeUpload: maxUpload,
        maxConcurrentUpload: LIMITS.maxConcurrentUpload,
        maxSizeRequest: LIMITS.maxSizeRequest,
        maxConcurrentRequests: LIMITS.maxConcurrentRequests,
        maxCallsInRequest: LIMITS.maxCallsInRequest,
        maxObjectsInGet: LIMITS.maxObjectsInGet,
        maxObjectsInSet: LIMITS.maxObjectsInSet,
        collationAlgorithms: ['i;ascii-casemap'],
      },
      [CAP.mail]: {},
      [CAP.submission]: {},
      [CAP.quota]: {},
      [CAP.vacation]: {},
      [CAP.snooze]: {},
      [CAP.contacts]: {},
      [CAP.wren]: {},
    },
    accounts: {
      [id]: {
        name: user.email,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [CAP.mail]: mail,
          [CAP.submission]: submission,
          [CAP.quota]: {},
          [CAP.vacation]: {},
          [CAP.snooze]: {},
          [CAP.contacts]: { mayCreateAddressBook: false },
          // adminRole: who may unlock the admin panel in a native app (/jmap/admin/unlock), else null.
          [CAP.wren]: { canSend: true, unsubscribe: true, preferences: true, adminRole: adminRole(user) },
        },
      },
      // Each shared mailbox they belong to is another account. Members who can't send still read and write drafts, so none is read-only.
      ...Object.fromEntries(
        sharedAccounts(user.id).map(({ box, canSend }) => [
          accountId(box.id),
          { name: box.email, isPersonal: false, isReadOnly: false, accountCapabilities: { [CAP.mail]: mail, [CAP.submission]: submission, [CAP.snooze]: {}, [CAP.wren]: { canSend, unsubscribe: true } } },
        ]),
      ),
    },
    primaryAccounts: { [CAP.mail]: id, [CAP.submission]: id, [CAP.quota]: id, [CAP.vacation]: id, [CAP.contacts]: id, [CAP.wren]: id },
    username: user.email,
    apiUrl: `${base()}/jmap/api`,
    downloadUrl: `${base()}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${base()}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${base()}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
  };
  // The session state changes when anything in the session object would.
  return { ...s, state: sha256(JSON.stringify(s)).slice(0, 16) };
}

const sessionState = (user: UserRow) => session(user).state;

/** RFC 6266 filename*, so any name survives. */
const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

export const jmapRoutes = new Hono<JmapEnv>();

// Off unless an admin turns it on.
for (const path of ['/jmap/*', '/.well-known/jmap']) {
  jmapRoutes.use(path, async (c, next) => {
    if (!getSettings()['jmap.enabled']) return c.json({ error: 'Not found' }, 404);
    await next();
  });
}

// Where mail apps look first (RFC 8620 2.2). They sign in at the session URL.
jmapRoutes.get('/.well-known/jmap', (c) => c.redirect('/jmap/session', 301));

// Mail apps aren't browsers: no cookies, no CORS, and every request is authenticated.
jmapRoutes.use('/jmap/*', async (c, next) => {
  const ip = clientIp(c) || 'unknown';
  if (failureCount(ip) >= FAILURES_ALLOWED) {
    const res = problem('about:blank', 'Too many failed sign-ins. Try again later.', 429);
    res.headers.set('Retry-After', String(FAILURE_WINDOW_MS / 1000));
    return res;
  }
  const found = authenticateAppPassword(c.req.header('authorization'));
  if (!found) {
    if (c.req.header('authorization')) noteFailure(ip);
    return unauthorized();
  }
  if (found.user.kind !== 'person') return unauthorized();
  if (found.user.mail_apps_blocked) return problem('about:blank', 'An administrator turned off mail apps for this account', 403);
  if (mustChangePassword(found.user)) return problem('about:blank', 'Sign in to Wren on the web and choose a new password first', 403);
  if (mustSetup2fa(found.user)) return problem('about:blank', 'Sign in to Wren on the web and set up two-step sign-in first', 403);
  c.set('user', found.user);
  c.set('keyId', found.keyId);
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

jmapRoutes.get('/jmap/session', (c) => c.json(session(c.get('user'))));

jmapRoutes.post('/jmap/api', async (c) => {
  const user = c.get('user');
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) return problem('notJSON', 'Send the request as application/json');
  if (Number(c.req.header('content-length') ?? 0) > LIMITS.maxSizeRequest) return problem('limit', 'The request is too large', 400, { limit: 'maxSizeRequest' });
  return limited(`api:${user.id}`, LIMITS.maxConcurrentRequests, 'maxConcurrentRequests', async () => {
    const text = await c.req.text();
    if (text.length > LIMITS.maxSizeRequest) return problem('limit', 'The request is too large', 400, { limit: 'maxSizeRequest' });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem('notJSON', 'The request is not valid JSON');
    }
    return processRequest(body, user, c.get('keyId'), sessionState(user));
  });
});

/** The mailbox the URL's account id names, if the person may use it now. */
const mailboxOf = (c: Context<JmapEnv>) => accountFor(c.get('user'), c.req.param('accountId'))?.box;

jmapRoutes.get('/jmap/download/:accountId/:blobId/:name', async (c) => {
  const box = mailboxOf(c);
  if (!box) return c.json({ error: 'Not found' }, 404);
  const blob = await readBlob(box.id, c.req.param('blobId'));
  if (!blob) return c.json({ error: 'Not found' }, 404);
  const accept = c.req.query('accept');
  const name = c.req.param('name') || blob.name;
  return new Response(blob.data as BodyInit, {
    headers: {
      'Content-Type': accept && MEDIA_TYPE.test(accept) ? accept : blob.type,
      'Content-Length': String(blob.data.length),
      'Content-Disposition': disposition(name),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      // A blob id always names the same bytes.
      'Cache-Control': box.id === c.get('user').id ? 'private, max-age=31536000, immutable' : 'no-store',
    },
  });
});

jmapRoutes.post('/jmap/upload/:accountId/', async (c) => {
  const user = c.get('user');
  const box = mailboxOf(c);
  if (!box) return problem('about:blank', 'No such account', 404);
  const max = maxUploadBytes();
  if (Number(c.req.header('content-length') ?? 0) > max) return problem('limit', 'The file is too large', 413, { limit: 'maxSizeUpload' });
  // Uploads nothing uses yet are capped, so they can't fill the store before they expire.
  const pending = get<{ b: number | null }>('SELECT SUM(size) AS b FROM attachments WHERE user_id = ? AND message_id IS NULL', [box.id])?.b ?? 0;
  if (pending > 10 * max) return problem('about:blank', 'Too many unused uploads. Use or wait for the earlier ones to expire.', 429);
  return limited(`upload:${user.id}`, LIMITS.maxConcurrentUpload, 'maxConcurrentUpload', async () => {
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length > max) return problem('limit', 'The file is too large', 413, { limit: 'maxSizeUpload' });
    const type = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    return c.json({ accountId: accountId(box.id), ...(await storeUploadBlob(box.id, data, type)) }, 201);
  });
});

jmapRoutes.get('/jmap/eventsource', (c) => eventSource(c.get('user').id, { types: c.req.query('types'), closeafter: c.req.query('closeafter'), ping: c.req.query('ping') }));

// ── Unlocking the admin panel in this app (services/admin-unlock.ts) ────────
// Not JMAP methods: what they hand out is used on /api/admin, and none of it is mail.

const challenge = z.string().max(200);

jmapRoutes.post('/jmap/admin/unlock', async (c) => {
  const input = await body(c, z.object({ password: z.string().max(256), device: z.string().max(200).optional() }));
  return c.json(await startUnlock(c, c.get('user'), c.get('keyId'), input.password, input.device));
});

jmapRoutes.post('/jmap/admin/unlock/web', async (c) => {
  const input = await body(c, z.object({ challenge }));
  return c.json(askWeb(c.get('user'), c.get('keyId'), input.challenge));
});

jmapRoutes.post('/jmap/admin/unlock/email', async (c) => {
  const input = await body(c, z.object({ challenge }));
  return c.json(await sendEmailCode(c, c.get('user'), c.get('keyId'), input.challenge));
});

jmapRoutes.post('/jmap/admin/unlock/verify', async (c) => {
  const input = await body(c, z.object({ challenge, step: z.enum(['totp', 'web', 'email']), code: z.string().max(64).optional() }));
  const r = finishUnlock(c, c.get('user'), c.get('keyId'), input.challenge, input.step, input.code);
  return c.json(r, 'waiting' in r ? 202 : 200);
});

jmapRoutes.post('/jmap/admin/lock', (c) => c.json(lockAdmin(c.get('user'), c.get('keyId'))));
