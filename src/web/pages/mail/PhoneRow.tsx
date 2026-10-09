/**
 * A conversation on a phone: avatar, sender and date, subject, snippet, like
 * Gmail's app. Swipe left or right for the actions chosen in Settings; tap the
 * avatar, or press and hold the row, to select.
 */
import { useRef, useState } from 'react';
import { Archive, BellOff, Check, Mail, MailOpen, Paperclip, Star, Trash2 } from 'lucide-react';
import type { Label, SwipeAction, ThreadSummary, View } from '../../../shared/types';
import type { ThreadAction } from '../../lib/actions';
import { shortDate, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Avatar } from '../../components/Avatar';
import { CodeChip } from '../../components/CodeChip';
import { ParcelChip } from './ParcelCard';
import { cx } from '../../components/ui';
import { NudgeChip } from './NudgeChip';
import { ViaChip } from './Via';

const THRESHOLD = 88;
/** Press and hold this long to select. */
const HOLD_MS = 450;

function swipeAction(kind: SwipeAction, t: ThreadSummary, view?: View): ThreadAction | null {
  if (kind === 'archive') return view === 'inbox' || view === 'snoozed' || !view ? { type: 'archive' } : null;
  if (kind === 'trash') return view === 'trash' ? null : { type: 'trash' };
  if (kind === 'read') return { type: t.unread ? 'read' : 'unread' };
  return null;
}

function look(kind: SwipeAction, t: ThreadSummary) {
  if (kind === 'archive') return { bg: 'var(--ok)', icon: <Archive className="size-5" />, label: 'Archive' };
  if (kind === 'trash') return { bg: 'var(--danger)', icon: <Trash2 className="size-5" />, label: 'Delete' };
  return { bg: 'var(--accent)', icon: t.unread ? <MailOpen className="size-5" /> : <Mail className="size-5" />, label: t.unread ? 'Read' : 'Unread' };
}

