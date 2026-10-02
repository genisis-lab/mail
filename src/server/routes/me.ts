/** Per-user features: saved replies, saved searches, self-service aliases, push, import and export. Mounted on /api/me. */
import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, insert, now, run } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { domainOf, normalizeEmail } from '../lib/addr.js';
import { getSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { body, clientIp, intParam, rateLimit, type AppEnv } from '../http/context.js';
import { pushToUsers, saveSubscription, validEndpoint, vapidPublicKey } from '../services/push.js';
import { jobDto, type JobRow } from '../services/jobs.js';
import { deleteJob, exportStream, importMboxBatch, startExport, startImapImport } from '../services/mail-import.js';
import { ImapError } from '../mail/imap-client.js';
import { HttpError } from '../lib/http.js';

export const meRoutes = new Hono<AppEnv>();

// ── Saved replies ───────────────────────────────────────────────────────────

const replySchema = z.object({ name: z.string().trim().min(1).max(80), html: z.string().min(1).max(100_000) });
const replyDto = (r: any) => ({ id: r.id, name: r.name, html: r.html, updatedAt: r.updated_at });

meRoutes.get('/saved-replies', (c) => c.json({ replies: all<any>('SELECT * FROM saved_replies WHERE user_id = ? ORDER BY name COLLATE NOCASE', [c.get('user').id]).map(replyDto) }));

meRoutes.post('/saved-replies', async (c) => {
  const user = c.get('user');
  const input = await body(c, replySchema);
  if ((get<{ c: number }>('SELECT COUNT(*) AS c FROM saved_replies WHERE user_id = ?', [user.id])?.c ?? 0) >= 200) throw badRequest('You can keep up to 200 saved replies');
  const id = insert('INSERT INTO saved_replies (user_id, name, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [user.id, input.name, input.html, now(), now()]);
  return c.json({ reply: replyDto(get('SELECT * FROM saved_replies WHERE id = ?', [id])) });
});

meRoutes.put('/saved-replies/:id', async (c) => {
  const input = await body(c, replySchema);
  const r = run('UPDATE saved_replies SET name = ?, html = ?, updated_at = ? WHERE id = ? AND user_id = ?', [input.name, input.html, now(), intParam(c, 'id'), c.get('user').id]);
  if (!r.changes) throw notFound();
  return c.json({ reply: replyDto(get('SELECT * FROM saved_replies WHERE id = ?', [intParam(c, 'id')])) });
});

meRoutes.delete('/saved-replies/:id', (c) => {
  if (!run('DELETE FROM saved_replies WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]).changes) throw notFound();
  return c.json({ ok: true });
});

// ── Saved searches ──────────────────────────────────────────────────────────

const searchSchema = z.object({ name: z.string().trim().min(1).max(60), query: z.string().trim().min(1).max(500) });
const searchDto = (r: any) => ({ id: r.id, name: r.name, query: r.query, position: r.position });

meRoutes.get('/saved-searches', (c) =>
  c.json({ searches: all<any>('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY position, id', [c.get('user').id]).map(searchDto) }),
);

meRoutes.post('/saved-searches', async (c) => {
  const user = c.get('user');
  const input = await body(c, searchSchema);
  const count = get<{ c: number; p: number | null }>('SELECT COUNT(*) AS c, MAX(position) AS p FROM saved_searches WHERE user_id = ?', [user.id]);
  if ((count?.c ?? 0) >= 50) throw badRequest('You can keep up to 50 saved searches');
  if (get('SELECT 1 FROM saved_searches WHERE user_id = ? AND query = ?', [user.id, input.query])) throw conflict('This search is already saved');
  const id = insert('INSERT INTO saved_searches (user_id, name, query, position, created_at) VALUES (?, ?, ?, ?, ?)', [user.id, input.name, input.query, (count?.p ?? -1) + 1, now()]);
  return c.json({ search: searchDto(get('SELECT * FROM saved_searches WHERE id = ?', [id])) });
});

meRoutes.put('/saved-searches/:id', async (c) => {
  const input = await body(c, searchSchema.partial().extend({ position: z.number().int().min(0).max(1000).optional() }));
  const id = intParam(c, 'id');
  const row = get<any>('SELECT * FROM saved_searches WHERE id = ? AND user_id = ?', [id, c.get('user').id]);
  if (!row) throw notFound();
  run('UPDATE saved_searches SET name = ?, query = ?, position = ? WHERE id = ?', [input.name ?? row.name, input.query ?? row.query, input.position ?? row.position, id]);
  return c.json({ search: searchDto(get('SELECT * FROM saved_searches WHERE id = ?', [id])) });
});

meRoutes.delete('/saved-searches/:id', (c) => {
  if (!run('DELETE FROM saved_searches WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]).changes) throw notFound();
  return c.json({ ok: true });
});

// ── Self-service aliases ────────────────────────────────────────────────────

const RESERVED = /^(postmaster|abuse|admin|administrator|root|hostmaster|webmaster|mailer-daemon|noreply|no-reply|security|support|billing|info|hello|sales|team)$/i;

function aliasPolicy(userId: number) {
  const s = getSettings();
  const domain = domainOf(get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])!.email);
  const used = get<{ c: number }>(`SELECT COUNT(*) AS c FROM addresses WHERE user_id = ? AND kind = 'alias' AND created_by = ?`, [userId, userId])?.c ?? 0;
  return { enabled: s['aliases.selfService'], limit: s['aliases.maxPerUser'], used, domain };
}

meRoutes.get('/aliases', (c) => {
  const user = c.get('user');
  const aliases = all<any>(`SELECT id, address, name, created_by, created_at FROM addresses WHERE user_id = ? AND kind = 'alias' ORDER BY address`, [user.id]);
  return c.json({
    policy: aliasPolicy(user.id),
    aliases: aliases.map((a) => ({ id: a.id, address: a.address, name: a.name, own: a.created_by === user.id, createdAt: a.created_at })),
  });
});

meRoutes.post('/aliases', async (c) => {
  const user = c.get('user');
  const policy = aliasPolicy(user.id);
  if (!policy.enabled) throw forbidden('Your administrator manages aliases');
  if (policy.used >= policy.limit) throw badRequest(`You can create up to ${policy.limit} aliases`);
  const input = await body(c, z.object({ localPart: z.string().trim().min(1).max(64), name: z.string().trim().max(100).default('') }));
  const local = input.localPart.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(local) || local.includes('..')) throw badRequest('Use letters, numbers, dots, dashes and underscores');
  if (RESERVED.test(local)) throw conflict('That address is reserved');
  const address = normalizeEmail(`${local}@${policy.domain}`);
  if (get('SELECT 1 FROM addresses WHERE address = ?', [address]) || get('SELECT 1 FROM users WHERE email = ?', [address])) throw conflict('That address is already taken');
  const d = get<{ id: number }>('SELECT id FROM domains WHERE name = ?', [policy.domain]);
  if (!d) throw badRequest('Your domain is not available');
  const id = insert(`INSERT INTO addresses (address, domain_id, kind, user_id, name, can_send, created_by, created_at) VALUES (?, ?, 'alias', ?, ?, 1, ?, ?)`, [
    address,
    d.id,
    user.id,
    input.name || user.name,
    user.id,
    now(),
  ]);
  audit(user.id, 'account.alias_created', address, undefined, clientIp(c));
  return c.json({ alias: { id, address, name: input.name || user.name, own: true } });
});

meRoutes.delete('/aliases/:id', (c) => {
  const user = c.get('user');
  const a = get<{ address: string }>(`SELECT address FROM addresses WHERE id = ? AND user_id = ? AND kind = 'alias' AND created_by = ?`, [intParam(c, 'id'), user.id, user.id]);
  if (!a) throw notFound('You can only remove aliases you created');
  run('DELETE FROM addresses WHERE id = ?', [intParam(c, 'id')]);
  audit(user.id, 'account.alias_deleted', a.address, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ── Push notifications ──────────────────────────────────────────────────────

meRoutes.get('/push', async (c) => {
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?', [c.get('user').id])?.c ?? 0;
  return c.json({ publicKey: await vapidPublicKey(), devices: count });
});

const subSchema = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }) });

meRoutes.post('/push/subscribe', async (c) => {
  const sub = await body(c, subSchema);
  if (!validEndpoint(sub.endpoint)) throw badRequest('Unsupported push service');
  const user = c.get('user');
  if ((get<{ c: number }>('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?', [user.id])?.c ?? 0) >= 20) {
    // Keep the 19 most recent devices.
    run('DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) LIMIT 1)', [user.id]);
  }
  saveSubscription(user.id, sub, c.req.header('user-agent') ?? null);
  return c.json({ ok: true });
});

meRoutes.post('/push/unsubscribe', async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().max(1000) }));
  run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [c.get('user').id, endpoint]);
  return c.json({ ok: true });
});

