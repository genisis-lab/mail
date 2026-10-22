/**
 * Meeting invitations in mail: read the iCalendar part of a message, show it
 * as an event, and answer it (Yes / Maybe / No) with an iTIP REPLY to the
 * organizer, the way Gmail and Outlook do. The Calendar page puts them on a
 * month next to the events people add themselves.
 */
import { buildIcsFile, buildReply, escapeText, icsStamp, parseIcs, parseLine, type CalendarEvent, type Rsvp } from '../../shared/ics.js';
import type { CalendarItem } from '../../shared/types.js';
import { all, get, run } from '../db/index.js';
import { logger } from '../lib/log.js';
import { escapeHtml } from '../mail/compose.js';
import { getBlob } from '../mail/blobs.js';
import { saveDraft, sendDraft } from '../mail/send.js';
import { getUser, identities, userAddresses } from './users.js';

const log = logger('calendar');
const MAX_ICS = 512 * 1024;

export const isCalendarType = (contentType: string, filename = '') => /^(text\/calendar|application\/ics)\b/i.test(contentType) || /\.ics$/i.test(filename);

export interface InviteView {
  method: string;
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  timeZone: string | null;
  organizer: { email: string; name: string } | null;
  attendees: { email: string; name: string; status: string | null }[];
  status: string;
  recurring: boolean;
  url: string | null;
  /** This person's address among the attendees, and the answer they gave. */
  me: { email: string; status: string | null } | null;
  /** The answer sent from Wren, if any. */
  rsvp: string | null;
  canReply: boolean;
}

async function loadEvent(userId: number, messageId: number): Promise<{ ev: CalendarEvent; msg: any } | null> {
  const msg = get<any>('SELECT id, user_id, thread_id, direction, folder, delivered_to, from_addr, auth_results, rsvp FROM messages WHERE id = ? AND user_id = ?', [messageId, userId]);
  if (!msg) return null;
  const atts = all<{ blob: string; content_type: string; filename: string; size: number }>('SELECT blob, content_type, filename, size FROM attachments WHERE message_id = ? ORDER BY id', [messageId]);
  // Prefer the inline text/calendar part over a .ics attachment.
  const part = atts.find((a) => /^text\/calendar/i.test(a.content_type)) ?? atts.find((a) => isCalendarType(a.content_type, a.filename));
  if (!part || part.size > MAX_ICS) return null;
  const ev = parseIcs((await getBlob(part.blob)).toString('utf8'));
  if (!ev) return null;
  if (!ev.method) ev.method = /method=([a-z]+)/i.exec(part.content_type)?.[1]?.toUpperCase() ?? 'PUBLISH';
  return { ev, msg };
}

function myAttendee(userId: number, ev: CalendarEvent, deliveredTo: string | null) {
  const mine = new Set([...userAddresses(userId), ...(deliveredTo ? [deliveredTo.toLowerCase()] : [])]);
  return ev.attendees.find((a) => mine.has(a.email)) ?? null;
}

/** An ICS organizer (or SENT-BY parameter) alone cannot authorize a different sender to change an event. */
function organizerSent(ev: CalendarEvent, msg: { from_addr: string; auth_results: string | null }): boolean {
  if (ev.organizer && ev.organizer.email !== msg.from_addr.trim().toLowerCase()) return false;
  try {
    const auth = msg.auth_results ? JSON.parse(msg.auth_results) : {};
    return auth.dmarc !== 'fail';
  } catch {
    return false;
  }
}

