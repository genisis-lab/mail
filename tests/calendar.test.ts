import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { toOutboundEmail } from '../src/server/mail/outbound';
import { buildReply, parseIcs, unfold } from '../src/shared/ics';
import type { CalendarItem } from '../src/shared/types';
import { agenda, eventsOn, fromForm, localSpan, monthGrid, newEvent, toForm } from '../src/web/lib/calendar';
import { harness, outbox } from './harness';

const h = harness();

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20261016T100000',
  'DTEND;TZID=America/Los_Angeles:20261016T110000',
  'DTSTAMP:20261001T120000Z',
  'ORGANIZER;CN=Maya Chen:mailto:maya@northwind.example',
  'UID:abc123@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=admin@wren.test;X-NUM-GUESTS=0:mailto:admin@wren.test',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Maya Chen:mailto:maya@northwind.example',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'DESCRIPTION:Agenda:\\n1. Roadmap\\, Q4\\n2. Hiring\\nJoin: https://meet.google.com/abc-defg-hij',
  'LOCATION:Room 4\\, 2nd floor',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Q4 roadmap review with a long title that will need folding at seventy-five octets',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function fold(text: string) {
  return text
    .split('\r\n')
    .map((l) => (l.length > 75 ? l.slice(0, 75) + '\r\n ' + l.slice(75) : l))
    .join('\r\n');
}

