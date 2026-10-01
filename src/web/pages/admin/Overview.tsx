import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Database, Globe, Info, Mail, PlugZap, Send, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize, number, relativeTime } from '../../lib/format';
import { Badge, Card, cx, Spinner, Stat } from '../../components/ui';
import { PageHeader, StatusDot } from './common';

interface OverviewData {
  version: string;
  uptime: number;
  users: { total: number; active: number; suspended: number; admins: number };
  domains: { total: number; verified: number; enabled: number };
  series: { date: number; received: number; sent: number; failed: number }[];
  queue: { queued: number | null; sending: number | null; failed24h: number | null };
  last24: { received: number; sent: number; rejected: number; spam: number };
  providers: { id: number; name: string; type: string; typeName: string; enabled: number; is_default: number; sent_count: number; failed_count: number; received_count: number; last_used_at: number | null; last_error: string | null; last_error_at: number | null }[];
  storage: { database: number; blobs: number };
  warnings: { level: 'info' | 'warn'; message: string; link?: string }[];
}

export function Overview() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<OverviewData>('/api/admin/overview'), refetchInterval: 30_000 });
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="Overview" description={`Wren ${d.version} · up ${relativeTime(Date.now() - d.uptime).replace(' ago', '')}`} />

      {d.warnings.length > 0 && (
        <div className="mb-6 space-y-2">
          {d.warnings.map((w, i) => (
            <div
              key={i}
              className={cx(
                'flex items-center gap-3 rounded-xl border px-4 py-3 text-sm',
                w.level === 'warn'
                  ? 'border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)]'
                  : 'border-line bg-panel',
              )}
            >
              {w.level === 'warn' ? <AlertTriangle className="size-4 shrink-0 text-warn" /> : <Info className="size-4 shrink-0 text-muted" />}
              <span className="flex-1">{w.message}</span>
              {w.link && (
                <Link to={w.link} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                  Fix <ArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Users" icon={<Users className="size-4" />} value={number(d.users.total)} sub={`${d.users.active} active · ${d.users.admins} admin${d.users.admins === 1 ? '' : 's'}`} />
        <Stat label="Domains" icon={<Globe className="size-4" />} value={number(d.domains.total)} sub={`${d.domains.verified ?? 0} verified`} />
        <Stat label="Received (24h)" icon={<Mail className="size-4" />} value={number(d.last24.received)} sub={`${d.last24.spam} spam · ${d.last24.rejected} rejected`} />
        <Stat
          label="Sent (24h)"
          icon={<Send className="size-4" />}
          value={number(d.last24.sent)}
          sub={
            <span className="flex items-center gap-1.5">
              {(d.queue.failed24h ?? 0) > 0 && <AlertTriangle className="size-3.5 text-danger" />}
              {d.queue.queued ?? 0} queued · {d.queue.failed24h ?? 0} failed
            </span>
          }
        />
      </div>

      <Card title="Mail volume" description="Messages received and sent per day, last 14 days" className="mb-6">
        <VolumeChart series={d.series} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card
          title="Providers"
          actions={
            <Link to="/admin/providers" className="text-sm font-medium text-accent hover:underline">
              Manage
            </Link>
          }
        >
          {d.providers.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">No providers yet. Connect Cloudflare, Resend, SES, Postmark, SMTP or another service to send and receive mail.</p>
              <Link to="/admin/providers" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                <PlugZap className="size-4" /> Add a provider
              </Link>
            </div>
          ) : (
            <ul className="-my-2 divide-y divide-line">
              {d.providers.map((p) => {
                const recentError = p.last_error_at && (!p.last_used_at || p.last_error_at > p.last_used_at);
                return (
                  <li key={p.id} className="flex items-center gap-3 py-2.5">
                    <StatusDot tone={!p.enabled ? 'muted' : recentError ? 'danger' : 'ok'} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {p.name} {p.is_default ? <Badge tone="accent">default</Badge> : null}
                      </p>
                      <p className="truncate text-xs text-muted">{recentError ? `Error: ${p.last_error}` : p.typeName}</p>
                    </div>
                    <div className="text-right text-xs text-muted tabular-nums">
                      <div>{number(p.sent_count)} sent</div>
                      <div>{number(p.received_count)} received</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Storage">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Database className="size-5 text-muted" />
              <div className="flex-1">
                <p className="text-sm">Database</p>
                <p className="text-xs text-muted">Messages, settings, logs</p>
              </div>
              <span className="text-sm font-semibold">{fileSize(d.storage.database)}</span>
            </div>
            <div className="flex items-center gap-3">
              <Mail className="size-5 text-muted" />
              <div className="flex-1">
                <p className="text-sm">Message store</p>
                <p className="text-xs text-muted">Raw messages and attachments</p>
              </div>
              <span className="text-sm font-semibold">{fileSize(d.storage.blobs)}</span>
            </div>
            <Link to="/admin/system" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
              Backups & system <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Grouped columns: received (series 1) and sent (series 2) per day, with hover tooltip and table view. */
function VolumeChart({ series }: { series: OverviewData['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...series.flatMap((s) => [s.received, s.sent]));
  const ticks = useMemo(() => {
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  }, [max]);
  const top = ticks[ticks.length - 1] || 1;
  const H = 200;
  const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div>
      <div className="mb-3 flex items-center gap-5 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--series-1)]" /> Received
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--series-2)]" /> Sent
        </span>
        <button className="ml-auto font-medium text-accent hover:underline" onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'View as chart' : 'View as table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 font-medium">Day</th>
                <th className="py-2 text-right font-medium">Received</th>
                <th className="py-2 text-right font-medium">Sent</th>
                <th className="py-2 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((s) => (
                <tr key={s.date} className="border-b border-line last:border-0">
                  <td className="py-1.5">{day(s.date)}</td>
                  <td className="py-1.5 text-right">{number(s.received)}</td>
                  <td className="py-1.5 text-right">{number(s.sent)}</td>
                  <td className="py-1.5 text-right">{number(s.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative w-10 shrink-0 text-right text-[11px] text-muted tabular-nums" style={{ height: H }}>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: H - (t / top) * H }}>
                {number(t)}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="relative" style={{ height: H }}>
              {ticks.map((t) => (
                <div key={t} className="absolute right-0 left-0 h-px" style={{ top: H - (t / top) * H, background: t === 0 ? 'var(--axis)' : 'var(--grid)' }} />
              ))}
              <div className="absolute inset-0 flex">
                {series.map((s, i) => (
                  <div
                    key={s.date}
                    className="relative flex flex-1 items-end justify-center gap-[2px]"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  >
                    {hover === i && <div className="absolute inset-y-0 inset-x-[2px] rounded-md bg-hover" />}
                    {(['received', 'sent'] as const).map((k, j) => {
                      const v = s[k];
                      const h = v ? Math.max(2, (v / top) * H) : 0;
                      return (
                        <div
                          key={k}
                          className="relative w-full max-w-3 rounded-t-[4px]"
                          style={{ height: h, background: j === 0 ? 'var(--series-1)' : 'var(--series-2)' }}
                        />
                      );
                    })}
                    {hover === i && (
                      <div
                        className={cx(
                          'pointer-events-none absolute bottom-full z-10 mb-2 w-40 rounded-lg border border-line bg-panel p-3 text-xs shadow-float',
                          i > series.length / 2 ? 'right-0' : 'left-0',
                        )}
                      >
                        <p className="mb-1.5 font-semibold">{day(s.date)}</p>
                        <p className="flex items-center gap-2">
                          <span className="size-2 rounded-[2px] bg-[var(--series-1)]" /> Received <span className="ml-auto font-medium tabular-nums">{number(s.received)}</span>
                        </p>
                        <p className="flex items-center gap-2">
                          <span className="size-2 rounded-[2px] bg-[var(--series-2)]" /> Sent <span className="ml-auto font-medium tabular-nums">{number(s.sent)}</span>
                        </p>
                        {s.failed > 0 && (
                          <p className="mt-1 flex items-center gap-2 text-danger">
                            <AlertTriangle className="size-3" /> Failed <span className="ml-auto font-medium tabular-nums">{number(s.failed)}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2 flex text-[11px] text-muted">
              {series.map((s, i) => (
                <span key={s.date} className="flex-1 text-center">
                  {i % 2 === series.length % 2 ? day(s.date) : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
