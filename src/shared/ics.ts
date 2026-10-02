/**
 * Just enough iCalendar (RFC 5545) to show a meeting invitation and answer
 * it: the first VEVENT of a calendar, with its times converted to UTC.
 */

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The original content line (unfolded), for copying into a reply. */
  raw: string;
}

export interface IcsPerson {
  email: string;
  name: string;
  status?: string;
  role?: string;
  rsvp?: boolean;
}

export interface CalendarEvent {
  method: string;
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** Start and end in ms since the epoch (UTC); for all-day events, midnight UTC of the dates. */
  start: number | null;
  end: number | null;
  allDay: boolean;
  /** The zone the organizer used, when given. */
  timeZone: string | null;
  organizer: IcsPerson | null;
  attendees: IcsPerson[];
  status: string;
  sequence: number;
  recurring: boolean;
  url: string | null;
  /** Content lines of the event, for building a reply. */
  props: IcsProperty[];
}

/** Undo RFC 5545 line folding. */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim());
}

export function parseLine(line: string): IcsProperty | null {
  // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = '';
  inQuotes = false;
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes;
    if (c === ';' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value, raw: line };
}

export const unescapeText = (v: string) => v.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1');
export const escapeText = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

const mailto = (v: string) => v.replace(/^mailto:/i, '').trim().toLowerCase();

/** Windows zone names Outlook and Exchange use, to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Mexico Standard Time': 'America/Mexico_City',
  'Central America Standard Time': 'America/Guatemala',
  'Canada Central Standard Time': 'America/Regina',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

function ianaZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const clean = tzid.replace(/^\/[^/]+\/[^/]+\//, '').trim(); // "/mozilla.org/20050126_1/Europe/Berlin"
  const candidate = WINDOWS_ZONES[clean] ?? clean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

/** Offset of a zone at an instant, in ms (local minus UTC). */
function zoneOffset(ts: number, zone: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** A wall-clock time in a zone, as UTC. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let ts = guess - zoneOffset(guess, zone);
  ts = guess - zoneOffset(ts, zone); // settle across a DST change
  return ts;
}

/** "+0100" / "-0530" → ms. */
function parseOffset(v: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})/.exec(v.trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
}

interface ParsedTime {
  ts: number | null;
  allDay: boolean;
  zone: string | null;
}

