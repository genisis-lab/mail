/**
 * Meeting invitations in mail: read the iCalendar part of a message, show it
 * as an event, and answer it (Yes / Maybe / No) with an iTIP REPLY to the
 * organizer, the way Gmail and Outlook do.
 */
import { buildIcsFile, buildReply, parseIcs, type CalendarEvent, type Rsvp } from '../../shared/ics.js';
import { all, get, run } from '../db/index.js';
import { escapeHtml } from '../mail/compose.js';
import { getBlob } from '../mail/blobs.js';
import { saveDraft, sendDraft } from '../mail/send.js';
import { getUser, identities, userAddresses } from './users.js';

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
  const msg = get<any>('SELECT id, user_id, thread_id, direction, folder, delivered_to, from_addr, rsvp FROM messages WHERE id = ? AND user_id = ?', [messageId, userId]);
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
    canReply: msg.direction === 'in' && ev.method === 'REQUEST' && ev.status !== 'CANCELLED' && !!ev.organizer?.email && !!ev.uid,
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
