/** A package from shipping mail: where it is, the order and tracking numbers, View order and Track package (like Gmail's order card). */
import { Check, Copy, Hash, Package } from 'lucide-react';
import { useState } from 'react';
import type { Parcel, ParcelStatus } from '../../../shared/types';
import { useToast } from '../../components/toast';
import { cx } from '../../components/ui';

const DAY = 86_400_000;

/** An expected day (UTC midnight): "Today", "Tomorrow", "Thu, Oct 8". */
function etaText(eta: number, now = new Date()): string {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((eta - today) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC', ...(new Date(eta).getUTCFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(eta);
}

const dayText = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });

/** "today" and "tomorrow" in the middle of a sentence. */
const inSentence = (s: string) => (s === 'Today' || s === 'Tomorrow' ? s.toLowerCase() : s);

export type Tone = 'ok' | 'warn' | 'danger' | 'accent';

export function toneOf(status: ParcelStatus | null): Tone {
  if (status === 'delivered' || status === 'ready_for_pickup') return 'ok';
  if (status === 'delayed') return 'warn';
  if (status === 'cancelled') return 'danger';
  return 'accent';
}

/** The item's name, or what the package is ("Your Macy’s order"). */
export function parcelTitle(p: Pick<Parcel, 'item' | 'merchant' | 'carrier'>): string {
  return p.item ?? (p.merchant ? `Your ${p.merchant} order` : p.carrier ? `${p.carrier} package` : 'Your package');
}

/** The big two lines: "Delivered / Tue, Oct 6", "Arriving / Tomorrow". */
export function headline(p: Parcel): { title: string; when: string | null } {
  const arriving = p.eta !== null ? etaText(p.eta) : null;
  switch (p.status) {
    case 'delivered':
      return { title: 'Delivered', when: dayText(p.statusAt) };
    case 'out_for_delivery':
      return { title: 'Out for delivery', when: 'Arriving today' };
    case 'ready_for_pickup':
      return { title: 'Ready for pickup', when: dayText(p.statusAt) };
    case 'delayed':
      return { title: 'Delayed', when: arriving ? `Now arriving ${inSentence(arriving)}` : null };
    case 'cancelled':
      return { title: 'Cancelled', when: dayText(p.statusAt) };
    case 'returned':
      return { title: 'Returned', when: dayText(p.statusAt) };
    case 'shipped':
    case 'in_transit':
      return arriving ? { title: 'Arriving', when: arriving } : { title: p.status === 'shipped' ? 'Shipped' : 'On the way', when: dayText(p.statusAt) };
    case 'ordered':
      return arriving ? { title: 'Arriving', when: arriving } : { title: 'Ordered', when: dayText(p.statusAt) };
    default:
      return arriving ? { title: 'Arriving', when: arriving } : { title: 'Package update', when: dayText(p.statusAt) };
  }
}

/** Short, for an inbox row: "Delivered", "Arriving Thu". */
function chipText(p: Pick<Parcel, 'status' | 'statusAt' | 'eta'>): string | null {
  const arriving = p.eta !== null ? etaText(p.eta) : null;
  const soon = arriving ? inSentence(arriving).split(',')[0] : null;
  switch (p.status) {
    case 'delivered':
      return 'Delivered';
    case 'out_for_delivery':
      return 'Out for delivery';
    case 'ready_for_pickup':
      return 'Ready for pickup';
    case 'delayed':
      return 'Delayed';
    case 'cancelled':
      return 'Cancelled';
    case 'returned':
      return 'Returned';
    case 'shipped':
    case 'in_transit':
      return soon ? `Arriving ${soon}` : p.status === 'shipped' ? 'Shipped' : 'On the way';
    case 'ordered':
      return soon ? `Arriving ${soon}` : 'Ordered';
    default:
      return soon ? `Arriving ${soon}` : null;
  }
}

const STEPS: { label: string; of: ParcelStatus[] }[] = [
  { label: 'Ordered', of: ['ordered'] },
  { label: 'Shipped', of: ['shipped', 'in_transit', 'delayed'] },
  { label: 'Out for delivery', of: ['out_for_delivery'] },
  { label: 'Delivered', of: ['delivered', 'ready_for_pickup'] },
];

export const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', accent: 'text-accent-ink' };
const TONE_FILL: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', accent: 'bg-accent' };
const TONE_CHIP: Record<Tone, string> = {
  ok: 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok',
  warn: 'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-warn',
  danger: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger',
  accent: 'bg-accent-soft text-accent-ink',
};