function parseTime(p: IcsProperty | undefined, fallbackOffsets: Map<string, number>): ParsedTime {
  if (!p) return { ts: null, allDay: false, zone: null };
  const v = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || p.params.VALUE === 'DATE') {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return { ts: null, allDay: true, zone: null };
    return { ts: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true, zone: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return { ts: null, allDay: false, zone: null };
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { ts: Date.UTC(y, mo, d, h, mi, s), allDay: false, zone: 'UTC' };
  const tzid = p.params.TZID;
  const zone = ianaZone(tzid);
  if (zone) return { ts: zonedToUtc(y, mo, d, h, mi, s, zone), allDay: false, zone };
  // An unknown zone name: use the offset its VTIMEZONE gives (standard time).
  const offset = tzid ? fallbackOffsets.get(tzid) : undefined;
  if (offset !== undefined) return { ts: Date.UTC(y, mo, d, h, mi, s) - offset, allDay: false, zone: tzid ?? null };
  // Floating time: no zone at all. Show it as UTC rather than guess.
  return { ts: Date.UTC(y, mo, d, h, mi, s), allDay: false, zone: null };
}

/** "PT1H30M" / "P1D" → ms. */
function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  return (m[1] === '-' ? -1 : 1) * ((n(2) * 7 + n(3)) * 86_400 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000;
}

function person(p: IcsProperty): IcsPerson {
  return {
    email: mailto(p.value),
    name: p.params.CN ?? '',
    status: p.params.PARTSTAT?.toUpperCase(),
    role: p.params.ROLE?.toUpperCase(),
    rsvp: p.params.RSVP ? p.params.RSVP.toUpperCase() === 'TRUE' : undefined,
  };
}

/** The first event in an iCalendar file, or null. */
export function parseIcs(text: string): CalendarEvent | null {
  const lines = unfold(text);
  let method = '';
  let inEvent = false;
  let depth = 0;
  let event: IcsProperty[] | null = null;
  const offsets = new Map<string, number>();
  let tzid: string | null = null;
  let inStandard = false;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const what = p.value.toUpperCase().trim();
      if (what === 'VEVENT' && !event) {
        inEvent = true;
        depth = 0;
        event = [];
      } else if (inEvent) depth++;
      if (what === 'STANDARD') inStandard = true;
      continue;
    }
    if (p.name === 'END') {
      const what = p.value.toUpperCase().trim();
      if (what === 'VEVENT' && inEvent && depth === 0) inEvent = false;
      else if (inEvent) depth--;
      if (what === 'STANDARD') inStandard = false;
      if (what === 'VTIMEZONE') tzid = null;
      continue;
    }
    if (p.name === 'METHOD' && !inEvent) method = p.value.trim().toUpperCase();
    if (p.name === 'TZID' && !inEvent) tzid = p.value.trim();
    if (p.name === 'TZOFFSETTO' && inStandard && tzid) {
      const o = parseOffset(p.value);
      if (o !== null && !offsets.has(tzid)) offsets.set(tzid, o);
    }
    if (inEvent && depth === 0) event!.push(p);
  }
  if (!event) return null;
  const get = (n: string) => event!.find((p) => p.name === n);
  const start = parseTime(get('DTSTART'), offsets);
  let end = parseTime(get('DTEND') ?? get('DUE'), offsets);
  if (end.ts === null && start.ts !== null) {
    const dur = get('DURATION') ? parseDuration(get('DURATION')!.value) : null;
    end = { ...start, ts: dur !== null ? start.ts + dur : start.allDay ? start.ts + 86_400_000 : start.ts };
  }
  const urlFromText = (t: string) => /https:\/\/[^\s<>"]*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|jit\.si)[^\s<>"]*/i.exec(t)?.[0] ?? null;
  const description = unescapeText(get('DESCRIPTION')?.value ?? '');
  const location = unescapeText(get('LOCATION')?.value ?? '');
  const explicitUrl = get('URL')?.value.trim() || get('X-GOOGLE-CONFERENCE')?.value.trim() || null;
  return {
    method,
    uid: get('UID')?.value.trim() ?? '',
    summary: unescapeText(get('SUMMARY')?.value ?? '').trim(),
    description,
    location,
    start: start.ts,
    end: end.ts,
    allDay: start.allDay,
    timeZone: start.zone,
    organizer: get('ORGANIZER') ? person(get('ORGANIZER')!) : null,
    attendees: event.filter((p) => p.name === 'ATTENDEE').map(person),
    status: (get('STATUS')?.value ?? '').trim().toUpperCase(),
    sequence: Number(get('SEQUENCE')?.value ?? 0) || 0,
    recurring: !!get('RRULE') || !!get('RDATE'),
    url: (explicitUrl && /^https:\/\//i.test(explicitUrl) ? explicitUrl : null) ?? urlFromText(location) ?? urlFromText(description),
    props: event,
  };
}

/** Fold a content line at 75 octets. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const icsStamp = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export type Rsvp = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/** An iTIP REPLY (RFC 5546) from one attendee. */
export function buildReply(ev: CalendarEvent, attendee: { email: string; name: string }, status: Rsvp, now = Date.now(), comment = ''): string {
  const copy = ['UID', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'SEQUENCE', 'ORGANIZER', 'SUMMARY'];
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Wren//Mail//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REPLY', 'BEGIN:VEVENT'];
  for (const name of copy) {
    const p = ev.props.find((x) => x.name === name);
    if (p) lines.push(p.raw);
  }
  lines.push(`DTSTAMP:${icsStamp(now)}`);
  const cn = attendee.name ? `;CN="${attendee.name.replace(/"/g, "'")}"` : '';
  lines.push(`ATTENDEE;PARTSTAT=${status}${cn}:mailto:${attendee.email}`);
  if (comment.trim()) lines.push(`COMMENT:${escapeText(comment.trim())}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A one-event .ics file for "Add to calendar". */
export function buildIcsFile(ev: CalendarEvent): string {
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Wren//Mail//EN', 'VERSION:2.0', 'METHOD:PUBLISH', 'BEGIN:VEVENT'];
  for (const p of ev.props) if (!['ATTENDEE', 'METHOD'].includes(p.name)) lines.push(p.raw);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
