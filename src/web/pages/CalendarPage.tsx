/** Calendar: a month of events from invitations in your mail, and the ones you add yourself. */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Download, MapPin, Plus, Repeat } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { CalendarItem } from '../../shared/types';
import { api, linkUrl, qs } from '../lib/api';
import { agenda, eventsOn, fromForm, monthGrid, newEvent, nextDay, toForm, type EventForm } from '../lib/calendar';
import { PHONE, useMediaQuery } from '../lib/media';
import { useToast } from '../components/toast';
import { Button, cx, Empty, Field, IconButton, Input, Modal, Spinner, Switch, Textarea } from '../components/ui';
import { when } from './mail/InviteCard';

const ANSWER: Record<string, string> = { ACCEPTED: 'Yes', TENTATIVE: 'Maybe', DECLINED: 'No' };
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const longDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
/** Events a day cell shows before "N more". */
const CHIPS = 3;

const titleOf = (e: CalendarItem) => e.title || '(no title)';

function answerText(inv: NonNullable<CalendarItem['invite']>): string {
  if (inv.cancelled) return 'Cancelled';
  return inv.answer ? `You replied: ${ANSWER[inv.answer]}` : 'Not answered yet';
}

/** An event in words, for screen readers and tooltips. */
const describe = (e: CalendarItem) => [titleOf(e), when(e).line, e.invite && answerText(e.invite).toLowerCase()].filter(Boolean).join(', ');

/** The event as a .ics file: the invitation's own, or one made for yours. */
const icsUrl = (e: CalendarItem) => linkUrl(e.invite ? `/api/mail/messages/${e.invite.messageId}/invite.ics` : `/api/calendar/events/${e.id}/event.ics`);

const linkButton = 'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-fg hover:bg-hover';

function EventChip({ e, onOpen }: { e: CalendarItem; onOpen: (e: CalendarItem) => void }) {
  const inv = e.invite;
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      title={describe(e)}
      aria-label={describe(e)}
      className={cx(
        'flex w-full items-center gap-1.5 rounded px-1.5 py-px text-left text-xs',
        e.allDay ? 'bg-accent-soft text-accent-ink hover:brightness-95' : 'hover:bg-hover',
        // Not answered yet: an outline, like Google Calendar.
        inv && !inv.answer && !inv.cancelled && 'border border-dashed border-line-strong',
        (inv?.cancelled || inv?.answer === 'DECLINED') && 'text-muted',
      )}
    >
      {!e.allDay && <span className={cx('size-1.5 shrink-0 rounded-full', inv?.cancelled || inv?.answer === 'DECLINED' ? 'bg-faint' : 'bg-accent')} aria-hidden />}
      {!e.allDay && <span className="shrink-0 text-muted">{time.format(e.start)}</span>}
      <span className={cx('truncate', inv?.cancelled && 'line-through')}>{titleOf(e)}</span>
    </button>
  );
}

function AgendaRow({ e, onOpen }: { e: CalendarItem; onOpen: (e: CalendarItem) => void }) {
  const inv = e.invite;
  return (
    <li className="flex items-start gap-1 border-b border-line py-1.5 last:border-b-0">
      <button type="button" onClick={() => onOpen(e)} className="min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left hover:bg-hover">
        <p className={cx('truncate text-[15px] font-medium', inv?.cancelled && 'text-muted line-through')}>{titleOf(e)}</p>
        <p className="text-[13px] text-muted">{when(e).line}</p>
        {e.location && (
          <p className="flex items-center gap-1.5 text-[13px] text-muted">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{e.location}</span>
          </p>
        )}
        {inv && (
          <p className={cx('flex items-center gap-1.5 text-[13px]', inv.cancelled ? 'text-danger' : 'text-muted')}>
            {answerText(inv)}
            {inv.recurring && (
              <>
                <span aria-hidden>·</span>
                <Repeat className="size-3.5" aria-hidden /> Repeats
              </>
            )}
          </p>
        )}
      </button>
      <a href={icsUrl(e)} aria-label={`Download ${titleOf(e)} (.ics)`} title="Download .ics" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg">
        <Download className="size-[18px]" aria-hidden />
      </a>
    </li>
  );
}