meRoutes.post('/push/test', async (c) => c.json({ delivered: await pushToUsers([c.get('user').id]) }));

/**
 * What the service worker shows when a push arrives: newest unread inbox mail
 * across the person's own mailbox and the shared mailboxes they belong to.
 */
meRoutes.get('/notifications', (c) => {
  const user = c.get('user');
  const since = Number(c.req.query('since') ?? 0) || now() - 24 * 3600_000;
  const boxes = [user.id, ...all<{ mailbox_id: number }>('SELECT mailbox_id FROM mailbox_members WHERE user_id = ?', [user.id]).map((r) => r.mailbox_id)];
  const rows = all<any>(
    `SELECT m.id, m.user_id, m.thread_id, m.from_addr, m.from_name, m.subject, m.date, m.created_at, u.name AS box_name, u.email AS box_email
       FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.user_id IN (SELECT value FROM json_each(?)) AND m.direction = 'in' AND m.folder = 'inbox' AND m.is_read = 0 AND m.created_at > ? AND COALESCE(m.source, '') <> 'import'
      ORDER BY m.created_at DESC LIMIT 5`,
    [JSON.stringify(boxes), since],
  );
  const total =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE user_id IN (SELECT value FROM json_each(?)) AND direction = 'in' AND folder = 'inbox' AND is_read = 0 AND created_at > ? AND COALESCE(source, '') <> 'import'`,
      [JSON.stringify(boxes), since],
    )?.c ?? 0;
  return c.json({
    total,
    items: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      mailbox: r.user_id === user.id ? null : { id: r.user_id, name: r.box_name, address: r.box_email },
      from: { address: r.from_addr, name: r.from_name },
      subject: r.subject,
      arrivedAt: r.created_at,
    })),
  });
});

// ── Import and export ───────────────────────────────────────────────────────

/** One upload from the browser: up to 50 messages split out of an mbox file. */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

meRoutes.post('/import/messages', async (c) => {
  const user = c.get('user');
  const input = await body(c, z.object({ messages: z.array(z.string().max(34_000_000)).min(1).max(50) }));
  let total = 0;
  const raws = input.messages.map((b64) => {
    const buf = Buffer.from(b64, 'base64');
    total += buf.length;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  if (total > MAX_UPLOAD_BYTES) throw badRequest('Upload at most 24 MB at a time');
  return c.json(await importMboxBatch(user.id, raws));
});

const imapSchema = z.object({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .refine((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^[\d.]+$/.test(h) && !/\.(local|localhost|internal|lan|home|arpa)$/.test(h), 'Enter the server name, like imap.gmail.com'),
  port: z.number().int().refine((p) => p === 993 || p === 143, 'Use port 993 (SSL/TLS) or 143 (STARTTLS)'),
  security: z.enum(['tls', 'starttls']),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
});

meRoutes.post('/import/imap', async (c) => {
  const user = c.get('user');
  const input = await body(c, imapSchema);
  rateLimit(`imap-import:${user.id}`, 10, 15 * 60_000);
  try {
    const id = await startImapImport(user.id, { ...input, timeoutMs: 20_000 });
    audit(user.id, 'account.import_started', `${input.username} (${input.host})`, undefined, clientIp(c));
    return c.json({ job: jobDto(get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])!) });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof ImapError && err.authFailed) {
      throw badRequest(`${input.host} didn’t accept the username or password. For Gmail, iCloud and Yahoo use an app password.`, 'imap_auth');
    }
    throw badRequest(`Couldn’t connect to ${input.host}:${input.port}: ${(err as Error).message}`, 'imap_connect');
  }
});

meRoutes.get('/jobs', (c) => c.json({ jobs: all<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20', [c.get('user').id]).map(jobDto) }));

function ownJob(c: { get(k: 'user'): { id: number } }, id: number): JobRow {
  const job = get<JobRow>('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [id, c.get('user').id]);
  if (!job) throw notFound();
  return job;
}

meRoutes.post('/jobs/:id/cancel', async (c) => {
  const job = ownJob(c, intParam(c, 'id'));
  if (job.status === 'queued' || job.status === 'running') {
    run(`UPDATE jobs SET status = 'cancelled', config = NULL, updated_at = ? WHERE id = ?`, [now(), job.id]);
  }
  if (job.kind === 'export') await deleteJob(job);
  return c.json({ ok: true });
});

meRoutes.delete('/jobs/:id', async (c) => {
  const job = ownJob(c, intParam(c, 'id'));
  if (job.status === 'queued' || job.status === 'running') throw conflict('Cancel the job first');
  await deleteJob(job);
  return c.json({ ok: true });
});

meRoutes.post('/export', (c) => {
  const user = c.get('user');
  const id = startExport(user.id);
  audit(user.id, 'account.export_started', undefined, undefined, clientIp(c));
  return c.json({ job: jobDto(get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])!) });
});

meRoutes.get('/export/:id/download', (c) => {
  const job = ownJob(c, intParam(c, 'id'));
  if (job.kind !== 'export') throw notFound();
  if (job.status !== 'done') throw conflict('The export isn’t ready yet');
  const bytes = (JSON.parse(job.state) as { bytes?: number }).bytes ?? 0;
  const day = new Date(job.created_at).toISOString().slice(0, 10);
  return new Response(exportStream(job), {
    headers: {
      'Content-Type': 'application/mbox',
      'Content-Disposition': `attachment; filename="wren-mail-${day}.mbox"`,
      'Content-Length': String(bytes),
      'Cache-Control': 'private, no-store',
    },
  });
});
