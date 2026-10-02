/** A meeting invitation in a message: when and where, who's coming, and Yes / Maybe / No. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, MapPin, Repeat, Users, Video, X } from 'lucide-react';
import { api, mailboxUrl } from '../../lib/api';
import { useToast } from '../../components/toast';
import { Button, cx } from '../../components/ui';

interface Invite {
  method: string;
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
  me: { email: string; status: string | null } | null;
  rsvp: string | null;
  canReply: boolean;
}

const ANSWERS = [
  { id: 'accepted', status: 'ACCEPTED', label: 'Yes' },
  { id: 'tentative', status: 'TENTATIVE', label: 'Maybe' },
  { id: 'declined', status: 'DECLINED', label: 'No' },
] as const;

const STATUS_TEXT: Record<string, string> = { ACCEPTED: 'accepted', TENTATIVE: 'replied maybe', DECLINED: 'declined', 'NEEDS-ACTION': 'hasn’t replied', DELEGATED: 'delegated' };

const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

function when(inv: Invite): { line: string; other: string | null } {
  if (!inv.start) return { line: 'Time not given', other: null };
  if (inv.allDay) {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const lastDay = inv.end && inv.end - inv.start > 86_400_000 ? inv.end - 86_400_000 : null;
    return { line: lastDay ? `${fmt.format(inv.start)} – ${fmt.format(lastDay)}` : `${fmt.format(inv.start)} · all day`, other: null };
  }
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = inv.end && new Date(inv.end).toDateString() === new Date(inv.start).toDateString();
  const line = `${day.format(inv.start)} · ${time.format(inv.start)}${inv.end ? ` – ${sameDay ? time.format(inv.end) : `${day.format(inv.end)} ${time.format(inv.end)}`}` : ''}`;
  let other: string | null = null;
  if (inv.timeZone && inv.timeZone !== 'UTC' && inv.timeZone !== here) {
    try {
      const t = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: inv.timeZone, timeZoneName: 'short' });
      other = `${t.format(inv.start)} for the organizer (${inv.timeZone.replace(/_/g, ' ')})`;
    } catch {
      other = null;
    }
  }
  return { line, other };
}

export function InviteCard({ messageId, canAnswer = true }: { messageId: number; canAnswer?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const q = useQuery({ queryKey: ['invite', messageId], queryFn: () => api.get<{ invite: Invite | null }>(`/api/mail/messages/${messageId}/invite`).then((r) => r.invite) });
  const inv = q.data;
  if (!inv) return null;
  const cancelled = inv.method === 'CANCEL' || inv.status === 'CANCELLED';
  const answered = inv.rsvp ?? (inv.me?.status && inv.me.status !== 'NEEDS-ACTION' ? inv.me.status : null);
  const t = when(inv);
  const start = inv.start ? new Date(inv.start) : null;
  const tileTz = inv.allDay ? 'UTC' : undefined;
  const others = inv.attendees.filter((a) => a.email !== inv.me?.email);
  const going = inv.attendees.filter((a) => a.status === 'ACCEPTED').length;

  const answer = async (id: (typeof ANSWERS)[number]['id']) => {
    setBusy(id);
    try {
      await api.post(`/api/mail/messages/${messageId}/invite/reply`, { response: id });
      qc.invalidateQueries({ queryKey: ['invite', messageId] });
      qc.invalidateQueries({ queryKey: ['thread'] });
      toast(`${inv.organizer?.name || inv.organizer?.email || 'The organizer'} will be told: ${ANSWERS.find((a) => a.id === id)!.label}`);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Invitation" className={cx('mb-4 max-w-2xl overflow-hidden rounded-2xl border', cancelled ? 'border-[color-mix(in_srgb,var(--danger)_35%,transparent)]' : 'border-line')}>
      <div className="flex gap-4 p-4">
        {start && (
          <div className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-xl border border-line text-center" aria-hidden>
            <span className="w-full bg-accent py-0.5 text-[11px] font-semibold tracking-wide text-white uppercase">{start.toLocaleDateString(undefined, { month: 'short', timeZone: tileTz })}</span>
            <span className="py-1 text-xl leading-tight font-semibold">{start.toLocaleDateString(undefined, { day: 'numeric', timeZone: tileTz })}</span>
            <span className="pb-1 text-[11px] text-muted">{start.toLocaleDateString(undefined, { weekday: 'short', timeZone: tileTz })}</span>
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          {cancelled && <p className="text-[13px] font-semibold text-danger">This event has been cancelled</p>}
          {inv.method === 'REPLY' && inv.attendees[0] && (
            <p className="text-[13px] font-medium text-muted">
              {inv.attendees[0].name || inv.attendees[0].email} {STATUS_TEXT[inv.attendees[0].status ?? ''] ?? 'replied'}
            </p>
          )}
          <h3 className={cx('text-[15px] font-semibold break-words', cancelled && 'line-through')}>{inv.summary || '(no title)'}</h3>
          <p className="text-sm">{t.line}</p>
          {t.other && <p className="text-xs text-muted">{t.other}</p>}
          {inv.recurring && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Repeat className="size-3.5" aria-hidden /> Repeats
            </p>
          )}
          {inv.location && (
            <p className="flex items-start gap-1.5 text-[13px] text-muted">
              <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="break-words">{inv.location}</span>
            </p>
          )}
          {inv.organizer && (
            <p className="text-[13px] text-muted">
              Organizer: <span className="text-fg">{inv.organizer.name || inv.organizer.email}</span>
            </p>
          )}
          {others.length > 0 && (
            <div className="text-[13px] text-muted">
              <button type="button" className="inline-flex items-center gap-1.5 hover:text-fg" aria-expanded={showPeople} onClick={() => setShowPeople((v) => !v)}>
                <Users className="size-3.5" aria-hidden />
                {inv.attendees.length} {inv.attendees.length === 1 ? 'guest' : 'guests'}
                {going ? ` · ${going} going` : ''}
              </button>
              {showPeople && (
                <ul className="mt-1.5 space-y-0.5">
                  {inv.attendees.map((a) => (
                    <li key={a.email} className="flex items-center gap-1.5">
                      {a.status === 'ACCEPTED' ? <Check className="size-3.5 text-ok" aria-label="Going" /> : a.status === 'DECLINED' ? <X className="size-3.5 text-danger" aria-label="Not going" /> : <span className="size-3.5" />}
                      <span className="truncate text-fg">{a.name && a.name !== a.email ? a.name : a.email}</span>
                      {a.email === inv.organizer?.email && <span className="text-xs">· organizer</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel2 px-4 py-2.5">
        {inv.canReply && canAnswer && !cancelled ? (
          <>
            <span className="mr-1 text-[13px] font-medium" id={`going-${messageId}`}>
              Going?
            </span>
            <div role="group" aria-labelledby={`going-${messageId}`} className="flex gap-1.5">
              {ANSWERS.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant={answered === a.status ? 'primary' : 'secondary'}
                  aria-pressed={answered === a.status}
                  loading={busy === a.id}
                  disabled={!!busy}
                  onClick={() => void answer(a.id)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </>
        ) : (
          answered && <span className="text-[13px] text-muted">You replied: {ANSWERS.find((a) => a.status === answered)?.label ?? answered.toLowerCase()}</span>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {inv.url && !cancelled && (
            <a href={inv.url} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="ghost" icon={<Video className="size-4" />}>
                Join
              </Button>
            </a>
          )}
          {!cancelled && inv.start && (
            <a href={mailboxUrl(`/api/mail/messages/${messageId}/invite.ics`)}>
              <Button size="sm" variant="ghost" icon={<CalendarPlus className="size-4" />}>
                Add to calendar
              </Button>
            </a>
          )}
        </span>
      </div>
    </section>
  );
}
