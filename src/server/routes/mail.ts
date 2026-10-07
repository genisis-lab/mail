import { Hono } from 'hono';
import { z } from 'zod';
import type { Category, View } from '../../shared/types.js';
import { CATEGORIES } from '../mail/categorize.js';
import { all, get, insert, now, run, tx } from '../db/index.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/http.js';
import { isEmail, normalizeEmail } from '../lib/addr.js';
import { getBlob } from '../mail/blobs.js';
import { applyThreadAction, counters, getMessage, getThread, listThreads, VIEWS, type ThreadAction } from '../mail/threads.js';
import { retryOutbox } from '../mail/outbound.js';
import { purgeMessages } from '../mail/store.js';
import { unsubscribe } from '../services/unsubscribe.js';
import { inviteFile, inviteFor, replyToInvite } from '../services/calendar.js';
import type { Rsvp } from '../../shared/ics.js';
import { body, clientIp, intParam, type AppEnv } from '../http/context.js';
import { audit } from '../services/audit.js';
import { raiseAlert } from '../services/alerts.js';

export const mailRoutes = new Hono<AppEnv>();

mailRoutes.get('/threads', (c) => {
  const user = c.get('user');
  const view = (c.req.query('view') ?? 'inbox') as View;
  if (!VIEWS.includes(view)) throw badRequest('Unknown view');
  const label = c.req.query('label');
  const category = c.req.query('category');
  if (category && !CATEGORIES.includes(category as Category)) throw badRequest('Unknown tab');
  const result = listThreads(user.id, {
    view,
    category: (category as Category) || undefined,
    labelId: label ? Number(label) : undefined,
    query: c.req.query('q') ?? undefined,
    page: Number(c.req.query('page') ?? 1),
    pageSize: Number(c.req.query('pageSize') ?? 50),
  });
  return c.json(result);
});

mailRoutes.get('/threads/:id', async (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  const thread = await getThread(user.id, id);
  if (!thread) throw notFound('Conversation not found');
  // Mark read on the server, but return the pre-open state so the client can
  // expand the messages that were unread.
  if (c.req.query('markRead') !== '0' && thread.messages.some((m) => !m.isRead)) {
    run(`UPDATE messages SET is_read = 1 WHERE thread_id = ? AND user_id = ? AND is_read = 0`, [id, user.id]);
  }
  return c.json(thread);
});

const actionSchema = z.object({
  threadIds: z.array(z.number().int().positive()).min(1).max(1000),
  action: z.union([
    z.object({
      type: z.enum(['read', 'unread', 'star', 'unstar', 'important', 'unimportant', 'archive', 'inbox', 'trash', 'untrash', 'spam', 'notspam', 'delete', 'unsnooze']),
    }),
    z.object({ type: z.literal('snooze'), until: z.number().int() }),
    z.object({ type: z.enum(['label', 'unlabel']), labelId: z.number().int().positive() }),
    z.object({ type: z.literal('category'), category: z.enum(['primary', 'updates', 'promotions']) }),
    z.object({ type: z.enum(['mute', 'unmute', 'cancelFollowUp', 'merge']) }),
    z.object({ type: z.literal('followUp'), at: z.number().int() }),
  ]),
});

mailRoutes.post('/threads/actions', async (c) => {
  const user = c.get('user');
  const { threadIds, action } = await body(c, actionSchema);
  const changed = applyThreadAction(user.id, threadIds, action as ThreadAction);
  return c.json({ changed });
});

/** Apply an action to every thread matching a view/search (e.g. "select all 2,341 conversations"). */
mailRoutes.post('/threads/bulk', async (c) => {
  const user = c.get('user');
  const input = await body(
    c,
    z.object({ view: z.string().optional(), label: z.number().optional(), q: z.string().optional(), category: z.enum(['primary', 'updates', 'promotions']).optional(), action: actionSchema.shape.action }),
  );
  let page = 1;
  let changed = 0;
  const ids: number[] = [];
  for (;;) {
    const r = listThreads(user.id, { view: (input.view as View) ?? 'inbox', labelId: input.label, query: input.q, category: input.category, page, pageSize: 200 });
    ids.push(...r.threads.map((t) => t.id));
    if (r.threads.length < 200 || ids.length >= 20_000) break;
    page++;
  }
  for (let i = 0; i < ids.length; i += 500) changed += applyThreadAction(user.id, ids.slice(i, i + 500), input.action as ThreadAction);
  return c.json({ changed, threads: ids.length });
});