export function PhoneRow({
  thread: t,
  labels,
  view,
  currentLabel,
  selected,
  selecting,
  onSelect,
  onOpen,
  onAction,
}: {
  thread: ThreadSummary;
  labels: Label[];
  view?: View;
  currentLabel?: number;
  selected: boolean;
  selecting: boolean;
  onSelect: (v: boolean) => void;
  onOpen: () => void;
  onAction: (a: ThreadAction) => void;
}) {
  const { prefs } = useSession();
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const touch = useRef<{ x: number; y: number; lock: 'h' | 'v' | null } | null>(null);
  const suppressClick = useRef(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };

  const recipientsView = view === 'sent' || view === 'drafts' || view === 'scheduled';
  const others = t.participants.filter((p) => !p.me);
  const lead = others[others.length - 1] ?? t.participants[t.participants.length - 1];
  const names = t.participants.length
    ? t.participants
        .slice(-3)
        .map((p, _i, arr) => (p.me ? 'me' : arr.length > 1 ? p.name.split(/[\s@]/)[0] : p.name))
        .join(', ')
    : recipientsView
      ? '(no recipients)'
      : '(unknown)';
  const rowLabels = t.labels.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => !!l && l.id !== currentLabel);
  const scheduled = t.status === 'queued' && t.sendAt && t.sendAt > Date.now() + 30_000;

  const dir = dx > 0 ? 'right' : 'left';
  const kind = dx === 0 ? 'none' : dir === 'right' ? prefs.swipeRight : prefs.swipeLeft;
  const action = kind === 'none' ? null : swipeAction(kind, t, view);
  const style = action ? look(kind, t) : null;

  const end = () => {
    cancelHold();
    const was = touch.current;
    touch.current = null;
    setDragging(false);
    if (was?.lock !== 'h') return;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 400);
    if (action && Math.abs(dx) >= THRESHOLD) {
      if (action.type === 'read' || action.type === 'unread') {
        setDx(0);
        onAction(action);
        return;
      }
      setLeaving(true);
      setDx(dx > 0 ? window.innerWidth : -window.innerWidth);
      setTimeout(() => onAction(action), 180);
    } else setDx(0);
  };

  return (
    <div role="listitem" className={cx('relative overflow-hidden border-b border-line', leaving && 'transition-[max-height] duration-200')}>
      {style && (
        <div aria-hidden className={cx('absolute inset-0 flex items-center gap-2 px-6 text-sm font-medium text-white', dir === 'right' ? 'justify-start' : 'justify-end')} style={{ background: style.bg, opacity: Math.min(1, Math.abs(dx) / THRESHOLD) }}>
          {style.icon}
          {style.label}
        </div>
      )}
      <div
        role="link"
        tabIndex={0}
        aria-label={`${t.unread ? 'Unread, ' : ''}${names}, ${t.subject || 'no subject'}, ${shortDate(t.date)}`}
        className={cx('relative flex gap-3 px-3 py-2.5 outline-none select-none [-webkit-touch-callout:none] focus-visible:bg-hover', selected ? 'bg-sel' : t.unread ? 'bg-unread-row' : 'bg-read-row')}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dragging ? 'none' : 'transform 0.2s ease-out' }}
        onClick={() => {
          if (suppressClick.current) return;
          if (selecting) onSelect(!selected);
          else onOpen();
        }}
        onKeyDown={(e) => e.key === 'Enter' && onOpen()}
        onContextMenu={(e) => e.preventDefault()}
        onTouchStart={(e) => {
          const p = e.touches[0];
          touch.current = { x: p.clientX, y: p.clientY, lock: null };
          // Press and hold to select (like Gmail): the tap that follows doesn't open it.
          cancelHold();
          hold.current = setTimeout(() => {
            hold.current = null;
            if (touch.current?.lock) return;
            suppressClick.current = true;
            setTimeout(() => (suppressClick.current = false), 600);
            navigator.vibrate?.(12);
            onSelect(!selected);
          }, HOLD_MS);
        }}
        onTouchMove={(e) => {
          const s = touch.current;
          if (!s) return;
          const p = e.touches[0];
          const mx = p.clientX - s.x;
          const my = p.clientY - s.y;
          if (Math.abs(mx) > 10 || Math.abs(my) > 10) cancelHold();
          if (!s.lock) {
            if (Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5) {
              const k = mx > 0 ? prefs.swipeRight : prefs.swipeLeft;
              s.lock = k !== 'none' && swipeAction(k, t, view) ? 'h' : 'v';
              if (s.lock === 'h') setDragging(true);
            } else if (Math.abs(my) > 10) s.lock = 'v';
          }
          if (s.lock === 'h') setDx(mx);
        }}
        onTouchEnd={end}
        onTouchCancel={() => {
          cancelHold();
          touch.current = null;
          setDragging(false);
          setDx(0);
        }}
      >
        <button
          type="button"
          aria-label={selected ? 'Deselect conversation' : 'Select conversation'}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(!selected);
          }}
          className="mt-0.5 shrink-0 rounded-full"
        >
          {selected ? (
            <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-fg">
              <Check className="size-5" />
            </span>
          ) : (
            <Avatar name={lead?.name} address={lead?.address ?? ''} size={40} />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cx('min-w-0 flex-1 truncate text-[15px]', t.unread ? 'font-bold' : 'text-fg')}>
              {recipientsView && <span className="font-normal text-muted">To: </span>}
              {names}
              {t.count > 1 && <span className="ml-1 text-xs font-normal text-muted">{t.count}</span>}
              {t.hasDraft && view !== 'drafts' && <span className="ml-1 text-xs font-normal text-danger">Draft</span>}
            </span>
            <span className={cx('shrink-0 text-xs', t.unread ? 'font-bold text-fg' : 'text-muted')}>
              {view === 'snoozed' && t.snoozedUntil ? <span className="text-warn">{relativeTime(t.snoozedUntil)}</span> : scheduled ? <span className="text-accent-ink">{shortDate(t.sendAt!)}</span> : shortDate(t.date)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cx('min-w-0 flex-1 truncate text-sm', t.unread && 'font-bold')}>{t.subject || '(no subject)'}</span>
            {t.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted" aria-label="Has attachments" />}
          </div>
          <div className="flex items-center gap-1.5">
            {t.status === 'failed' && <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-1.5 text-[11px] leading-[18px] font-medium text-danger">Failed</span>}
            {t.code && <CodeChip code={t.code} />}
            {t.parcel && <ParcelChip parcel={t.parcel} />}
            {t.nudge && <NudgeChip sentAt={t.nudge.sentAt} />}
            {t.muted && <BellOff className="size-3.5 shrink-0 text-muted" aria-label="Muted" />}
            {t.via && view !== 'sent' && view !== 'drafts' && view !== 'scheduled' && <ViaChip address={t.via} />}
            {rowLabels.slice(0, 2).map((l) => (
              <span key={l.id} className="max-w-24 shrink-0 truncate rounded px-1.5 text-[11px] leading-[18px] font-medium" style={{ background: `${l.color}22`, color: `color-mix(in srgb, ${l.color} 45%, var(--fg))` }}>
                {l.name}
              </span>
            ))}
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{t.snippet}</span>
            <button
              type="button"
              aria-label={t.starred ? 'Remove star' : 'Add star'}
              aria-pressed={t.starred}
              onClick={(e) => {
                e.stopPropagation();
                onAction({ type: t.starred ? 'unstar' : 'star' });
              }}
              className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-faint"
            >
              <Star className={cx('size-[18px]', t.starred && 'fill-[#f4b400] text-[#f4b400]')} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