export async function inviteFor(userId: number, messageId: number): Promise<InviteView | null> {
  const loaded = await loadEvent(userId, messageId);
  if (!loaded) return null;
  const { ev, msg } = loaded;
  const me = myAttendee(userId, ev, msg.delivered_to);
  return {
    method: ev.method,
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description.slice(0, 5000),
    location: ev.location,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    timeZone: ev.timeZone,
    organizer: ev.organizer ? { email: ev.organizer.email, name: ev.organizer.name } : null,
    attendees: ev.attendees.slice(0, 100).map((a) => ({ email: a.email, name: a.name, status: a.status ?? null })),
    status: ev.status,
    recurring: ev.recurring,
    url: ev.url,
    me: me ? { email: me.email, status: me.status ?? null } : null,
    rsvp: msg.rsvp ?? null,
    canReply: msg.direction === 'in' && ev.method === 'REQUEST' && ev.status !== 'CANCELLED' && !!ev.organizer?.email && !!ev.uid && organizerSent(ev, msg),
  };
}

const VERB: Record<Rsvp, string> = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' };
const SENTENCE: Record<Rsvp, string> = { ACCEPTED: 'has accepted this invitation', TENTATIVE: 'might attend', DECLINED: 'has declined this invitation' };

/** Answer an invitation: a REPLY to the organizer, from the address that was invited. */
export async function replyToInvite(userId: number, messageId: number, status: Rsvp, comment = '', sentBy?: number) {
  const loaded = await loadEvent(userId, messageId);
  if (!loaded) throw new Error('This message has no invitation');
  const { ev, msg } = loaded;
  if (msg.direction !== 'in' || ev.method !== 'REQUEST' || ev.status === 'CANCELLED') throw new Error('This invitation can’t be answered');
  if (!ev.organizer?.email || !ev.uid) throw new Error('This invitation has no organizer to answer');
  if (!organizerSent(ev, msg)) throw new Error('This invitation wasn’t sent by its organizer');
  const user = getUser(userId)!;
  const ids = identities(userId);
  const me = myAttendee(userId, ev, msg.delivered_to);
  // Answer from the invited address when it's one this person can send from.
  const from = ids.find((i) => i.address.toLowerCase() === me?.email) ?? ids.find((i) => i.address.toLowerCase() === (msg.delivered_to ?? '').toLowerCase()) ?? ids.find((i) => i.kind === 'mailbox') ?? ids[0];
  if (!from) throw new Error('You have no address you can send from');
  const attendee = { email: me?.email ?? from.address.toLowerCase(), name: from.name || user.name };
  const ics = buildReply(ev, attendee, status, Date.now(), comment);
  const who = escapeHtml(attendee.name || attendee.email);
  const html = `<p>${who} ${SENTENCE[status]}${ev.summary ? `: <b>${escapeHtml(ev.summary)}</b>` : ''}.</p>${comment.trim() ? `<p>${escapeHtml(comment.trim())}</p>` : ''}`;
  const draft = await saveDraft(userId, {
    from: from.address,
    to: [{ address: ev.organizer.email, name: ev.organizer.name }],
    subject: `${VERB[status]}: ${ev.summary || 'Invitation'}`,
    html,
    replyToId: messageId,
  });
  await sendDraft(userId, draft, { undoSeconds: 0, calendar: { method: 'REPLY', content: ics }, sentBy });
  run('UPDATE messages SET rsvp = ? WHERE id = ?', [status, messageId]);
  return { status, to: ev.organizer.email };
}

/** The event as a file, for "Add to calendar" in another app. */
export async function inviteFile(userId: number, messageId: number): Promise<{ ics: string; summary: string } | null> {
  const loaded = await loadEvent(userId, messageId);
  return loaded ? { ics: buildIcsFile(loaded.ev), summary: loaded.ev.summary } : null;
}

/** The download response for a .ics file, named after the event. */
export function icsDownload(ics: string, summary: string): Response {
  const name = (summary || 'event').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'event';
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.ics"` } });
}

// ── The Calendar page ───────────────────────────────────────────────────────

/** What one invitation email says, for the calendar (JSON in messages.invite; '' when it has none). */
interface InviteFacts {
  /** The event's UID, plus which occurrence when the email is about one occurrence of a repeating event. */
  key: string;
  summary: string;
  location: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  cancelled: boolean;
  sequence: number;
  recurring: boolean;
  /** The answer the invitation itself records for this person (one given in another app). */
  me: string | null;
}