function EventDialog({ id, initial, onClose }: { id: number | null; initial: EventForm; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const set = (patch: Partial<EventForm>) => setF((x) => ({ ...x, ...patch }));
  const ev = fromForm(f);
  const error = !Number.isFinite(ev.start) || !Number.isFinite(ev.end) ? 'Pick a day and time' : ev.end < ev.start ? 'The event can’t end before it starts' : null;

  const run = async (kind: 'save' | 'delete', call: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try {
      await call();
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      toast(done);
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
      setBusy(null);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!error) void run('save', () => (id ? api.put(`/api/calendar/events/${id}`, ev) : api.post('/api/calendar/events', ev)), id ? 'Event saved' : 'Event added');
  };
  const remove = () => {
    if (id && window.confirm(`Delete “${f.title || 'this event'}”?`)) void run('delete', () => api.del(`/api/calendar/events/${id}`), 'Event deleted');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={id ? 'Edit event' : 'New event'}
      footer={
        <>
          {id && (
            <>
              <Button variant="ghost" className="text-danger" loading={busy === 'delete'} disabled={!!busy} onClick={remove}>
                Delete
              </Button>
              <a href={linkUrl(`/api/calendar/events/${id}/event.ics`)} className={cx(linkButton, 'mr-auto')}>
                <Download className="size-4" aria-hidden /> Download .ics
              </a>
            </>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="event-form" variant="primary" loading={busy === 'save'} disabled={!!error || !!busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="event-form" onSubmit={save} className="space-y-3">
        <Field label="Title">
          <Input value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={300} autoFocus />
        </Field>
        <Switch checked={f.allDay} onChange={(v) => set({ allDay: v })} label="All day" />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Starts">
            {/* Moving the start past the end moves the end along. */}
            <Input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value, ...(f.endDate < e.target.value ? { endDate: e.target.value } : {}) })} required />
          </Field>
          {!f.allDay && (
            <Field label="Start time">
              <Input type="time" value={f.startTime} onChange={(e) => set({ startTime: e.target.value })} required />
            </Field>
          )}
          <Field label="Ends">
            <Input type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} required />
          </Field>
          {!f.allDay && (
            <Field label="End time">
              <Input type="time" value={f.endTime} onChange={(e) => set({ endTime: e.target.value })} required />
            </Field>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <Field label="Location">
          <Input value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={500} />
        </Field>
        <Field label="Notes">
          <Textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={10_000} />
        </Field>
      </form>
    </Modal>
  );
}

export function CalendarPage() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [editing, setEditing] = useState<{ id: number | null; form: EventForm } | null>(null);
  const [dayOpen, setDayOpen] = useState<Date | null>(null);
  const days = monthGrid(month.getFullYear(), month.getMonth());
  const from = days[0].getTime();
  const to = nextDay(days[days.length - 1]).getTime();
  const q = useQuery({
    queryKey: ['calendar', from, to],
    queryFn: () => api.get<{ events: CalendarItem[]; more: boolean }>(`/api/calendar${qs({ from, to })}`),
    placeholderData: keepPreviousData,
    // A first visit reads older invitations a batch at a time.
    refetchInterval: (query) => (query.state.data?.more ? 1000 : false),
  });
  const events = q.data?.events ?? [];
  const today = new Date();
  const thisMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

  const open = (e: CalendarItem) => {
    setDayOpen(null);
    if (e.invite) navigate(`/all/${e.invite.threadId}`);
    else setEditing({ id: e.id, form: toForm(e) });
  };
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const list = phone ? agenda(events, month) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 px-4 max-sm:px-2">
        <IconButton label="Back to inbox" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        <h1 className="mr-3 text-[22px] font-normal max-sm:sr-only">Calendar</h1>
        <Button size="sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))} disabled={thisMonth}>
          Today
        </Button>
        <IconButton label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <IconButton label="Next month" onClick={() => shift(1)}>
          <ChevronRight className="size-5" />
        </IconButton>
        <h2 className="truncate text-lg font-normal" aria-live="polite">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
        {q.isFetching && <Spinner className="size-4 shrink-0" />}
        <Button variant="primary" size="sm" className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEditing({ id: null, form: newEvent(thisMonth ? today : month) })}>
          <span className="max-sm:sr-only">New event</span>
        </Button>
      </div>
      {q.isError && (
        <p role="alert" className="px-6 pb-2 text-[13px] text-danger">
          Couldn’t load the calendar: {(q.error as Error).message}
        </p>
      )}

      {list ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-28">
          {q.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : !list.upcoming.length && !list.past.length ? (
            <Empty icon={<CalendarDays className="size-7" />} title={`Nothing on your calendar in ${month.toLocaleDateString(undefined, { month: 'long' })}`}>
              Invitations in your mail show up here. Tap + to add your own event.
            </Empty>
          ) : (
            [
              { id: 'upcoming', title: 'Coming up', list: list.upcoming },
              { id: 'past', title: 'Earlier', list: list.past },
            ]
              .filter((s) => s.list.length)
              .map((s) => (
                <section key={s.id} aria-labelledby={`calendar-${s.id}`} className="mt-2">
                  <h3 id={`calendar-${s.id}`} className="px-2 text-[13px] font-medium text-muted">
                    {s.title}
                  </h3>
                  <ul>
                    {s.list.map((e) => (
                      <AgendaRow key={e.id ?? `m${e.invite?.messageId}`} e={e} onOpen={open} />
                    ))}
                  </ul>
                </section>
              ))
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-medium text-muted uppercase" aria-hidden>
            {days.slice(0, 7).map((d) => (
              <div key={d.getDay()} className="py-1.5">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
            ))}
          </div>
          {/* Weeks share the height, and scroll on a short window rather than hide events. */}
          <div className="grid min-h-0 flex-1 auto-rows-[minmax(6rem,1fr)] grid-cols-7 overflow-y-auto border-l border-line">
            {days.map((d) => {
              const on = eventsOn(events, d);
              const shown = on.length > CHIPS ? on.slice(0, CHIPS - 1) : on;
              const isToday = d.toDateString() === today.toDateString();
              const inMonth = d.getMonth() === month.getMonth();
              return (
                <div key={d.getTime()} role="group" aria-label={longDay(d)} className={cx('min-h-0 overflow-hidden border-r border-b border-line p-1', !inMonth && 'bg-panel2')}>
                  <p className="mb-0.5 text-center text-xs">
                    <span
                      aria-current={isToday ? 'date' : undefined}
                      className={cx('inline-flex size-6 items-center justify-center rounded-full', isToday ? 'bg-accent font-semibold text-accent-fg' : inMonth ? 'text-fg' : 'text-faint')}
                    >
                      {d.getDate()}
                    </span>
                  </p>
                  <ul className="space-y-0.5">
                    {shown.map((e) => (
                      <li key={e.id ?? `m${e.invite?.messageId}`}>
                        <EventChip e={e} onOpen={open} />
                      </li>
                    ))}
                  </ul>
                  {on.length > shown.length && (
                    <button type="button" onClick={() => setDayOpen(d)} className="mt-0.5 w-full rounded px-1.5 text-left text-xs font-medium text-muted hover:bg-hover hover:text-fg">
                      {on.length - shown.length} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {dayOpen && (
        <Modal open onClose={() => setDayOpen(null)} title={longDay(dayOpen)}>
          <ul className="-mx-2 pb-2">
            {eventsOn(events, dayOpen).map((e) => (
              <AgendaRow key={e.id ?? `m${e.invite?.messageId}`} e={e} onOpen={open} />
            ))}
          </ul>
        </Modal>
      )}
      {editing && <EventDialog key={editing.id ?? 'new'} id={editing.id} initial={editing.form} onClose={() => setEditing(null)} />}
    </div>
  );
}