mailRoutes.post('/messages/:id/actions', async (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  const { type } = await body(c, z.object({ type: z.enum(['read', 'unread', 'star', 'unstar', 'important', 'unimportant', 'trash', 'delete']) }));
  const m = get<{ id: number; folder: string }>('SELECT id, folder FROM messages WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!m) throw notFound();
  const set: Record<string, string> = {
    read: 'is_read = 1',
    unread: 'is_read = 0',
    star: 'is_starred = 1',
    unstar: 'is_starred = 0',
    important: 'is_important = 1',
    unimportant: 'is_important = 0',
  };
  if (type === 'trash') run(`UPDATE messages SET folder = 'trash', trashed_at = ? WHERE id = ?`, [now(), id]);
  else if (type === 'delete') {
    if (m.folder !== 'trash' && m.folder !== 'spam') throw badRequest('Move the message to Trash first');
    purgeMessages([id]);
  } else run(`UPDATE messages SET ${set[type]} WHERE id = ?`, [id]);
  return c.json({ ok: true });
});

/**
 * "Report phishing": the message goes to Spam, and admins get an alert so they
 * can warn others or block the sender server-wide. The reporter's own inbox
 * is all that changes; nothing is sent anywhere.
 */
mailRoutes.post('/messages/:id/phishing', async (c) => {
  const user = c.get('user');
  const m = get<{ id: number; thread_id: number; from_addr: string; from_name: string; subject: string; direction: string }>(
    'SELECT id, thread_id, from_addr, from_name, subject, direction FROM messages WHERE id = ? AND user_id = ?',
    [intParam(c, 'id'), user.id],
  );
  if (!m) throw notFound();
  if (m.direction !== 'in') throw badRequest('Only received mail can be reported');
  // Everything this sender put in the conversation goes to Spam.
  run(`UPDATE messages SET folder = 'spam', snoozed_until = NULL WHERE thread_id = ? AND user_id = ? AND direction = 'in' AND lower(from_addr) = lower(?)`, [m.thread_id, user.id, m.from_addr]);
  audit(user.id, 'mail.phishing_reported', m.from_addr, { subject: m.subject.slice(0, 200) }, clientIp(c));
  await raiseAlert({
    kind: 'phishing',
    key: `${user.id}:${m.id}`,
    severity: 'warn',
    title: `Phishing reported by ${user.email}`,
    detail: `From ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}: “${m.subject.slice(0, 150) || '(no subject)'}”. Block the sender under Settings & policies → Spam if others got it too.`,
    link: '/admin/settings/spam',
  }).catch(() => {});
  return c.json({ ok: true });
});

/** New inbox mail since `after` (a message id), for notifications. */
mailRoutes.get('/recent', (c) => {
  const user = c.get('user');
  const after = Number(c.req.query('after') ?? 0) || 0;
  const latest = get<{ id: number | null }>(`SELECT MAX(id) AS id FROM messages WHERE user_id = ? AND direction = 'in' AND folder = 'inbox'`, [user.id])?.id ?? 0;
  if (!after) return c.json({ latestId: latest, messages: [] });
  const rows = all<any>(
    `SELECT id, thread_id, from_addr, from_name, subject, snippet, date FROM messages
      WHERE user_id = ? AND direction = 'in' AND folder = 'inbox' AND is_read = 0 AND id > ? AND COALESCE(source, '') <> 'import' ORDER BY id DESC LIMIT 10`,
    [user.id, after],
  );
  return c.json({
    latestId: latest,
    messages: rows.map((r) => ({ id: r.id, threadId: r.thread_id, from: { address: r.from_addr, name: r.from_name }, subject: r.subject, snippet: r.snippet, date: r.date })),
  });
});

mailRoutes.get('/messages/:id', async (c) => {
  const m = await getMessage(c.get('user').id, intParam(c, 'id'));
  if (!m) throw notFound();
  return c.json(m);
});

/** Original message source (RFC 822). */
mailRoutes.get('/messages/:id/raw', async (c) => {
  const user = c.get('user');
  const m = get<{ raw_blob: string | null; subject: string }>('SELECT raw_blob, subject FROM messages WHERE id = ? AND user_id = ?', [intParam(c, 'id'), user.id]);
  if (!m?.raw_blob) throw notFound('Original message is not available');
  const raw = await getBlob(m.raw_blob);
  const download = c.req.query('download') === '1';
  return new Response(new Uint8Array(raw), {
    headers: {
      'Content-Type': download ? 'message/rfc822' : 'text/plain; charset=utf-8',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="message.eml"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ── Meeting invitations ─────────────────────────────────────────────────────

mailRoutes.get('/messages/:id/invite', async (c) => c.json({ invite: await inviteFor(c.get('user').id, intParam(c, 'id')) }));

mailRoutes.post('/messages/:id/invite/reply', async (c) => {
  const box = c.get('mailbox');
  if (box && !box.canSend) throw forbidden('You can read this shared mailbox, but not send from it');
  const { response, comment } = await body(c, z.object({ response: z.enum(['accepted', 'tentative', 'declined']), comment: z.string().max(2000).default('') }));
  try {
    const r = await replyToInvite(c.get('user').id, intParam(c, 'id'), response.toUpperCase() as Rsvp, comment, c.get('actor')?.id ?? c.get('user').id);
    return c.json(r);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest((err as Error).message);
  }
});

/** The event as a .ics file, to add to another calendar app. */
mailRoutes.get('/messages/:id/invite.ics', async (c) => {
  const f = await inviteFile(c.get('user').id, intParam(c, 'id'));
  if (!f) throw notFound('This message has no invitation');
  const name = (f.summary || 'event').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'event';
  return new Response(f.ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.ics"` } });
});

/** Unsubscribe from the mailing list a message came from. */
mailRoutes.post('/messages/:id/unsubscribe', async (c) => {
  const user = c.get('user');
  try {
    return c.json(await unsubscribe(user.id, intParam(c, 'id')));
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

mailRoutes.post('/messages/:id/retry', (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  const job = get<{ id: number }>(`SELECT o.id FROM outbox o JOIN messages m ON m.id = o.message_id WHERE m.id = ? AND m.user_id = ? ORDER BY o.id DESC LIMIT 1`, [id, user.id]);
  if (!job || !retryOutbox(job.id)) throw badRequest('This message cannot be retried');
  return c.json({ ok: true });
});

mailRoutes.get('/counters', (c) => c.json(counters(c.get('user').id)));

/** Block a sender and move their existing mail to spam. */
mailRoutes.post('/block', async (c) => {
  const user = c.get('user');
  const { address } = await body(c, z.object({ address: z.string().min(3).max(254) }));
  const pattern = normalizeEmail(address);
  run('INSERT OR IGNORE INTO blocked_senders (user_id, pattern, created_at) VALUES (?, ?, ?)', [user.id, pattern, now()]);
  const moved = isEmail(pattern) ? run(`UPDATE messages SET folder = 'spam' WHERE user_id = ? AND from_addr = ? AND folder IN ('inbox','archive')`, [user.id, pattern]).changes : 0;
  return c.json({ ok: true, moved });
});

// ── Attachments ─────────────────────────────────────────────────────────────

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  // Links (images, downloads) carry no mailbox header, so also allow shared mailboxes the person belongs to.
  const a =
    get<any>('SELECT * FROM attachments WHERE id = ? AND user_id = ?', [id, user.id]) ??
    get<any>('SELECT a.* FROM attachments a JOIN mailbox_members mm ON mm.mailbox_id = a.user_id WHERE a.id = ? AND mm.user_id = ?', [id, c.get('actor').id]);
  if (!a) throw notFound();
  const data = await getBlob(a.blob);
  const inline = c.req.query('inline') === '1';
  // Only render "safe" types inline; everything else downloads.
  const safeInline = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/plain|audio\/|video\/)/i.test(a.content_type);
  const disposition = inline && safeInline ? 'inline' : 'attachment';
  // Browsers won't run their PDF viewer in a sandboxed document, so an inline PDF gets a strict policy without the sandbox.
  const pdf = inline && /^application\/pdf/i.test(a.content_type);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': safeInline ? a.content_type : 'application/octet-stream',
      'Content-Length': String(data.length),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': pdf ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      ...(pdf ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}),
    },
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

export const labelRoutes = new Hono<AppEnv>();
const labelSchema = z.object({ name: z.string().min(1).max(80), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() });

labelRoutes.get('/', (c) => {
  const rows = all<any>('SELECT id, name, color FROM labels WHERE user_id = ? ORDER BY position, name COLLATE NOCASE', [c.get('user').id]);
  return c.json({ labels: rows });
});

labelRoutes.post('/', async (c) => {
  const user = c.get('user');
  const { name, color } = await body(c, labelSchema);
  if (get('SELECT 1 FROM labels WHERE user_id = ? AND lower(name) = lower(?)', [user.id, name.trim()])) throw badRequest('A label with that name exists');
  const id = insert('INSERT INTO labels (user_id, name, color, created_at) VALUES (?, ?, ?, ?)', [user.id, name.trim(), color ?? '#64748b', now()]);
  return c.json({ id, name: name.trim(), color: color ?? '#64748b' });
});

labelRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const { name, color } = await body(c, labelSchema);
  const r = run('UPDATE labels SET name = ?, color = COALESCE(?, color) WHERE id = ? AND user_id = ?', [name.trim(), color ?? null, intParam(c, 'id'), user.id]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

labelRoutes.delete('/:id', (c) => {
  const r = run('DELETE FROM labels WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

// ── Contacts ────────────────────────────────────────────────────────────────

export const contactRoutes = new Hono<AppEnv>();
const contactSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(100).default(''),
  phone: z.string().max(50).default(''),
  company: z.string().max(100).default(''),
  notes: z.string().max(5000).default(''),
});

// Contact groups: a name ("Design team") that adds everyone in it as recipients.

interface GroupRow {
  id: number;
  name: string;
}

function groupsFor(userId: number, q?: string) {
  const groups = q
    ? all<GroupRow>('SELECT id, name FROM contact_groups WHERE user_id = ? AND name LIKE ? ORDER BY name LIMIT 5', [userId, `%${q}%`])
    : all<GroupRow>('SELECT id, name FROM contact_groups WHERE user_id = ? ORDER BY name', [userId]);
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    members: all<{ address: string; name: string }>('SELECT address, name FROM contact_group_members WHERE group_id = ? ORDER BY rowid', [g.id]),
  }));
}

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  members: z.array(z.object({ address: z.string().email().max(254), name: z.string().max(100).default('') })).min(1).max(500),
});

function saveMembers(groupId: number, members: z.infer<typeof groupSchema>['members']) {
  run('DELETE FROM contact_group_members WHERE group_id = ?', [groupId]);
  for (const m of members) run('INSERT OR IGNORE INTO contact_group_members (group_id, address, name) VALUES (?, ?, ?)', [groupId, normalizeEmail(m.address), m.name.trim()]);
}

contactRoutes.get('/groups', (c) => c.json({ groups: groupsFor(c.get('user').id) }));

contactRoutes.post('/groups', async (c) => {
  const user = c.get('user');
  const input = await body(c, groupSchema);
  if (get('SELECT 1 FROM contact_groups WHERE user_id = ? AND name = ?', [user.id, input.name])) throw badRequest('You already have a group with that name');
  const id = tx(() => {
    const gid = insert('INSERT INTO contact_groups (user_id, name, created_at) VALUES (?, ?, ?)', [user.id, input.name, now()]);
    saveMembers(gid, input.members);
    return gid;
  });
  return c.json({ id });
});

contactRoutes.put('/groups/:id', async (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  const input = await body(c, groupSchema);
  if (!get('SELECT 1 FROM contact_groups WHERE id = ? AND user_id = ?', [id, user.id])) throw notFound();
  if (get('SELECT 1 FROM contact_groups WHERE user_id = ? AND name = ? AND id != ?', [user.id, input.name, id])) throw badRequest('You already have a group with that name');
  tx(() => {
    run('UPDATE contact_groups SET name = ? WHERE id = ?', [input.name, id]);
    saveMembers(id, input.members);
  });
  return c.json({ ok: true });
});

contactRoutes.delete('/groups/:id', (c) => {
  if (!run('DELETE FROM contact_groups WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]).changes) throw notFound();
  return c.json({ ok: true });
});

contactRoutes.get('/', (c) => {
  const user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  const saved = c.req.query('saved') === '1';
  let rows = q
    ? all<any>(
        `SELECT * FROM contacts WHERE user_id = ? AND (email LIKE ? OR name LIKE ?) ORDER BY saved DESC, times_contacted DESC, last_contacted_at DESC LIMIT 10`,
        [user.id, `%${q}%`, `%${q}%`],
      )
    : all<any>(`SELECT * FROM contacts WHERE user_id = ? ${saved ? 'AND saved = 1' : ''} ORDER BY name COLLATE NOCASE, email LIMIT 2000`, [user.id]);
  if (q && rows.length < 10) {
    // Autocomplete also suggests people who have emailed you.
    const known = new Set(rows.map((r) => r.email.toLowerCase()));
    const senders = all<{ email: string; name: string }>(
      `SELECT from_addr AS email, MAX(from_name) AS name FROM messages
        WHERE user_id = ? AND direction = 'in' AND folder != 'spam' AND from_addr != '' AND (from_addr LIKE ? OR from_name LIKE ?)
          AND from_addr NOT LIKE 'mailer-daemon@%' AND from_addr NOT LIKE '%noreply%' AND from_addr NOT LIKE '%no-reply%'
        GROUP BY lower(from_addr) ORDER BY MAX(date) DESC LIMIT 10`,
      [user.id, `%${q}%`, `%${q}%`],
    );
    for (const s of senders) {
      if (rows.length >= 10 || known.has(s.email.toLowerCase())) continue;
      rows.push({ id: 0, email: s.email.toLowerCase(), name: s.name ?? '', phone: '', company: '', notes: '', saved: 0, times_contacted: 0, last_contacted_at: null });
    }
  }
  return c.json({
    contacts: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      phone: r.phone,
      company: r.company,
      notes: r.notes,
      saved: !!r.saved,
      timesContacted: r.times_contacted,
      lastContactedAt: r.last_contacted_at,
    })),
    // Autocomplete: groups whose name matches, to add everyone at once.
    ...(q ? { groups: groupsFor(user.id, q) } : {}),
  });
});

contactRoutes.post('/', async (c) => {
  const user = c.get('user');
  const input = await body(c, contactSchema);
  run(
    `INSERT INTO contacts (user_id, email, name, phone, company, notes, saved, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, phone = excluded.phone, company = excluded.company, notes = excluded.notes, saved = 1`,
    [user.id, normalizeEmail(input.email), input.name, input.phone, input.company, input.notes, now()],
  );
  return c.json({ ok: true });
});

/** Bulk import (the browser parses CSV / vCard files). Existing contacts keep their details unless the file has more. */
contactRoutes.post('/import', async (c) => {
  const user = c.get('user');
  const { contacts } = await body(
    c,
    z.object({
      contacts: z
        .array(
          z.object({
            email: z.string().max(254),
            name: z.string().max(100).default(''),
            phone: z.string().max(50).default(''),
            company: z.string().max(100).default(''),
            notes: z.string().max(5000).default(''),
          }),
        )
        .min(1)
        .max(5000),
    }),
  );
  let added = 0;
  let updated = 0;
  let skipped = 0;
  tx(() => {
    for (const ct of contacts) {
      const email = normalizeEmail(ct.email);
      if (!isEmail(email)) {
        skipped++;
        continue;
      }
      const existing = get<{ id: number }>('SELECT id FROM contacts WHERE user_id = ? AND email = ?', [user.id, email]);
      if (existing) {
        run(
          `UPDATE contacts SET name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone), company = COALESCE(NULLIF(?, ''), company),
             notes = COALESCE(NULLIF(?, ''), notes), saved = 1 WHERE id = ?`,
          [ct.name.trim(), ct.phone.trim(), ct.company.trim(), ct.notes.trim(), existing.id],
        );
        updated++;
      } else {
        insert('INSERT INTO contacts (user_id, email, name, phone, company, notes, saved, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', [
          user.id,
          email,
          ct.name.trim(),
          ct.phone.trim(),
          ct.company.trim(),
          ct.notes.trim(),
          now(),
        ]);
        added++;
      }
    }
  });
  return c.json({ added, updated, skipped });
});

const vEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

contactRoutes.get('/export', (c) => {
  const format = c.req.query('format') === 'csv' ? 'csv' : 'vcf';
  const rows = all<any>('SELECT * FROM contacts WHERE user_id = ? AND saved = 1 ORDER BY name COLLATE NOCASE, email', [c.get('user').id]);
  const out =
    format === 'csv'
      ? ['Name,Email,Phone,Company,Notes', ...rows.map((r) => [r.name, r.email, r.phone, r.company, r.notes].map(csvCell).join(','))].join('\r\n') + '\r\n'
      : rows
          .map((r) =>
            [
              'BEGIN:VCARD',
              'VERSION:3.0',
              `FN:${vEscape(r.name || r.email)}`,
              `EMAIL;TYPE=INTERNET:${r.email}`,
              r.phone ? `TEL:${vEscape(r.phone)}` : '',
              r.company ? `ORG:${vEscape(r.company)}` : '',
              r.notes ? `NOTE:${vEscape(r.notes)}` : '',
              'END:VCARD',
            ]
              .filter(Boolean)
              .join('\r\n'),
          )
          .join('\r\n') + '\r\n';
  return new Response(out, {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="contacts.${format}"`,
    },
  });
});

contactRoutes.put('/:id', async (c) => {
  const input = await body(c, contactSchema);
  const r = run(`UPDATE contacts SET email = ?, name = ?, phone = ?, company = ?, notes = ?, saved = 1 WHERE id = ? AND user_id = ?`, [
    normalizeEmail(input.email),
    input.name,
    input.phone,
    input.company,
    input.notes,
    intParam(c, 'id'),
    c.get('user').id,
  ]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

contactRoutes.delete('/:id', (c) => {
  const r = run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

// ── Filters ─────────────────────────────────────────────────────────────────

export const filterRoutes = new Hono<AppEnv>();
const filterSchema = z.object({
  name: z.string().max(100).default(''),
  enabled: z.boolean().default(true),
  criteria: z.object({
    from: z.string().max(500).optional(),
    to: z.string().max(500).optional(),
    subject: z.string().max(500).optional(),
    hasWords: z.string().max(500).optional(),
    doesNotHave: z.string().max(500).optional(),
    hasAttachment: z.boolean().optional(),
  }),
  actions: z.object({
    skipInbox: z.boolean().optional(),
    markRead: z.boolean().optional(),
    star: z.boolean().optional(),
    important: z.boolean().optional(),
    labelId: z.number().int().nullable().optional(),
    forwardTo: z.string().max(254).optional(),
    trash: z.boolean().optional(),
    neverSpam: z.boolean().optional(),
    alwaysSpam: z.boolean().optional(),
  }),
});

function validateFilter(userId: number, f: z.infer<typeof filterSchema>) {
  const c = f.criteria;
  if (!c.from && !c.to && !c.subject && !c.hasWords && !c.doesNotHave && !c.hasAttachment) throw badRequest('Add at least one condition');
  if (f.actions.forwardTo && !isEmail(f.actions.forwardTo)) throw badRequest('Invalid forwarding address');
  if (f.actions.labelId && !get('SELECT 1 FROM labels WHERE id = ? AND user_id = ?', [f.actions.labelId, userId])) throw badRequest('Unknown label');
}

filterRoutes.get('/', (c) => {
  const rows = all<any>('SELECT * FROM filters WHERE user_id = ? ORDER BY position, id', [c.get('user').id]);
  return c.json({ filters: rows.map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, criteria: JSON.parse(r.criteria), actions: JSON.parse(r.actions) })) });
});

filterRoutes.post('/', async (c) => {
  const user = c.get('user');
  const f = await body(c, filterSchema);
  validateFilter(user.id, f);
  const id = insert('INSERT INTO filters (user_id, name, criteria, actions, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    user.id,
    f.name,
    JSON.stringify(f.criteria),
    JSON.stringify(f.actions),
    f.enabled ? 1 : 0,
    now(),
  ]);
  return c.json({ id });
});

filterRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const f = await body(c, filterSchema);
  validateFilter(user.id, f);
  const r = run('UPDATE filters SET name = ?, criteria = ?, actions = ?, enabled = ? WHERE id = ? AND user_id = ?', [
    f.name,
    JSON.stringify(f.criteria),
    JSON.stringify(f.actions),
    f.enabled ? 1 : 0,
    intParam(c, 'id'),
    user.id,
  ]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

filterRoutes.delete('/:id', (c) => {
  const r = run('DELETE FROM filters WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]);
  if (!r.changes) throw notFound();
  return c.json({ ok: true });
});

// ── Blocked senders ─────────────────────────────────────────────────────────

export const blockedRoutes = new Hono<AppEnv>();

blockedRoutes.get('/', (c) => {
  const rows = all<any>('SELECT id, pattern, created_at FROM blocked_senders WHERE user_id = ? ORDER BY created_at DESC', [c.get('user').id]);
  return c.json({ blocked: rows.map((r) => ({ id: r.id, pattern: r.pattern, createdAt: r.created_at })) });
});

blockedRoutes.post('/', async (c) => {
  const { pattern } = await body(c, z.object({ pattern: z.string().min(2).max(254) }));
  run('INSERT OR IGNORE INTO blocked_senders (user_id, pattern, created_at) VALUES (?, ?, ?)', [c.get('user').id, pattern.trim().toLowerCase(), now()]);
  return c.json({ ok: true });
});

blockedRoutes.delete('/:id', (c) => {
  run('DELETE FROM blocked_senders WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]);
  return c.json({ ok: true });
});