function imip(ics: string, method: string, subject: string) {
  return Buffer.from(
    [
      'From: Maya Chen <maya@northwind.example>',
      'To: admin@wren.test',
      `Subject: ${subject}`,
      `Message-ID: <${Math.random().toString(36).slice(2)}@northwind.example>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed"',
      '',
      '--mixed',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'You have been invited.',
      '--alt',
      `Content-Type: text/calendar; charset="UTF-8"; method=${method}`,
      'Content-Transfer-Encoding: 7bit',
      '',
      ics,
      '--alt--',
      '--mixed',
      'Content-Type: application/ics; name="invite.ics"',
      'Content-Disposition: attachment; filename="invite.ics"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(ics).toString('base64'),
      '--mixed--',
      '',
    ].join('\r\n'),
  );
}

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
});

describe('iCalendar parsing', () => {
  it('reads a Google invitation: zone, folding, escapes, people and the meeting link', () => {
    const ev = parseIcs(fold(GOOGLE))!;
    expect(ev.method).toBe('REQUEST');
    expect(ev.summary).toBe('Q4 roadmap review with a long title that will need folding at seventy-five octets');
    expect(new Date(ev.start!).toISOString()).toBe('2026-10-16T17:00:00.000Z'); // 10:00 PDT
    expect(ev.end! - ev.start!).toBe(3_600_000);
    expect(ev.timeZone).toBe('America/Los_Angeles');
    expect(ev.location).toBe('Room 4, 2nd floor');
    expect(ev.description).toMatch(/^Agenda:\n1\. Roadmap, Q4\n/);
    expect(ev.organizer).toMatchObject({ email: 'maya@northwind.example', name: 'Maya Chen' });
    expect(ev.attendees.map((a) => [a.email, a.status])).toEqual([
      ['admin@wren.test', 'NEEDS-ACTION'],
      ['maya@northwind.example', 'ACCEPTED'],
    ]);
    expect(ev.url).toBe('https://meet.google.com/abc-defg-hij');
    // The alarm's DESCRIPTION doesn't replace the event's.
    expect(ev.description).not.toMatch(/reminder/);
  });

  it('handles Outlook zone names, unknown zones, all-day events, durations and DST', () => {
    const outlook = parseIcs(['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID="Pacific Standard Time":20261216T090000', 'DTEND;TZID="Pacific Standard Time":20261216T093000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))!;
    expect(new Date(outlook.start!).toISOString()).toBe('2026-12-16T17:00:00.000Z'); // PST, UTC-8
    const custom = parseIcs(
      ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:My Office', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:y', 'DTSTART;TZID=My Office:20261016T100000', 'DURATION:PT1H30M', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
    )!;
    expect(new Date(custom.start!).toISOString()).toBe('2026-10-16T04:30:00.000Z');
    expect(custom.end! - custom.start!).toBe(90 * 60_000);
    const allDay = parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:z', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226', 'RRULE:FREQ=YEARLY', 'END:VEVENT', 'END:VCALENDAR'].join('\n'))!;
    expect(allDay).toMatchObject({ allDay: true, recurring: true, method: '' });
    expect(new Date(allDay.start!).toISOString()).toBe('2026-12-24T00:00:00.000Z');
    // The morning the clocks went forward in Berlin.
    const dst = parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'DTSTART;TZID=Europe/Berlin:20260329T033000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))!;
    expect(new Date(dst.start!).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(parseIcs('not a calendar')).toBeNull();
  });

  it('builds a reply with lines folded at 75 octets', () => {
    const ev = parseIcs(fold(GOOGLE))!;
    const reply = buildReply(ev, { email: 'admin@wren.test', name: 'Ada Admin' }, 'ACCEPTED', Date.UTC(2026, 9, 2, 8, 0, 0));
    expect(reply.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    const lines = unfold(reply);
    expect(lines).toContain('METHOD:REPLY');
    expect(lines).toContain('UID:abc123@google.com');
    expect(lines).toContain('DTSTAMP:20261002T080000Z');
    expect(lines).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN="Ada Admin":mailto:admin@wren.test');
    expect(lines.some((l) => l.startsWith('ORGANIZER;CN=Maya Chen:mailto:maya@northwind.example'))).toBe(true);
    expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1);
  });
});

describe('invitations in mail', () => {
  it('shows the invitation and sends the answer to the organizer', async () => {
    await ingest(imip(GOOGLE, 'REQUEST', 'Invitation: Q4 roadmap review'), { rcptTo: ['admin@wren.test'], source: 'resend' });
    const msg = get<any>(`SELECT id, thread_id FROM messages WHERE subject = 'Invitation: Q4 roadmap review'`);
    const detail = (await h.call('GET', `/api/mail/messages/${msg.id}`)).body;
    expect(detail).toMatchObject({ hasInvite: true, rsvp: null });
    const invite = (await h.call('GET', `/api/mail/messages/${msg.id}/invite`)).body.invite;
    expect(invite).toMatchObject({ method: 'REQUEST', canReply: true, me: { email: 'admin@wren.test', status: 'NEEDS-ACTION' }, organizer: { email: 'maya@northwind.example' } });

    const r = await h.call('POST', `/api/mail/messages/${msg.id}/invite/reply`, { response: 'accepted', comment: 'See you there' });
    expect(r.body).toEqual({ status: 'ACCEPTED', to: 'maya@northwind.example' });
    expect((await h.call('GET', `/api/mail/messages/${msg.id}`)).body.rsvp).toBe('ACCEPTED');

    const job = (await outbox('user')).find((j) => j.subject.startsWith('Accepted: Q4 roadmap review'))!;
    expect(job.to).toEqual(['maya@northwind.example']);
    expect(job.raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/);
    const cal = Buffer.from(/method=REPLY\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(job.raw)![1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(unfold(cal)).toEqual(expect.arrayContaining(['METHOD:REPLY', 'ATTENDEE;PARTSTAT=ACCEPTED;CN="Ada Admin":mailto:admin@wren.test', 'COMMENT:See you there']));
    // Threaded with the invitation, and in Sent.
    const sent = get<any>(`SELECT thread_id, folder FROM messages WHERE subject LIKE 'Accepted:%'`);
    expect(sent).toEqual({ thread_id: msg.thread_id, folder: 'sent' });
    // JSON-API providers (Resend…) get the calendar part with its method.
    const email = await toOutboundEmail(Buffer.from(job.raw), { from: 'admin@wren.test', to: ['maya@northwind.example'] });
    expect(email.attachments.find((a) => a.contentType.startsWith('text/calendar'))?.contentType).toBe('text/calendar; method=REPLY');

    const ics = await h.request(`/api/mail/messages/${msg.id}/invite.ics`);
    expect(ics.headers.get('content-type')).toMatch(/text\/calendar/);
    const text = await ics.text();
    expect(text).toMatch(/METHOD:PUBLISH/);
    expect(text).not.toMatch(/ATTENDEE/);
  });

  it('shows cancellations without answer buttons', async () => {
    const cancelled = GOOGLE.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('STATUS:CONFIRMED', 'STATUS:CANCELLED');
    await ingest(imip(cancelled, 'CANCEL', 'Canceled: Q4 roadmap review'), { rcptTo: ['admin@wren.test'], source: 'resend' });
    const msg = get<any>(`SELECT id FROM messages WHERE subject = 'Canceled: Q4 roadmap review'`);
    const invite = (await h.call('GET', `/api/mail/messages/${msg.id}/invite`)).body.invite;
    expect(invite).toMatchObject({ method: 'CANCEL', status: 'CANCELLED', canReply: false });
    expect((await h.call('POST', `/api/mail/messages/${msg.id}/invite/reply`, { response: 'declined' })).status).toBe(400);
    const plain = get<any>(`SELECT id FROM messages WHERE subject NOT LIKE '%roadmap%' AND direction = 'in' LIMIT 1`);
    expect((await h.call('GET', `/api/mail/messages/${plain.id}/invite`)).body.invite).toBeNull();
  });
});

describe('the Calendar page', () => {
  const PW = 'a very long password';
  const range = (from: number, to: number) => `/api/calendar?from=${from}&to=${to}`;
  const OCTOBER = range(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
  const NOVEMBER = range(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
  const events = async (url = OCTOBER, headers?: Record<string, string>) => (await h.call('GET', url, undefined, headers)).body.events as CalendarItem[];
  const named = (list: CalendarItem[], title: string) => list.filter((e) => e.title === title);
  const lunch = { title: 'Lunch, with Bo', start: Date.UTC(2026, 9, 21, 12), end: Date.UTC(2026, 9, 21, 13), location: 'Café Rose', notes: 'Bring the book' };
  const invite = (uid: string, lines: string[], method = 'REQUEST') =>
    ['BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${uid}`, 'ORGANIZER;CN=Maya Chen:mailto:maya@northwind.example', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const deliver = async (ics: string, subject: string, method = 'REQUEST') => {
    await ingest(imip(ics, method, subject), { rcptTo: ['admin@wren.test'], source: 'resend' });
    return get<{ id: number; thread_id: number }>('SELECT id, thread_id FROM messages WHERE subject = ? ORDER BY id DESC', [subject])!;
  };
  const me = (status: string) => `ATTENDEE;PARTSTAT=${status};RSVP=TRUE:mailto:admin@wren.test`;

  it('adds, edits, downloads and deletes your own events, and checks what it is given', async () => {
    h.as('admin');
    const created = await h.call('POST', '/api/calendar/events', lunch);
    expect(created.status).toBe(200);
    const id = created.body.id as number;
    expect(named(await events(), 'Lunch, with Bo')).toEqual([{ id, ...lunch, allDay: false, invite: null }]);
    // All-day: from UTC midnight of the first day to UTC midnight after the last.
    const trip = await h.call('POST', '/api/calendar/events', { title: 'Trip', allDay: true, start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 26) });
    expect(trip.status).toBe(200);

    const bad = async (patch: Record<string, unknown>) => (await h.call('POST', '/api/calendar/events', { ...lunch, ...patch })).body;
    expect(await bad({ title: '   ' })).toMatchObject({ code: 'validation', error: 'title: Add a title' });
    expect((await bad({ end: lunch.start - 1 })).error).toBe('end: The event can’t end before it starts');
    expect((await bad({ allDay: true })).error).toMatch(/^start: An all-day event/);
    expect((await bad({ start: 'tomorrow' })).code).toBe('validation');
    expect((await bad({ notes: 'x'.repeat(10_001) })).code).toBe('validation');
    expect((await h.call('GET', range(10, 5))).status).toBe(400);
    expect((await h.call('GET', range(0, 101 * 86_400_000))).status).toBe(400);
    expect((await h.call('GET', '/api/calendar?from=soon&to=later')).status).toBe(400);

    expect((await h.call('PUT', `/api/calendar/events/${id}`, { ...lunch, title: 'Lunch with Bo and Ana', location: '' })).status).toBe(200);
    expect(named(await events(), 'Lunch with Bo and Ana')[0]).toMatchObject({ id, location: '', notes: 'Bring the book' });
    expect((await h.call('PUT', `/api/calendar/events/${id}`, { ...lunch, end: 0 })).status).toBe(400);

    const ics = await h.request(`/api/calendar/events/${id}/event.ics`);
    expect(ics.headers.get('content-type')).toMatch(/^text\/calendar/);
    expect(ics.headers.get('content-disposition')).toBe('attachment; filename="Lunch with Bo and Ana.ics"');
    const lines = unfold(await ics.text());
    expect(lines).toEqual(expect.arrayContaining(['METHOD:PUBLISH', 'DTSTART:20261021T120000Z', 'DTEND:20261021T130000Z', 'SUMMARY:Lunch with Bo and Ana', 'DESCRIPTION:Bring the book']));
    expect(lines.some((l) => l.startsWith('LOCATION'))).toBe(false);
    const tripLines = unfold(await (await h.request(`/api/calendar/events/${trip.body.id}/event.ics`)).text());
    expect(tripLines).toEqual(expect.arrayContaining(['DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261026']));
    // What Wren reads back from its own file.
    expect(parseIcs(tripLines.join('\r\n'))).toMatchObject({ summary: 'Trip', allDay: true, start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 26) });

    expect((await h.call('DELETE', `/api/calendar/events/${id}`)).status).toBe(200);
    expect(named(await events(), 'Lunch with Bo and Ana')).toEqual([]);
    expect((await h.call('DELETE', `/api/calendar/events/${id}`)).status).toBe(404);
    expect((await h.call('PUT', `/api/calendar/events/${id}`, lunch)).status).toBe(404);
  });

  it('shows the invitations in your mail, one per event, with your answer', async () => {
    h.as('admin');
    // Accepted, then cancelled (earlier tests): struck through, still with the answer.
    expect((await h.call('GET', OCTOBER)).body.more).toBe(false);
    const roadmap = named(await events(), 'Q4 roadmap review with a long title that will need folding at seventy-five octets');
    const cancel = get<{ id: number; thread_id: number }>(`SELECT id, thread_id FROM messages WHERE subject = 'Canceled: Q4 roadmap review'`)!;
    expect(roadmap).toEqual([
      {
        id: null,
        title: roadmap[0].title,
        start: Date.UTC(2026, 9, 16, 17),
        end: Date.UTC(2026, 9, 16, 18),
        allDay: false,
        location: 'Room 4, 2nd floor',
        notes: '',
        invite: { messageId: cancel.id, threadId: cancel.thread_id, answer: 'ACCEPTED', cancelled: true, recurring: false },
      },
    ]);

    const standup = await deliver(invite('standup@northwind', ['DTSTART:20261020T090000Z', 'DTEND:20261020T091500Z', 'SUMMARY:Standup', me('NEEDS-ACTION')]), 'Invitation: Standup');
    expect(named(await events(), 'Standup')[0].invite).toMatchObject({ messageId: standup.id, threadId: standup.thread_id, answer: null, cancelled: false });
    await h.call('POST', `/api/mail/messages/${standup.id}/invite/reply`, { response: 'tentative' });
    expect(named(await events(), 'Standup')[0].invite?.answer).toBe('TENTATIVE');

    // Answered in another app: the invitation itself says so.
    await deliver(invite('offsite@northwind', ['DTSTART;VALUE=DATE:20261029', 'SUMMARY:Offsite', me('ACCEPTED')]), 'Invitation: Offsite');
    expect(named(await events(), 'Offsite')[0]).toMatchObject({ allDay: true, start: Date.UTC(2026, 9, 29), end: Date.UTC(2026, 9, 30), invite: { answer: 'ACCEPTED' } });

    // Moved: the newer version wins, even if an older copy arrives after it.
    await deliver(invite('review@northwind', ['SEQUENCE:1', 'DTSTART:20261022T150000Z', 'DTEND:20261022T160000Z', 'SUMMARY:Design review', me('NEEDS-ACTION')]), 'Updated invitation: Design review');
    await deliver(invite('review@northwind', ['SEQUENCE:0', 'DTSTART:20261021T150000Z', 'DTEND:20261021T160000Z', 'SUMMARY:Design review', me('NEEDS-ACTION')]), 'Invitation: Design review');
    expect(named(await events(), 'Design review').map((e) => e.start)).toEqual([Date.UTC(2026, 9, 22, 15)]);

    // A repeating invitation: its first time only.
    await deliver(invite('weekly@northwind', ['DTSTART:20261005T100000Z', 'DTEND:20261005T103000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly sync', me('NEEDS-ACTION')]), 'Invitation: Weekly sync');
    expect(named(await events(), 'Weekly sync')).toHaveLength(1);
    expect(named(await events(), 'Weekly sync')[0].invite?.recurring).toBe(true);
    expect(named(await events(NOVEMBER), 'Weekly sync')).toEqual([]);

    // Someone's answer to an invitation isn't an event; neither is one in Trash.
    await deliver(invite('party@northwind', ['DTSTART:20261023T180000Z', 'SUMMARY:Party', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:maya@northwind.example'], 'REPLY'), 'Accepted: Party', 'REPLY');
    const binned = await deliver(invite('binned@northwind', ['DTSTART:20261023T180000Z', 'SUMMARY:Binned', me('NEEDS-ACTION')]), 'Invitation: Binned');
    expect(named(await events(), 'Binned')).toHaveLength(1);
    await h.call('POST', '/api/mail/threads/actions', { threadIds: [binned.thread_id], action: { type: 'trash' } });
    const list = await events();
    expect(named(list, 'Party')).toEqual([]);
    expect(named(list, 'Binned')).toEqual([]);
    expect(list.map((e) => e.start)).toEqual([...list.map((e) => e.start)].sort((a, b) => a - b));
    expect(named(await events(NOVEMBER), 'Standup')).toEqual([]);
  });

  it('keeps organizers separate and applies cancellations without a repeated date', async () => {
    h.as('admin');
    const base = invite('shared-uid', ['SEQUENCE:0', 'DTSTART:20261025T120000Z', 'DTEND:20261025T130000Z', 'SUMMARY:Original meeting', me('ACCEPTED')]);
    await deliver(base, 'Organizer one');
    await deliver(base.replaceAll('maya@northwind.example', 'other@example.org').replace('Original meeting', 'Other meeting'), 'Organizer two');
    expect(named(await events(), 'Original meeting')).toHaveLength(1);
    expect(named(await events(), 'Other meeting')).toHaveLength(1);
    await deliver(invite('shared-uid', ['SEQUENCE:1'], 'CANCEL'), 'Cancelled without dates', 'CANCEL');
    const cancelled = named(await events(), 'Original meeting')[0];
    expect(cancelled).toMatchObject({ start: Date.UTC(2026, 9, 25, 12), end: Date.UTC(2026, 9, 25, 13), invite: { cancelled: true, answer: 'ACCEPTED' } });
    expect(named(await events(), 'Other meeting')[0].invite?.cancelled).toBe(false);
    await deliver(invite('late-uid', ['SEQUENCE:2'], 'CANCEL'), 'Cancellation arrives first', 'CANCEL');
    await deliver(base.replace('shared-uid', 'late-uid').replace('Original meeting', 'Delayed original'), 'Original arrives later');
    expect(named(await events(), 'Delayed original')[0]).toMatchObject({ start: Date.UTC(2026, 9, 25, 12), invite: { cancelled: true, answer: 'ACCEPTED' } });
  });

  it('keeps each mailbox’s calendar to itself', async () => {
    h.as('admin');
    await h.call('POST', '/api/admin/users', { email: 'sam@wren.test', name: 'Sam Lee', password: PW });
    const box = (await h.call('POST', '/api/admin/shared-mailboxes', { address: 'team@wren.test', name: 'Team', members: [{ userId: 1, canSend: false }] })).body.mailbox.id;
    const mine = (await h.call('POST', '/api/calendar/events', { ...lunch, title: 'Dentist' })).body.id;
    const as = { 'X-Wren-Mailbox': String(box) };
    expect((await h.call('POST', '/api/calendar/events', { ...lunch, title: 'Team lunch' }, as)).status).toBe(200);
    expect(named(await events(OCTOBER, as), 'Team lunch')).toHaveLength(1);
    expect(named(await events(OCTOBER, as), 'Dentist')).toEqual([]);
    expect(named(await events(), 'Team lunch')).toEqual([]);

    await h.login('sam@wren.test', PW, 'sam');
    const theirs = await events();
    expect(theirs.map((e) => e.title)).not.toContain('Dentist');
    expect(theirs.filter((e) => e.invite)).toEqual([]);
    expect((await h.call('PUT', `/api/calendar/events/${mine}`, { ...lunch, title: 'Mine now' })).status).toBe(404);
    expect((await h.call('DELETE', `/api/calendar/events/${mine}`)).status).toBe(404);
    expect((await h.request(`/api/calendar/events/${mine}/event.ics`)).status).toBe(404);
    expect((await h.call('GET', OCTOBER, undefined, as)).status).toBe(403);
    h.as('admin');
    expect(named(await events(), 'Dentist')).toHaveLength(1);
    h.as('nobody');
    expect((await h.call('GET', OCTOBER)).status).toBe(401);
  });
});

describe('calendar dates in the browser', () => {
  it('lays out six weeks from the Sunday before the 1st', () => {
    const days = monthGrid(2026, 9);
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0);
    expect(days.findIndex((d) => d.getMonth() === 9 && d.getDate() === 1)).toBe(4); // Oct 1, 2026 is a Thursday
    // One day apart, through any change of the clocks.
    for (let i = 1; i < 42; i++) expect(new Date(days[i - 1].getFullYear(), days[i - 1].getMonth(), days[i - 1].getDate() + 1).getTime()).toBe(days[i].getTime());
  });

  it('keeps all-day events on their dates and splits a month into coming up and earlier', () => {
    const base = { id: 1, location: '', notes: '', invite: null };
    const trip: CalendarItem = { ...base, title: 'Trip', allDay: true, start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 26) };
    const call: CalendarItem = { ...base, id: 2, title: 'Call', allDay: false, start: new Date(2026, 9, 25, 9).getTime(), end: new Date(2026, 9, 25, 10).getTime() };
    expect(localSpan(trip)).toEqual({ start: new Date(2026, 9, 24).getTime(), end: new Date(2026, 9, 26).getTime() });
    expect(eventsOn([call, trip], new Date(2026, 9, 25)).map((e) => e.title)).toEqual(['Trip', 'Call']);
    expect(eventsOn([call, trip], new Date(2026, 9, 23))).toEqual([]);
    expect(eventsOn([call, trip], new Date(2026, 9, 26))).toEqual([]);
    const { upcoming, past } = agenda([call, trip], new Date(2026, 9, 1), new Date(2026, 9, 25, 12).getTime());
    expect(upcoming.map((e) => e.title)).toEqual(['Trip']);
    expect(past.map((e) => e.title)).toEqual(['Call']);
    expect(agenda([call, trip], new Date(2026, 10, 1))).toEqual({ upcoming: [], past: [] });
  });

  it('turns the form into what the API takes and back', () => {
    const trip = { title: 'Trip', allDay: true, start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 26), location: 'Lisbon', notes: '' };
    expect(toForm(trip)).toMatchObject({ startDate: '2026-10-24', endDate: '2026-10-25' });
    expect(fromForm(toForm(trip))).toEqual(trip);
    const call = { title: 'Call', allDay: false, start: new Date(2026, 9, 25, 9, 30).getTime(), end: new Date(2026, 9, 25, 10).getTime(), location: '', notes: 'Agenda' };
    expect(toForm(call)).toMatchObject({ startDate: '2026-10-25', startTime: '09:30', endTime: '10:00' });
    expect(fromForm(toForm(call))).toEqual(call);
    expect(fromForm({ ...toForm(call), startTime: '' }).start).toBeNaN();
    expect(newEvent(new Date(2026, 9, 25), new Date(2026, 9, 21, 14, 20))).toMatchObject({ startDate: '2026-10-25', startTime: '09:00', endTime: '10:00', allDay: false });
    expect(newEvent(new Date(2026, 9, 21), new Date(2026, 9, 21, 14, 20))).toMatchObject({ startTime: '15:00', endTime: '16:00' });
  });
});