/** On an inbox row: where the package is. */
export function ParcelChip({ parcel }: { parcel: Pick<Parcel, 'status' | 'statusAt' | 'eta'> }) {
  const label = chipText(parcel);
  if (!label) return null;
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-[18px] font-medium', TONE_CHIP[toneOf(parcel.status)])} title="Package">
      <Package className="size-3" aria-hidden />
      {label}
    </span>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <dt className="text-[13px] font-semibold">{label}</dt>
      <dd>
        <button
          type="button"
          title={`Copy ${label.toLowerCase()}`}
          aria-label={`${label} ${value}. Copy`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
              toast(`${label} copied`);
            } catch {
              toast({ message: 'Couldn’t copy. Press and hold the number to copy it.', tone: 'error' });
            }
          }}
          className="group inline-flex max-w-full items-center gap-1.5 rounded text-left text-[15px] break-all text-muted hover:text-fg"
        >
          <span className="select-all">{value}</span>
          {copied ? <Check className="size-3.5 shrink-0 text-ok" aria-hidden /> : <Copy className="size-3.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />}
        </button>
      </dd>
    </div>
  );
}

const linkButton = 'inline-flex h-11 items-center justify-center rounded-full px-6 text-[15px] font-medium whitespace-nowrap transition-[filter] hover:brightness-110 max-sm:flex-1';

export function ParcelCard({ parcel: p, showImage }: { parcel: Parcel; showImage: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  const head = headline(p);
  const tone = toneOf(p.status);
  const step = p.status ? STEPS.findIndex((s) => s.of.includes(p.status!)) : -1;
  const title = parcelTitle(p);
  const count = p.items && p.items > 1 ? `${p.items} items` : null;
  // "6 items from Macy’s", "From Macy’s" (under the item's name), or just the count.
  const sub = p.item ? (count && p.merchant ? `${count} from ${p.merchant}` : (count ?? (p.merchant ? `From ${p.merchant}` : null))) : count;
  // Through Wren's image proxy the shop never learns who looked; otherwise only with "always show images".
  const image = imageFailed ? null : (p.imageUrl ?? (showImage ? p.image : null));
  const orderHost = p.orderUrl ? p.orderUrl.replace(/^https:\/\/(?:www\.)?([^/?#]+).*$/, '$1') : null;

  return (
    <div className="max-w-2xl">
      <section aria-label={p.merchant ? `Package from ${p.merchant}` : 'Package'} className="rounded-2xl bg-panel2 p-5 max-sm:p-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 text-[17px] leading-snug font-semibold break-words">{title}</h2>
            {sub && <p className="mt-0.5 text-[15px] text-muted">{sub}</p>}
          </div>
          <div className="flex size-[72px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-panel" aria-hidden>
            {image ? (
              <img src={image} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" loading="lazy" onError={() => setImageFailed(true)} />
            ) : (
              <Package className="size-8 text-muted" strokeWidth={1.5} />
            )}
          </div>
        </div>

        <p className="mt-5 text-[34px] leading-[1.15] max-sm:text-[30px]">
          <span className={cx('block', tone !== 'accent' && TONE_TEXT[tone])}>{head.title}</span>
          {head.when && <span className="block">{head.when}</span>}
        </p>

        {step >= 0 && (
          <div className="mt-4" aria-label={`${STEPS[step].label}: step ${step + 1} of ${STEPS.length}`} role="img">
            <div className="flex gap-1">
              {STEPS.map((s, i) => (
                <span key={s.label} className={cx('h-1.5 flex-1 rounded-full', i <= step ? TONE_FILL[tone] : 'bg-line-strong')} />
              ))}
            </div>
            <div className="mt-1.5 flex text-[11px] text-muted max-sm:hidden" aria-hidden>
              {STEPS.map((s, i) => (
                <span key={s.label} className={cx('flex-1', i === step && 'font-medium text-fg')}>
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {(p.order || p.tracking) && (
          <div className="mt-5 flex items-start gap-3">
            <Hash className="mt-1 size-5 shrink-0 text-muted" aria-hidden />
            <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 max-[400px]:grid-cols-1">
              {p.order && <CopyValue label="Order number" value={p.order} />}
              {p.tracking && <CopyValue label={p.carrier ? `${p.carrier} tracking` : 'Tracking number'} value={p.tracking} />}
            </dl>
          </div>
        )}

        {/* The shop's page first; without one, tracking is the main action. */}
        {(p.orderUrl || p.trackUrl) && (
          <div className="mt-5 flex flex-wrap gap-2">
            {p.orderUrl && (
              <a href={p.orderUrl} target="_blank" rel="noopener noreferrer" title={`Opens ${orderHost}, or its app if you have it`} className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm')}>
                View order
              </a>
            )}
            {p.trackUrl && (
              <a href={p.trackUrl} target="_blank" rel="noopener noreferrer" className={cx(linkButton, p.orderUrl ? 'bg-accent-soft text-accent-ink' : 'bg-accent text-accent-fg shadow-sm')}>
                Track package
              </a>
            )}
          </div>
        )}
      </section>
      {p.emails > 1 && <p className="mt-2 px-1 text-[13px] text-muted">Based on {p.emails} emails</p>}
    </div>
  );
}
