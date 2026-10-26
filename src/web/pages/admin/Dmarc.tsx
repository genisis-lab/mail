import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { number, relativeTime, shortDate } from '../../lib/format';
import { Badge, Card, cx, Empty, IconButton, Select, Spinner } from '../../components/ui';
import { PageHeader, Table } from './common';

interface FailingSource {
  ip: string;
  count: number;
  headerFrom: string[];
  dispositions: string[];
  reporters: string[];
}

interface DomainSummary {
  domain: string;
  policy: string;
  reports: number;
  reporters: number;
  lastReportAt: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
  dkimPassRate: number | null;
  spfPassRate: number | null;
  failingSources: FailingSource[];
}

interface ReportItem {
  id: number;
  org: string;
  reportId: string;
  domain: string;
  policy: string;
  begin: number;
  end: number;
  messages: number;
  passRate: number | null;
}

const rateTone = (r: number | null) => (r === null ? 'neutral' : r >= 98 ? 'ok' : r >= 90 ? 'warn' : 'danger');
const pct = (r: number | null) => (r === null ? '—' : `${r}%`);

export function DmarcPage() {
  const [days, setDays] = useState(30);
  const summary = useQuery({
    queryKey: ['admin', 'dmarc', days],
    queryFn: () => api.get<{ domains: DomainSummary[] }>(`/api/admin/dmarc${qs({ days })}`).then((r) => r.domains),
  });
  const reports = useQuery({
    queryKey: ['admin', 'dmarc', 'reports'],
    queryFn: () => api.get<{ items: ReportItem[] }>(`/api/admin/dmarc/reports${qs({ limit: 50 })}`).then((r) => r.items),
  });
  const refresh = () => {
    void summary.refetch();
    void reports.refetch();
  };
  const empty = !summary.data?.length && !reports.data?.length;
  return (
    <div>
      <PageHeader
        title="DMARC reports"
        description="What receiving mail servers report about mail sent as your domains: how much passed DMARC, and which servers send as you without passing."
        actions={
          <>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40" aria-label="Period">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
            </Select>
            <IconButton label="Refresh" onClick={refresh}>
              <RefreshCw className={cx('size-4', (summary.isFetching || reports.isFetching) && 'animate-spin')} />
            </IconButton>
          </>
        }
      />
      {summary.isLoading || reports.isLoading ? (
        <Spinner />
      ) : empty ? (
        <Card>
          <Empty icon={<ShieldCheck className="size-7" />} title="No reports yet">
            Each domain’s DMARC record asks receivers such as Gmail and Outlook to send daily reports to postmaster@yourdomain. They’re read here automatically as they arrive,
            usually within a day or so of mail being sent from the domain. Reports are kept for 180 days.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-6">
          {!summary.data?.length && <p className="text-sm text-muted">No reports cover the last {days} days. Choose a longer period to see older ones.</p>}
          {summary.data?.map((d) => <DomainCard key={d.domain} d={d} />)}
          {!!reports.data?.length && (
            <section>
              <h2 className="mb-3 text-[15px] font-semibold">Recent reports</h2>
              <Table head={['Receiver', 'Domain', 'Period', 'Messages', 'Passed']}>
                {reports.data.map((r) => (
                  <tr key={r.id} className="hover:bg-hover">
                    <td>
                      <div className="font-medium">{r.org}</div>
                      <div className="max-w-56 truncate text-[11px] text-faint" title={r.reportId}>
                        {r.reportId}
                      </div>
                    </td>
                    <td className="text-muted">{r.domain}</td>
                    <td className="whitespace-nowrap text-muted">
                      {shortDate(r.begin)} – {shortDate(r.end)}
                    </td>
                    <td className="tabular-nums">{number(r.messages)}</td>
                    <td>
                      <Badge tone={rateTone(r.passRate)}>{pct(r.passRate)}</Badge>
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function DomainCard({ d }: { d: DomainSummary }) {
  const tone = rateTone(d.passRate);
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {d.domain}
          <Badge>p={d.policy}</Badge>
        </span>
      }
      description={`${number(d.reports)} report${d.reports === 1 ? '' : 's'} from ${d.reporters} receiver${d.reporters === 1 ? '' : 's'} · latest ${relativeTime(d.lastReportAt)}`}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <div className="text-[13px] text-muted">Passed DMARC</div>
          <div className={cx('mt-1 text-2xl font-semibold tracking-tight', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : '')}>{pct(d.passRate)}</div>
        </div>
        <div>
          <div className="text-[13px] text-muted">Messages</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{number(d.total)}</div>
          <div className="text-xs text-muted">{number(d.failed)} failed</div>
        </div>
        <div>
          <div className="text-[13px] text-muted">DKIM aligned</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">{pct(d.dkimPassRate)}</div>
        </div>
        <div>
          <div className="text-[13px] text-muted">SPF aligned</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">{pct(d.spfPassRate)}</div>
        </div>
      </div>
      {d.total > 0 && (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-panel2" aria-hidden="true">
          <div className={cx('h-full rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-danger')} style={{ width: `${d.passRate ?? 0}%` }} />
        </div>
      )}
      <h3 className="mt-6 mb-2 text-sm font-semibold">Failing sources</h3>
      {d.failingSources.length ? (
        <>
          <p className="mb-3 text-[13px] text-muted">
            Servers whose mail as {d.domain} passed neither DKIM nor SPF. If you recognise one (a newsletter tool, a billing system), set it up to sign for your domain; otherwise it may be
            someone spoofing you.
          </p>
          <Table head={['Source IP', 'Messages', 'From', 'Receiver did', 'Reported by']} className="rounded-xl">
            {d.failingSources.map((s) => (
              <tr key={s.ip}>
                <td className="font-mono text-[12.5px]">{s.ip}</td>
                <td className="tabular-nums">{number(s.count)}</td>
                <td className="text-muted">{s.headerFrom.join(', ') || '—'}</td>
                <td>
                  {s.dispositions.map((x) => (
                    <Badge key={x} tone={x === 'reject' ? 'danger' : x === 'quarantine' ? 'warn' : 'neutral'} className="mr-1">
                      {x === 'none' ? 'delivered' : x}
                    </Badge>
                  ))}
                </td>
                <td className="text-xs text-muted">{s.reporters.join(', ')}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : (
        <p className="text-[13px] text-muted">Every reported message passed DMARC in this period.</p>
      )}
    </Card>
  );
}