/** Invitations, announcements and cancellations go on the calendar; replies don't. */
const ON_CALENDAR = new Set(['REQUEST', 'PUBLISH', 'CANCEL']);
const ANSWERS = new Set<string>(['ACCEPTED', 'TENTATIVE', 'DECLINED']);
/** isCalendarType in SQL (idx_attachments_calendar covers it). */
const CALENDAR_PART = `(a.content_type LIKE 'text/calendar%' OR a.content_type LIKE 'application/ics%' OR a.filename LIKE '%.ics')`;
const READ_BATCH = 100;

async function inviteColumn(userId: number, messageId: number): Promise<string> {
  const loaded = await loadEvent(userId, messageId).catch((err) => {
    log.warn(`Couldn't read the invitation in message ${messageId}`, err);
    throw err; // A transient blob failure must not permanently cache 'no invitation'.
  });
  const ev = loaded?.ev;
  if (!loaded || !ev || (ev.start === null && ev.method !== 'CANCEL') || loaded.msg.direction !== 'in' || !ON_CALENDAR.has(ev.method) || !organizerSent(ev, loaded.msg)) return '';
  const occurrence = ev.props.find((p) => p.name === 'RECURRENCE-ID')?.value.trim();
  const facts: InviteFacts = {
    key: JSON.stringify([ev.uid || `message:${messageId}`, ev.organizer?.email ?? loaded.msg.from_addr.toLowerCase(), occurrence ?? '']),
    summary: ev.summary.slice(0, 300),
    location: ev.location.slice(0, 300),
    start: ev.start,
    end: ev.start === null ? null : Math.max(ev.end ?? ev.start, ev.start),
    allDay: ev.allDay,
    cancelled: ev.method === 'CANCEL' || ev.status === 'CANCELLED',
    sequence: ev.sequence,
    recurring: ev.recurring,
    me: myAttendee(userId, ev, loaded.msg.delivered_to)?.status ?? null,
  };
  return JSON.stringify(facts);
}

/**
 * Read invitations the calendar hasn't seen yet into messages.invite, newest
 * first, for up to `budgetMs`. True while more remain (a mailbox's first visit
 * to the calendar, or a big import), so the page asks again.
 */
async function readNewInvites(userId: number, budgetMs = 2000): Promise<boolean> {
  const started = Date.now();
  const rows = all<{ id: number }>(
    `SELECT DISTINCT m.id, m.date FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.user_id = ? AND ${CALENDAR_PART} AND m.invite IS NULL ORDER BY m.date DESC LIMIT ?`,
    [userId, READ_BATCH],
  );
  for (const r of rows) {
    if (Date.now() - started > budgetMs) return true;
    run('UPDATE messages SET invite = ? WHERE id = ?', [await inviteColumn(userId, r.id), r.id]);
  }
  return rows.length === READ_BATCH;
}

export interface CalendarEventRow {
  id: number;
  user_id: number;
  title: string;
  all_day: number;
  start_at: number;
  end_at: number;
  location: string;
  notes: string;
  created_at: number;
}

/** Whether an event touches [from, to); one with no length still counts at its start. */
const overlaps = (start: number, end: number, from: number, to: number) => start < to && Math.max(end, start + 1) > from;

/**
 * Everything on the calendar between `from` and `to`: the person's own events,
 * and the invitations in their mail (outside Spam and Trash), one per event as
 * its newest email has it, with the answer they last gave.
 */
