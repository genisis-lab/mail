import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { toOutboundEmail } from '../src/server/mail/outbound';
import { buildReply, parseIcs, unfold } from '../src/shared/ics';
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
