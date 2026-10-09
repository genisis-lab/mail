/** Manage subscriptions (like Gmail's): who sends you list mail, how much, and one-tap unsubscribe. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, MailMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Subscription } from '../../shared/types';
import { api } from '../lib/api';
import { shortDate } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { useToast } from '../components/toast';
import { Button, Empty, IconButton, Input, Spinner } from '../components/ui';

function SubscriptionRow({ s }: { s: Subscription }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const who = s.name || s.sender;
  const unsubscribe = async () => {
    if (!window.confirm(`Unsubscribe from ${who}? Wren asks the sender to stop mailing you.`)) return;
    setBusy(true);
    try {
      const r = await api.post<{ method: 'one-click' | 'email' | 'link'; url?: string }>(`/api/mail/messages/${s.messageId}/unsubscribe`);
      if (r.method === 'link' && r.url) {
        window.open(r.url, '_blank', 'noopener,noreferrer');
        toast(`${who}’s unsubscribe page opened in a new tab`);
      } else toast(r.method === 'email' ? `Unsubscribe request sent to ${who}` : `Unsubscribed from ${who}`);
      await qc.invalidateQueries({ queryKey: ['subscriptions'] });
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-center gap-3 border-b border-line px-2 py-3 last:border-b-0">
      <Avatar name={s.name} address={s.sender} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium">{who}</p>
        <p className="truncate text-[13px] text-muted">
          {s.recent ? `${s.recent} email${s.recent === 1 ? '' : 's'} in the last 30 days` : `Last email ${shortDate(s.lastAt)}`}
          <span className="max-sm:hidden"> · {s.sender}</span>
        </p>
      </div>
      <Link to={`/search/${encodeURIComponent(`from:${s.sender}`)}`} className="shrink-0 rounded-full px-3 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg max-sm:hidden">
        View emails
      </Link>
      {s.unsubscribedAt ? (
        <span className="inline-flex shrink-0 items-center gap-1 px-3 text-[13px] text-muted" title={`Unsubscribed ${shortDate(s.unsubscribedAt)}`}>
          <Check className="size-4 text-ok" aria-hidden /> Unsubscribed
        </span>
      ) : (
        <Button size="sm" className="shrink-0" loading={busy} onClick={() => void unsubscribe()}>
          Unsubscribe
        </Button>
      )}
    </li>
  );
}

export function SubscriptionsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['subscriptions'], queryFn: () => api.get<{ subscriptions: Subscription[] }>('/api/mail/subscriptions').then((r) => r.subscriptions) });
  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((s) => !f || s.sender.includes(f) || s.name.toLowerCase().includes(f));
  }, [q.data, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <IconButton label="Back to inbox" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        <h1 className="text-[22px] font-normal">Manage subscriptions</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pb-10 max-md:pb-28 max-sm:px-3">
          <p className="mb-3 px-1 text-[13px] text-muted">Newsletters and other list mail from the last six months, the busiest senders first.</p>
          {(q.data?.length ?? 0) > 8 && <Input className="mb-3 w-full max-w-sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search senders" aria-label="Search senders" />}
          {q.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : !list.length ? (
            <Empty icon={<MailMinus className="size-7" />} title={filter ? 'No matching senders' : 'No subscriptions'}>
              {filter ? 'Try another name or address.' : 'Mail you get from lists with an unsubscribe link shows up here.'}
            </Empty>
          ) : (
            <ul className="rounded-2xl border border-line bg-panel">
              {list.map((s) => (
                <SubscriptionRow key={s.sender} s={s} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
