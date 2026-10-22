/** Dates for the Calendar page, in the browser's time zone. */
import type { CalendarItem } from '../../shared/types';

const DAY = 86_400_000;

/** The six weeks a month view shows: from the Sunday on or before the 1st. */
// shortcut: weeks start on Sunday; follow the locale (Intl.Locale weekInfo) or a setting if people ask.
export function monthGrid(year: number, month: number): Date[] {
  const lead = new Date(year, month, 1).getDay();
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - lead + i));
}

/** The midnight after a local day. */
export const nextDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

/** An event's span here. All-day events are dates (stored as UTC midnights) and keep their dates in every zone. */
export function localSpan(e: Pick<CalendarItem, 'start' | 'end' | 'allDay'>): { start: number; end: number } {
  if (!e.allDay) return { start: e.start, end: Math.max(e.end, e.start + 1) };
  const local = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
  };
  return { start: local(e.start), end: Math.max(local(e.end), local(e.start) + 1) };
}

const touches = (e: CalendarItem, from: number, to: number) => {
  const s = localSpan(e);
  return s.start < to && s.end > from;
};

/** The events on one day, all-day ones first. */
export function eventsOn(events: CalendarItem[], day: Date): CalendarItem[] {
  return events.filter((e) => touches(e, day.getTime(), nextDay(day).getTime())).sort((a, b) => Number(b.allDay) - Number(a.allDay) || localSpan(a).start - localSpan(b).start);
}

/** A month's events as a list: what hasn't ended yet, soonest first, then what's over. */
export function agenda(events: CalendarItem[], month: Date, now = Date.now()): { upcoming: CalendarItem[]; past: CalendarItem[] } {
  const list = events.filter((e) => touches(e, month.getTime(), new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime())).sort((a, b) => localSpan(a).start - localSpan(b).start);
  return { upcoming: list.filter((e) => localSpan(e).end > now), past: list.filter((e) => localSpan(e).end <= now) };
}

/** The add/edit form: dates as yyyy-mm-dd and times as hh:mm, local. */
export interface EventForm {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  notes: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function toForm(e: Pick<CalendarItem, 'title' | 'start' | 'end' | 'allDay' | 'location' | 'notes'>): EventForm {
  const span = localSpan(e);
  const start = new Date(span.start);
  // An all-day event ends at the midnight after its last day; the form shows the last day.
  const end = new Date(e.allDay ? span.end - 1 : e.end);
  return {
    title: e.title,
    allDay: e.allDay,
    startDate: dateValue(start),
    startTime: e.allDay ? '09:00' : timeValue(start),
    endDate: dateValue(end),
    endTime: e.allDay ? '10:00' : timeValue(end),
    location: e.location,
    notes: e.notes,
  };
}

/** What the API takes. An unfinished date or time gives NaN. */
export function fromForm(f: EventForm) {
  const utcDay = (v: string) => Date.parse(`${v}T00:00:00Z`);
  return {
    title: f.title.trim(),
    allDay: f.allDay,
    start: f.allDay ? utcDay(f.startDate) : new Date(`${f.startDate}T${f.startTime}`).getTime(),
    end: f.allDay ? utcDay(f.endDate) + DAY : new Date(`${f.endDate}T${f.endTime}`).getTime(),
    location: f.location.trim(),
    notes: f.notes,
  };
}

/** A new event on a day: an hour long, from the next full hour today or 9:00 on another day. */
export function newEvent(day: Date, now = new Date()): EventForm {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), dateValue(day) === dateValue(now) ? now.getHours() + 1 : 9);
  return toForm({ title: '', allDay: false, start: start.getTime(), end: start.getTime() + 3_600_000, location: '', notes: '' });
}
