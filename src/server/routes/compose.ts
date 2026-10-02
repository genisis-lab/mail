import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { get } from '../db/index.js';
import { cancelSend, composeTemplate, deleteDraft, saveDraft, sendDraft, sendDirect, storeUpload } from '../mail/send.js';
import { getMessage } from '../mail/threads.js';
import { body, intParam, type AppEnv } from '../http/context.js';

export const composeRoutes = new Hono<AppEnv>();

const addrInput = z.union([z.string().max(10_000), z.array(z.object({ address: z.string().max(254), name: z.string().max(200).optional() })).max(500)]);

const draftSchema = z.object({
  from: z.string().max(400).optional(),
  to: addrInput.optional(),
  cc: addrInput.optional(),
  bcc: addrInput.optional(),
  subject: z.string().max(998).optional(),
  html: z.string().max(5_000_000).optional(),
  attachments: z.array(z.number().int().positive()).max(100).optional(),
  replyToId: z.number().int().positive().nullable().optional(),
  forwardOfId: z.number().int().positive().nullable().optional(),
});

async function draftResponse(userId: number, id: number) {
  const m = await getMessage(userId, id);
  return { id, threadId: m?.threadId, attachments: m?.attachments ?? [] };
}

composeRoutes.get('/template', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.query('messageId'));
  const mode = c.req.query('mode') as 'reply' | 'replyAll' | 'forward';
  if (!id || !['reply', 'replyAll', 'forward'].includes(mode)) throw badRequest('messageId and mode are required');
  return c.json(await composeTemplate(user.id, id, mode));
});

composeRoutes.get('/drafts/:id', async (c) => {
  const user = c.get('user');
  const m = await getMessage(user.id, intParam(c, 'id'));
  if (!m || m.folder !== 'drafts') throw notFound('Draft not found');
  return c.json(m);
});

composeRoutes.post('/drafts', async (c) => {
  const user = c.get('user');
  const input = await body(c, draftSchema);
  const id = await saveDraft(user.id, input);
  return c.json(await draftResponse(user.id, id));
});

composeRoutes.put('/drafts/:id', async (c) => {
  const user = c.get('user');
  const input = await body(c, draftSchema);
  const id = await saveDraft(user.id, { ...input, id: intParam(c, 'id') });
  return c.json(await draftResponse(user.id, id));
});

composeRoutes.delete('/drafts/:id', (c) => {
  deleteDraft(c.get('user').id, intParam(c, 'id'));
  return c.json({ ok: true });
});

/** In a shared mailbox, members without send permission can read and draft but not send. */
function sendOptions(c: Context<AppEnv>) {
  const box = c.get('mailbox');
  if (box && !box.canSend) throw forbidden('You can read this shared mailbox, but not send from it');
  return { sentBy: c.get('actor')?.id ?? c.get('user').id };
}

composeRoutes.post('/drafts/:id/send', async (c) => {
  const user = c.get('user');
  const opts = sendOptions(c);
  const { sendAt } = await body(c, z.object({ sendAt: z.number().int().nullable().optional() }));
  const res = await sendDraft(user.id, intParam(c, 'id'), { sendAt: sendAt ?? null, ...opts });
  return c.json(res);
});

/** Save + send in one call. */
composeRoutes.post('/send', async (c) => {
  const user = c.get('user');
  const opts = sendOptions(c);
  const input = await body(c, draftSchema.extend({ draftId: z.number().int().positive().nullable().optional(), sendAt: z.number().int().nullable().optional() }));
  const id = await saveDraft(user.id, { ...input, id: input.draftId ?? null });
  const res = await sendDraft(user.id, id, { sendAt: input.sendAt ?? null, ...opts });
  return c.json(res);
});

/** Undo send / cancel a scheduled send: the message becomes a draft again. */
composeRoutes.post('/messages/:id/cancel', (c) => {
  const user = c.get('user');
  const id = intParam(c, 'id');
  if (!cancelSend(user.id, id)) throw badRequest('Too late — the message has already been sent');
  return c.json({ draftId: id });
});

composeRoutes.post('/uploads', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const out = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') continue;
    const file = value as File;
    out.push(
      await storeUpload(user.id, {
        filename: file.name || 'file',
        contentType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
        inline: key === 'inline',
        contentId: key === 'inline' ? `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@wren` : null,
      }),
    );
  }
  if (!out.length) throw badRequest('No files uploaded');
  return c.json({ attachments: out });
});

// ── Public HTTP API (Authorization: Bearer wren_…) ──────────────────────────

export const apiV1Routes = new Hono<AppEnv>();

apiV1Routes.post('/send', async (c) => {
  const user = c.get('user');
  const input = await body(
    c,
    z.object({
      from: z.string().max(400).optional(),
      to: addrInput,
      cc: addrInput.optional(),
      bcc: addrInput.optional(),
      subject: z.string().max(998),
      html: z.string().max(5_000_000).optional(),
      text: z.string().max(5_000_000).optional(),
    }),
  );
  if (!input.html && !input.text) throw badRequest('Provide html or text');
  const res = await sendDirect(user.id, input);
  return c.json({ id: res.id, status: 'queued' }, 202);
});

apiV1Routes.get('/messages/:id', (c) => {
  const user = c.get('user');
  const m = get<any>('SELECT id, status, last_error, sent_at, provider_message_id, subject FROM messages WHERE id = ? AND user_id = ?', [intParam(c, 'id'), user.id]);
  if (!m) throw notFound();
  return c.json({ id: m.id, subject: m.subject, status: m.status, error: m.last_error, sentAt: m.sent_at, providerMessageId: m.provider_message_id });
});

apiV1Routes.get('/me', (c) => {
  const user = c.get('user');
  return c.json({ email: user.email, name: user.name });
});
