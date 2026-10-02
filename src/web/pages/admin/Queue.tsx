import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Search, XCircle } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { longDate, relativeTime, shortDate } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Empty, IconButton, Input, Modal, Select, Spinner, Tabs } from '../../components/ui';
import { PageHeader, Table } from './common';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  sent: 'ok',
  delivered: 'ok',
  accepted: 'ok',
  queued: 'accent',
  sending: 'accent',
  deferred: 'warn',
  spam: 'warn',
  duplicate: 'neutral',
  failed: 'danger',
  rejected: 'danger',
  error: 'danger',
  cancelled: 'neutral',
  bounced: 'danger',
  complained: 'danger',
  delayed: 'warn',
  suppressed: 'neutral',
};

export function QueuePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const items = useQuery({
    queryKey: ['admin', 'outbox', status, q],
    queryFn: () => api.get<{ items: any[] }>(`/api/admin/outbox${qs({ status, q })}`).then((r) => r.items),
    refetchInterval: 5000,
  });
  const act = async (id: number, action: 'retry' | 'cancel') => {
    try {
      await api.post(`/api/admin/outbox/${id}/${action}`);
      qc.invalidateQueries({ queryKey: ['admin', 'outbox'] });
      toast(action === 'retry' ? 'Requeued' : 'Cancelled');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  return (
    <div>
      <PageHeader title="Mail queue" description="Every outgoing delivery: user mail, forwards, auto-replies and notices. Failed items can be retried." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="Search sender, recipient, subject" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">All statuses</option>
          <option value="queued">Queued</option>
          <option value="sending">Sending</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <IconButton label="Refresh" onClick={() => items.refetch()}>
          <RefreshCw className={`size-4 ${items.isFetching ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      {items.isLoading ? (
        <Spinner />
      ) : !items.data?.length ? (
        <Empty title="Nothing here" />
      ) : (
        <Table head={['Status', 'Message', 'From → To', 'Attempts', 'Updated', '']}>
          {items.data.map((o) => (
            <tr key={o.id} className="align-top hover:bg-hover">
              <td>
                <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
                <div className="mt-1 text-[11px] text-faint">{o.kind}</div>
              </td>
              <td className="max-w-64">
                <p className="truncate font-medium">{o.subject || '(no subject)'}</p>
                {o.last_error && <p className="mt-0.5 line-clamp-2 text-xs text-danger">{o.last_error}</p>}
                {o.provider_name && <p className="text-xs text-muted">via {o.provider_name}</p>}
              </td>
              <td className="max-w-72 text-xs">
                <p className="truncate">{o.mail_from}</p>
                <p className="truncate text-muted">→ {o.recipients.join(', ') || '(local only)'}</p>
              </td>
              <td className="text-xs text-muted tabular-nums">
                {o.attempts}
                {o.status === 'queued' && o.next_attempt_at > Date.now() && <div>next {relativeTime(o.next_attempt_at)}</div>}
              </td>
              <td className="text-xs whitespace-nowrap text-muted">{relativeTime(o.updated_at)}</td>
              <td className="text-right whitespace-nowrap">
                {(o.status === 'failed' || o.status === 'cancelled') && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void act(o.id, 'retry')}>
                    Retry
                  </Button>
                )}
                {o.status === 'queued' && (
                  <Button size="sm" variant="ghost" icon={<XCircle className="size-3.5" />} onClick={() => void act(o.id, 'cancel')}>
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

interface Suppression {
  address: string;
  reason: 'bounce' | 'complaint' | 'manual';
  detail: string;
  createdAt: number;
}

const REASONS: Record<Suppression['reason'], { label: string; tone: 'danger' | 'warn' | 'neutral' }> = {
  bounce: { label: 'hard bounce', tone: 'danger' },
  complaint: { label: 'marked as spam', tone: 'warn' },
  manual: { label: 'added by an admin', tone: 'neutral' },
};

/** Addresses Wren won't mail: they hard-bounced, reported spam, or were added here. */
function Suppressions() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [add, setAdd] = useState('');
  const search = useDebounced(q.trim());
  const list = useQuery({ queryKey: ['admin', 'suppressions', search], queryFn: () => api.get<{ items: Suppression[] }>(`/api/admin/suppressions${qs({ q: search })}`).then((r) => r.items) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'suppressions'] });
  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-muted">
        Wren stops mailing an address that hard-bounces or marks a message as spam, which protects your sending reputation. Senders get a clear notice instead. Delivery events come from your provider’s webhooks (Resend: email.bounced and email.complained).
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-sm:w-full">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input className="pl-9" placeholder="Find an address" aria-label="Find a suppressed address" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <form
          className="flex flex-wrap gap-2 max-sm:w-full"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post('/api/admin/suppressions', { address: add.trim() });
              setAdd('');
              refresh();
              toast('Address suppressed');
            } catch (err) {
              toast({ message: (err as Error).message, tone: 'error' });
            }
          }}
        >
          <Input type="email" className="w-64 max-sm:flex-1" placeholder="Block an address" aria-label="Address to block" value={add} onChange={(e) => setAdd(e.target.value)} />
          <Button type="submit" disabled={!add.trim()}>
            Block
          </Button>
        </form>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Empty title={search ? 'No suppressed address matches' : 'No suppressed addresses'}>Addresses that bounce or report spam will show up here.</Empty>
      ) : (
        <Table head={['Address', 'Why', 'Since', '']}>
          {list.data.map((s) => (
            <tr key={s.address}>
              <td className="font-medium break-all">{s.address}</td>
              <td>
                <Badge tone={REASONS[s.reason].tone}>{REASONS[s.reason].label}</Badge>
                {s.detail && <p className="mt-1 line-clamp-2 text-xs text-muted">{s.detail}</p>}
              </td>
              <td className="text-xs whitespace-nowrap text-muted">{relativeTime(s.createdAt)}</td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`/api/admin/suppressions/${encodeURIComponent(s.address)}`);
                    refresh();
                    toast(`${s.address} can be mailed again`);
                  }}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

/** A search box that only reports after the person pauses typing. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Page<T> {
  items: T[];
  nextBefore: number | null;
}

export function LogsPage() {
  const [tab, setTab] = useState<'delivery' | 'inbound' | 'suppressed'>('delivery');
  const [q, setQ] = useState('');
  const [event, setEvent] = useState('');
  const [status, setStatus] = useState('');
  const [domain, setDomain] = useState('');
  const [user, setUser] = useState('');
  const [detail, setDetail] = useState<{ kind: 'delivery' | 'inbound'; id: number } | null>(null);
  const search = useDebounced(q.trim());
  const filters = useQuery({ queryKey: ['admin', 'log-filters'], queryFn: () => api.get<{ domains: string[]; users: { id: number; email: string }[] }>('/api/admin/log-filters') });
  const delivery = useInfiniteQuery({
    queryKey: ['admin', 'delivery-log', { search, event, domain, user }],
    queryFn: ({ pageParam }) => api.get<Page<any>>(`/api/admin/delivery-log${qs({ q: search, event, domain, user, before: pageParam })}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: tab === 'delivery',
  });
  const inbound = useInfiniteQuery({
    queryKey: ['admin', 'inbound-log', { search, status, domain }],
    queryFn: ({ pageParam }) => api.get<Page<any>>(`/api/admin/inbound-log${qs({ q: search, status, domain, before: pageParam })}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: tab === 'inbound',
  });
  const current = tab === 'delivery' ? delivery : inbound;
  const rows = current.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(search || (tab === 'delivery' ? event || user : status) || domain);

  return (
    <div>
      <PageHeader title="Delivery logs" description="What happened to every message going out and coming in (kept for 90 days). Click an entry for details." />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'delivery', label: 'Outbound' },
            { value: 'inbound', label: 'Inbound' },
            { value: 'suppressed', label: 'Suppressed addresses' },
          ]}
        />
      </div>
      {tab === 'suppressed' ? (
        <Suppressions />
      ) : (
      <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-sm:w-full">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input className="pl-9" placeholder={tab === 'delivery' ? 'Recipient, subject, sender, error' : 'Sender, recipient, subject, reason'} aria-label="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {tab === 'delivery' ? (
          <Select value={event} onChange={(e) => setEvent(e.target.value)} className="w-44 max-sm:flex-1" aria-label="Event">
            <option value="">All events</option>
            <option value="problems">Problems only</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="deferred">Deferred</option>
            <option value="delayed">Delayed</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Marked as spam</option>
            <option value="suppressed">Suppressed</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </Select>
        ) : (
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44 max-sm:flex-1" aria-label="Result">
            <option value="">All results</option>
            <option value="problems">Problems only</option>
            <option value="accepted">Accepted</option>
            <option value="spam">Spam</option>
            <option value="rejected">Rejected</option>
            <option value="duplicate">Duplicate</option>
            <option value="error">Error</option>
          </Select>
        )}
        {(filters.data?.domains.length ?? 0) > 1 && (
          <Select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-44 max-sm:flex-1" aria-label="Domain">
            <option value="">All domains</option>
            {filters.data!.domains.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
        )}
        {tab === 'delivery' && (filters.data?.users.length ?? 0) > 1 && (
          <Select value={user} onChange={(e) => setUser(e.target.value)} className="w-56 max-sm:flex-1" aria-label="Sender">
            <option value="">Everyone</option>
            {filters.data!.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </Select>
        )}
        <IconButton label="Refresh" onClick={() => void current.refetch()}>
          <RefreshCw className={`size-4 ${current.isFetching ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      {current.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title={filtered ? 'Nothing matches these filters' : tab === 'delivery' ? 'No deliveries yet' : 'No inbound mail logged yet'} />
      ) : tab === 'delivery' ? (
        <Table head={['Time', 'Event', 'Message', 'Recipients', 'Detail']}>
          {rows.map((l) => (
            <tr
              key={l.id}
              tabIndex={0}
              className="cursor-pointer align-top hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
              onClick={() => setDetail({ kind: 'delivery', id: l.id })}
              onKeyDown={(e) => e.key === 'Enter' && setDetail({ kind: 'delivery', id: l.id })}
            >
              <td className="text-xs whitespace-nowrap text-muted" title={longDate(l.created_at)}>
                {shortDate(l.created_at)}
              </td>
              <td>
                <Badge tone={STATUS_TONE[l.event] ?? 'neutral'}>{l.event}</Badge>
              </td>
              <td className="max-w-56">
                <p className="truncate">{l.subject ?? '—'}</p>
                {l.user_email && <p className="truncate text-xs text-muted">{l.user_email}</p>}
              </td>
              <td className="max-w-56 truncate text-xs text-muted">{l.recipients}</td>
              <td className="max-w-80 text-xs text-muted">
                <span className="line-clamp-2">
                  {l.provider_name && <span className="font-medium text-fg">{l.provider_name}: </span>}
                  {l.detail}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Table head={['Time', 'Result', 'From', 'To', 'Subject', 'Source']}>
          {rows.map((l) => (
            <tr
              key={l.id}
              tabIndex={0}
              className="cursor-pointer align-top hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
              onClick={() => setDetail({ kind: 'inbound', id: l.id })}
              onKeyDown={(e) => e.key === 'Enter' && setDetail({ kind: 'inbound', id: l.id })}
            >
              <td className="text-xs whitespace-nowrap text-muted" title={longDate(l.created_at)}>
                {shortDate(l.created_at)}
              </td>
              <td>
                <Badge tone={STATUS_TONE[l.status] ?? 'neutral'}>{l.status}</Badge>
                {l.reason && <div className="mt-1 line-clamp-2 text-[11px] text-muted">{l.reason}</div>}
              </td>
              <td className="max-w-48 truncate text-xs">{l.mail_from || '—'}</td>
              <td className="max-w-48 truncate text-xs">{l.rcpt_to}</td>
              <td className="max-w-56 truncate">{l.subject}</td>
              <td className="text-xs text-muted">{l.provider_name ?? l.source}</td>
            </tr>
          ))}
        </Table>
      )}
      {current.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button loading={current.isFetchingNextPage} onClick={() => void current.fetchNextPage()}>
            Load older entries
          </Button>
        </div>
      )}
      </>
      )}
      <LogDetail target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function LogDetail({ target, onClose }: { target: { kind: 'delivery' | 'inbound'; id: number } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'log-detail', target],
    queryFn: () => api.get<any>(`/api/admin/${target!.kind === 'delivery' ? 'delivery-log' : 'inbound-log'}/${target!.id}`),
    enabled: !!target,
  });
  const d = q.data;
  const retry = async () => {
    setBusy(true);
    try {
      await api.post(`/api/admin/delivery-log/${target!.id}/retry`);
      toast('Requeued. It goes out on the next run of the queue.');
      qc.invalidateQueries({ queryKey: ['admin', 'delivery-log'] });
      qc.invalidateQueries({ queryKey: ['admin', 'log-detail'] });
      qc.invalidateQueries({ queryKey: ['admin', 'outbox'] });
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      width="max-w-3xl"
      title={target?.kind === 'inbound' ? 'Incoming message' : 'Outgoing delivery'}
      footer={
        <>
          {target?.kind === 'delivery' && d?.job?.canRetry && (
            <Button variant="primary" icon={<RotateCcw className="size-4" />} loading={busy} onClick={() => void retry()}>
              Retry delivery
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {!d ? (
        <Spinner />
      ) : target?.kind === 'delivery' ? (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
            <Row label="Subject">{d.job?.subject || '(no subject)'}</Row>
            <Row label="From">{d.job?.mailFrom ?? d.entry.user_email ?? '—'}</Row>
            <Row label="To">{d.job?.recipients?.join(', ') || d.entry.recipients}</Row>
            {d.job && (
              <>
                <Row label="Status">
                  <Badge tone={STATUS_TONE[d.job.status] ?? 'neutral'}>{d.job.status}</Badge> <span className="text-muted">after {d.job.attempts} attempt{d.job.attempts === 1 ? '' : 's'}</span>
                </Row>
                {d.job.providerName && <Row label="Provider">{d.job.providerName}{d.job.providerMessageId ? <span className="text-muted"> · id {d.job.providerMessageId}</span> : null}</Row>}
                {d.job.lastError && <Row label="Last error"><span className="text-danger">{d.job.lastError}</span></Row>}
                {d.job.status === 'queued' && <Row label="Next attempt">{relativeTime(d.job.nextAttemptAt)}</Row>}
                <Row label="Kind">{d.job.kind}</Row>
              </>
            )}
          </dl>
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Timeline</h3>
            <ol className="space-y-2 border-l-2 border-line pl-4">
              {d.timeline.map((t: any) => (
                <li key={t.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-panel bg-[var(--line-strong)]" />
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[t.event] ?? 'neutral'}>{t.event}</Badge>
                    <span className="text-xs text-muted">{longDate(t.created_at)}</span>
                    {t.provider_name && <span className="text-xs text-muted">via {t.provider_name}</span>}
                  </p>
                  {t.detail && <p className="mt-0.5 text-[13px] break-words text-muted">{t.detail}</p>}
                </li>
              ))}
            </ol>
          </section>
          <Headers text={d.headers} />
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
            <Row label="Result">
              <Badge tone={STATUS_TONE[d.entry.status] ?? 'neutral'}>{d.entry.status}</Badge> {d.entry.reason && <span className="text-muted">{d.entry.reason}</span>}
            </Row>
            <Row label="From">{d.entry.mail_from || '—'}</Row>
            <Row label="To">{d.entry.rcpt_to}</Row>
            <Row label="Subject">{d.entry.subject || '(no subject)'}</Row>
            <Row label="Arrived">{longDate(d.entry.created_at)} via {d.entry.provider_name ?? d.entry.source}</Row>
            {d.delivered && (
              <>
                <Row label="Delivered to">
                  {d.delivered.mailbox} · {d.delivered.folder}
                </Row>
                {d.delivered.spamScore !== null && <Row label="Spam score">{d.delivered.spamScore}</Row>}
                {d.delivered.authResults && (
                  <Row label="Authentication">
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(d.delivered.authResults as Record<string, string>).map(([k, v]) => (
                        <Badge key={k} tone={v === 'pass' ? 'ok' : v === 'none' ? 'neutral' : 'warn'}>
                          {k.toUpperCase()} {v}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                )}
              </>
            )}
          </dl>
          <Headers text={d.headers} />
        </div>
      )}
    </Modal>
  );
}

/** Message headers only: admins never see message bodies. */
function Headers({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold tracking-wider text-muted uppercase">Headers</h3>
      <p className="mb-2 text-xs text-muted">Only the headers are shown; message content stays private to the mailbox owner.</p>
      <pre className="max-h-72 overflow-auto rounded-xl border border-line bg-panel2 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">{text}</pre>
    </section>
  );
}