export async function calendarEvents(userId: number, from: number, to: number): Promise<{ events: CalendarItem[]; more: boolean }> {
  const more = await readNewInvites(userId);
  const own = all<CalendarEventRow>('SELECT * FROM calendar_events WHERE user_id = ? AND start_at < ? AND MAX(end_at, start_at + 1) > ?', [userId, to, from]).map(
    (r): CalendarItem => ({ id: r.id, title: r.title, start: r.start_at, end: r.end_at, allDay: !!r.all_day, location: r.location, notes: r.notes, invite: null }),
  );
  // shortcut: reads every invitation in the mailbox on each load; keep start/end in their own columns if mailboxes collect many thousands.
  const rows = all<{ id: number; thread_id: number; invite: string; rsvp: string | null }>(
    `SELECT id, thread_id, invite, rsvp FROM messages WHERE user_id = ? AND invite <> '' AND folder NOT IN ('spam','trash','drafts') ORDER BY date, id`,
    [userId],
  );
  const latest = new Map<string, { row: (typeof rows)[number]; facts: InviteFacts; answer: string | null }>();
  for (const row of rows) {
    let facts: InviteFacts;
    try {
      facts = JSON.parse(row.invite) as InviteFacts;
    } catch {
      continue;
    }
    const seen = latest.get(facts.key);
    const answer = row.rsvp ?? seen?.answer ?? (facts.cancelled ? seen?.facts.me : null) ?? null;
    // A later email updates the event, unless it's an older version of it.
    if (!seen || facts.sequence >= seen.facts.sequence) {
      // A cancellation may identify an event without repeating its date or title.
      if (facts.cancelled && seen && facts.start === null) {
        facts = {
          ...seen.facts, ...facts, start: seen.facts.start, end: seen.facts.end,
          allDay: seen.facts.allDay, summary: facts.summary || seen.facts.summary,
          location: facts.location || seen.facts.location, recurring: seen.facts.recurring,
        };
      }
      latest.set(facts.key, { row, facts, answer });
    } else {
      seen.answer = answer;
      // A delayed older invitation can supply dates omitted by a cancellation already received.
      if (seen.facts.cancelled && seen.facts.start === null && facts.start !== null) {
        seen.facts = {
          ...facts, ...seen.facts, start: facts.start, end: facts.end, allDay: facts.allDay,
          summary: seen.facts.summary || facts.summary, location: seen.facts.location || facts.location,
          me: seen.facts.me ?? facts.me,
        };
      }
    }
  }
  const invites: CalendarItem[] = [];
  for (const { row, facts: f, answer } of latest.values()) {
    // shortcut: a repeating invitation shows its first occurrence only; expand its RRULE here if people need the rest.
    if (f.start === null || f.end === null || !overlaps(f.start, f.end, from, to)) continue;
    const given = answer ?? f.me;
    invites.push({
      id: null,
      title: f.summary,
      start: f.start,
      end: f.end,
      allDay: f.allDay,
      location: f.location,
      notes: '',
      invite: { messageId: row.id, threadId: row.thread_id, answer: given && ANSWERS.has(given) ? (given as Rsvp) : null, cancelled: f.cancelled, recurring: f.recurring },
    });
  }
  return { events: [...own, ...invites].sort((a, b) => a.start - b.start), more };
}

/** An event the person added, as a .ics file. */
export function eventFile(row: CalendarEventRow, domain: string): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
  const text = (v: string) => escapeText(v.replace(/\r\n?/g, '\n'));
  const lines = [
    `UID:event-${row.id}-${row.created_at}@${domain}`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    row.all_day ? `DTSTART;VALUE=DATE:${day(row.start_at)}` : `DTSTART:${icsStamp(row.start_at)}`,
    row.all_day ? `DTEND;VALUE=DATE:${day(row.end_at)}` : `DTEND:${icsStamp(row.end_at)}`,
    `SUMMARY:${text(row.title)}`,
    ...(row.location ? [`LOCATION:${text(row.location)}`] : []),
    ...(row.notes ? [`DESCRIPTION:${text(row.notes)}`] : []),
  ];
  return buildIcsFile({ props: lines.map((l) => parseLine(l)!) });
}
