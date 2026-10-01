import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Search, XCircle } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { relativeTime, shortDate } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Empty, IconButton, Input, Select, Spinner, Tabs } from '../../components/ui';
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

export function LogsPage() {
  const [tab, setTab] = useState<'delivery' | 'inbound'>('delivery');
  const [status, setStatus] = useState('');
  const delivery = useQuery({ queryKey: ['admin', 'delivery-log'], queryFn: () => api.get<{ items: any[] }>('/api/admin/delivery-log').then((r) => r.items), enabled: tab === 'delivery' });
  const inbound = useQuery({
    queryKey: ['admin', 'inbound-log', status],
    queryFn: () => api.get<{ items: any[] }>(`/api/admin/inbound-log${qs({ status })}`).then((r) => r.items),
    enabled: tab === 'inbound',
  });
  return (
    <div>
      <PageHeader title="Delivery logs" description="What happened to every message going out and coming in (kept for 90 days)." />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'delivery', label: 'Outbound' },
            { value: 'inbound', label: 'Inbound' },
          ]}
        />
      </div>
      {tab === 'delivery' ? (
        delivery.isLoading ? (
          <Spinner />
        ) : !delivery.data?.length ? (
          <Empty title="No deliveries yet" />
        ) : (
          <Table head={['Time', 'Event', 'Message', 'Recipients', 'Detail']}>
            {delivery.data.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="text-xs whitespace-nowrap text-muted">{shortDate(l.created_at)}</td>
                <td>
                  <Badge tone={STATUS_TONE[l.event] ?? 'neutral'}>{l.event}</Badge>
                </td>
                <td className="max-w-56 truncate">{l.subject ?? '—'}</td>
                <td className="max-w-56 truncate text-xs text-muted">{l.recipients}</td>
                <td className="max-w-80 text-xs text-muted">
                  {l.provider_name && <span className="font-medium text-fg">{l.provider_name}: </span>}
                  {l.detail}
                </td>
              </tr>
            ))}
          </Table>
        )
      ) : (
        <>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="mb-4 w-48">
            <option value="">All results</option>
            <option value="accepted">Accepted</option>
            <option value="spam">Spam</option>
            <option value="rejected">Rejected</option>
            <option value="duplicate">Duplicate</option>
            <option value="error">Error</option>
          </Select>
          {inbound.isLoading ? (
            <Spinner />
          ) : !inbound.data?.length ? (
            <Empty title="No inbound mail logged yet" />
          ) : (
            <Table head={['Time', 'Result', 'From', 'To', 'Subject', 'Source']}>
              {inbound.data.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="text-xs whitespace-nowrap text-muted">{shortDate(l.created_at)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[l.status] ?? 'neutral'}>{l.status}</Badge>
                    {l.reason && <div className="mt-1 text-[11px] text-muted">{l.reason}</div>}
                  </td>
                  <td className="max-w-48 truncate text-xs">{l.mail_from || '—'}</td>
                  <td className="max-w-48 truncate text-xs">{l.rcpt_to}</td>
                  <td className="max-w-56 truncate">{l.subject}</td>
                  <td className="text-xs text-muted">{l.provider_name ?? l.source}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </div>
  );
}
