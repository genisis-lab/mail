/** Packages: everything on its way, and what arrived lately, from shipping mail. */
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Mail, Package, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { PackageItem } from '../../shared/types';
import { api } from '../lib/api';
import { Empty, IconButton, Spinner, cx } from '../components/ui';
import { headline, parcelTitle, toneOf, TONE_TEXT } from './mail/ParcelCard';

const DONE = new Set(['delivered', 'cancelled', 'returned']);

function sections(list: PackageItem[]) {
  const coming = list
    .filter((p) => !DONE.has(p.status ?? ''))
    // Soonest first; ones without a date by their latest news.
    .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity) || b.statusAt - a.statusAt);
  const delivered = list.filter((p) => p.status === 'delivered').sort((a, b) => b.statusAt - a.statusAt);
  const other = list.filter((p) => p.status === 'cancelled' || p.status === 'returned').sort((a, b) => b.statusAt - a.statusAt);
  return [
    { id: 'coming', title: 'On the way', list: coming },
    { id: 'delivered', title: 'Delivered', list: delivered },
    { id: 'other', title: 'Cancelled and returned', list: other },
  ].filter((s) => s.list.length);
}

const action = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-[filter,background] hover:brightness-110';

function PackageRow({ p }: { p: PackageItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  const head = headline(p);
  const tone = toneOf(p.status);
  const details = [p.items && p.items > 1 ? `${p.items} items` : null, p.merchant && `from ${p.merchant}`, p.tracking && `${p.carrier ?? 'Tracking'} ${p.tracking}`].filter(Boolean).join(' · ');
  return (
    <li className="flex gap-4 rounded-2xl border border-line bg-panel p-4 max-sm:gap-3 max-sm:p-3">
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-panel2" aria-hidden>
        {p.imageUrl && !imageFailed ? (
          <img src={p.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setImageFailed(true)} />
        ) : (
          <Package className="size-6 text-muted" strokeWidth={1.5} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cx('text-[15px] font-semibold', tone === 'accent' ? 'text-accent-ink' : TONE_TEXT[tone])}>
          {head.title}
          {head.when && <span className="font-normal text-fg"> · {head.when}</span>}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[15px] break-words">{parcelTitle(p)}</p>
        {details && <p className="mt-0.5 truncate text-[13px] text-muted">{details}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {p.orderUrl && (
            <a href={p.orderUrl} target="_blank" rel="noopener noreferrer" className={cx(action, 'bg-accent text-accent-fg')}>
              View order
            </a>
          )}
          {p.trackUrl && (
            <a href={p.trackUrl} target="_blank" rel="noopener noreferrer" className={cx(action, p.orderUrl ? 'bg-accent-soft text-accent-ink' : 'bg-accent text-accent-fg')}>
              Track package
            </a>
          )}
          <Link to={`/all/${p.threadId}`} className={cx(action, 'text-fg hover:bg-hover')}>
            <Mail className="size-4" aria-hidden />
            {p.emails > 1 ? `${p.emails} emails` : 'Email'}
          </Link>
        </div>
      </div>
    </li>
  );
}

export function PackagesPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['packages'], queryFn: () => api.get<{ packages: PackageItem[] }>('/api/mail/packages').then((r) => r.packages) });
  const groups = useMemo(() => sections(q.data ?? []), [q.data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <IconButton label="Back to inbox" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        <h1 className="text-[22px] font-normal">Packages</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pb-10 max-md:pb-28 max-sm:px-3">
          {q.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : !groups.length ? (
            <Empty icon={<Package className="size-7" />} title="No packages yet">
              Shipping emails with a tracking number show up here, with where each package is.
            </Empty>
          ) : (
            groups.map((g) => (
              <section key={g.id} aria-labelledby={`packages-${g.id}`} className="mt-4 first:mt-1">
                <h2 id={`packages-${g.id}`} className="mb-2 px-1 text-[13px] font-medium text-muted">
                  {g.title} · {g.list.length}
                </h2>
                <ul className="space-y-3">
                  {g.list.map((p) => (
                    <PackageRow key={`${p.messageId}`} p={p} />
                  ))}
                </ul>
              </section>
            ))
          )}
          <p className="mt-6 flex items-center gap-1.5 px-1 text-[13px] text-muted">
            <Search className="size-3.5" aria-hidden />
            <span>
              Every shipping email:{' '}
              <Link to={`/search/${encodeURIComponent('has:package')}`} className="text-accent-ink hover:underline">
                has:package
              </Link>
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
