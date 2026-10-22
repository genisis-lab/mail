/** The Calendar page: a range of days, and the events people add themselves. */
import { Hono } from 'hono';
import { z } from 'zod';
import { get, insert, now, run } from '../db/index.js';
import { badRequest, notFound } from '../lib/http.js';
import { domainOf } from '../lib/addr.js';
import { body, intParam, type AppEnv } from '../http/context.js';
import { calendarEvents, eventFile, icsDownload, type CalendarEventRow } from '../services/calendar.js';

export const calendarRoutes = new Hono<AppEnv>();

const DAY = 86_400_000;
/** A month view asks for six weeks. */
const MAX_DAYS = 100;
/** 9999-12-31, the last day an .ics file can say. */
const MAX_TS = 253_402_300_799_999;

const eventSchema = z
  .object({
    title: z.string().trim().min(1, 'Add a title').max(300),
    allDay: z.boolean().default(false),
    start: z.number().int().min(0).max(MAX_TS),
    end: z.number().int().min(0).max(MAX_TS),
    location: z.string().trim().max(500).default(''),
    notes: z.string().max(10_000).default(''),
  })
  .refine((e) => e.end >= e.start, { message: 'The event can’t end before it starts', path: ['end'] })
  .refine((e) => !e.allDay || (e.start % DAY === 0 && e.end % DAY === 0 && e.end > e.start), { message: 'An all-day event runs from midnight to midnight (UTC)', path: ['start'] });

const values = (e: z.infer<typeof eventSchema>) => [e.title, e.allDay ? 1 : 0, e.start, e.end, e.location, e.notes];

/** Everything on the calendar from `from` to `to` (ms): the person's own events and the invitations in their mail. */
calendarRoutes.get('/', async (c) => {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > MAX_DAYS * DAY) throw badRequest(`Pick a range of up to ${MAX_DAYS} days`);
  return c.json(await calendarEvents(c.get('user').id, from, to));
});

calendarRoutes.post('/events', async (c) => {
  const e = await body(c, eventSchema);
  const id = insert('INSERT INTO calendar_events (user_id, title, all_day, start_at, end_at, location, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    c.get('user').id,
    ...values(e),
    now(),
  ]);
  return c.json({ id });
});

calendarRoutes.put('/events/:id', async (c) => {
  const id = intParam(c, 'id');
  const e = await body(c, eventSchema);
  if (!run('UPDATE calendar_events SET title = ?, all_day = ?, start_at = ?, end_at = ?, location = ?, notes = ? WHERE id = ? AND user_id = ?', [...values(e), id, c.get('user').id]).changes) {
    throw notFound('Event not found');
  }
  return c.json({ ok: true });
});

calendarRoutes.delete('/events/:id', (c) => {
  if (!run('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [intParam(c, 'id'), c.get('user').id]).changes) throw notFound('Event not found');
  return c.json({ ok: true });
});

/** The event as a .ics file, to add to another calendar app. */
calendarRoutes.get('/events/:id/event.ics', (c) => {
  const user = c.get('user');
  const row = get<CalendarEventRow>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [intParam(c, 'id'), user.id]);
  if (!row) throw notFound('Event not found');
  return icsDownload(eventFile(row, domainOf(user.email)), row.title);
});
