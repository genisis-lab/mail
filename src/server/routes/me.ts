/** Per-user features: saved replies, saved searches, self-service aliases. Mounted on /api/me. */
import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, insert, now, run } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { domainOf, normalizeEmail } from '../lib/addr.js';
import { getSettings } from '../settings.js';
import { audit } from '../services/audit.js';
import { body, clientIp, intParam, type AppEnv } from '../http/context.js';

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
