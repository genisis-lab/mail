import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BellRing, CheckCircle2, ChevronDown, Circle, CircleDashed, Database, Globe, Info, Loader2, Mail, PlugZap, Send, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize, number, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, cx, Spinner, Stat } from '../../components/ui';
import { PageHeader, StatusDot } from './common';
import { useAlerts, type AlertItem } from './alerts';

interface ChecklistItem {
  id: string;
  title: string;
  status: 'done' | 'todo' | 'warn' | 'pending';
  detail: string;
  action?: { label: string; href?: string; api?: string };
  optional?: boolean;
}

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
                <Link to={w.link} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
                  Fix <ArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      <AlertsCard />
      <SetupChecklist />

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
            <Link to="/admin/providers" className="text-sm font-medium text-accent-ink hover:underline">
              Manage
            </Link>
          }
        >
          {d.providers.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">No providers yet. Connect Cloudflare, Resend, SES, Postmark, SMTP or another service to send and receive mail.</p>
              <Link to="/admin/providers" className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">
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
                      {/* The type only adds something when the name doesn't already say it. */}
                      {(recentError || p.typeName.toLowerCase() !== p.name.toLowerCase()) && (
                        <p className={cx('truncate text-xs', recentError ? 'text-danger' : 'text-muted')}>{recentError ? `Error: ${p.last_error}` : p.typeName}</p>
                      )}
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
            <Link to="/admin/system" className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">
              Backups & system <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

function AlertsCard() {
  const alerts = useAlerts();
  const qc = useQueryClient();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const open = alerts.data?.open ?? [];
  if (!open.length) return null;
  const tone = (a: AlertItem) => (a.severity === 'critical' ? 'danger' : a.severity === 'warn' ? 'warn' : 'muted');
  return (
    <Card
      className="mb-6 border-[color-mix(in_srgb,var(--danger)_30%,var(--line))]"
      title={
        <span className="flex items-center gap-2">
          <BellRing className="size-4 text-danger" /> {open.length === 1 ? '1 open alert' : `${open.length} open alerts`}
        </span>
      }
      description="Admins also get these in their inbox. Alerts clear on their own once the problem is gone."
      actions={
        <Button
          size="sm"
          loading={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await api.post('/api/admin/alerts/check');
              await qc.invalidateQueries({ queryKey: ['admin', 'alerts'] });
            } finally {
              setChecking(false);
            }
          }}
        >
          Check again
        </Button>
      }
    >
      <ul className="-my-2 divide-y divide-line" aria-live="polite">
        {open.map((a) => (
          <li key={a.id} className="flex items-start gap-3 py-3">
            <span className="mt-1.5">
              <StatusDot tone={tone(a)} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{a.title}</p>
              <p className="mt-0.5 text-[13px] text-muted">{a.detail}</p>
              <p className="mt-1 text-xs text-faint">
                Since {relativeTime(a.createdAt)}
                {a.updatedAt > a.createdAt + 60_000 ? ` · seen ${relativeTime(a.updatedAt)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
              {a.link && (
                <Link to={a.link} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">
                  Fix <ArrowRight className="size-3.5" />
                </Link>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api.post(`/api/admin/alerts/${a.id}/resolve`);
                  await qc.invalidateQueries({ queryKey: ['admin', 'alerts'] });
                  toast('Alert dismissed. It comes back if the problem is still there at the next check.');
                }}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const DISMISS_KEY = 'wren.checklist.hidden';

function SetupChecklist() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const q = useQuery({
    queryKey: ['admin', 'checklist'],
    queryFn: () => api.get<{ items: ChecklistItem[]; complete: boolean }>('/api/admin/checklist'),
    // Poll while a round-trip test is on its way back.
    refetchInterval: (query) => (query.state.data?.items.some((i) => i.status === 'pending' && i.id === 'roundtrip') ? 4000 : false),
  });
  if (!q.data) return null;
  const { items, complete } = q.data;
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.status === 'done').length;
  const setHide = (v: boolean) => {
    setHidden(v);
    try {
      localStorage.setItem(DISMISS_KEY, v ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  if (complete && hidden) {
    return (
      <button onClick={() => setHide(false)} className="mb-6 flex items-center gap-2 text-sm text-muted hover:text-fg">
        <CheckCircle2 className="size-4 text-ok" /> Setup complete <ChevronDown className="size-3.5" />
      </button>
    );
  }
  const run = async (item: ChecklistItem) => {
    if (!item.action?.api) return;
    setBusy(item.id);
    try {
      await api.post(item.action.api);
      await qc.invalidateQueries({ queryKey: ['admin', 'checklist'] });
      if (item.id === 'roundtrip') toast('Test message sent. Waiting for it to come back…');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const icon = (s: ChecklistItem['status']) =>
    s === 'done' ? (
      <CheckCircle2 className="size-5 text-ok" aria-label="Done" />
    ) : s === 'warn' ? (
      <AlertTriangle className="size-5 text-warn" aria-label="Needs attention" />
    ) : s === 'pending' ? (
      <CircleDashed className="size-5 animate-[spin_3s_linear_infinite] text-accent-ink" aria-label="In progress" />
    ) : (
      <Circle className="size-5 text-faint" aria-label="To do" />
    );
  return (
    <Card
      className="mb-6"
      title={complete ? 'Wren is ready' : 'Get Wren ready'}
      description={complete ? 'Everything required is set up. The optional steps make your server safer.' : `${done} of ${required.length} required steps done`}
      actions={
        complete ? (
          <Button size="sm" variant="ghost" onClick={() => setHide(true)}>
            Hide
          </Button>
        ) : undefined
      }
    >
      {!complete && (
        <div className="-mt-1 mb-4 h-1.5 overflow-hidden rounded-full bg-panel2" role="progressbar" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={done} aria-label="Setup progress">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(done / Math.max(1, required.length)) * 100}%` }} />
        </div>
      )}
      <ol className="-my-2 divide-y divide-line">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-3 py-3">
            <span className="mt-0.5 shrink-0">{icon(i.status)}</span>
            <div className="min-w-0 flex-1">
              <p className={cx('text-sm font-medium', i.status === 'done' && 'text-muted')}>
                {i.title} {i.optional && <span className="ml-1 text-xs font-normal text-faint">optional</span>}
              </p>
              <p className="mt-0.5 text-[13px] text-muted">{i.detail}</p>
            </div>
            {i.action &&
              (i.action.href ? (
                <Link to={i.action.href} className="shrink-0 text-sm font-medium text-accent-ink hover:underline">
                  {i.action.label}
                </Link>
              ) : (
                <Button size="sm" variant={i.status === 'done' ? 'ghost' : 'soft'} className="shrink-0" loading={busy === i.id} onClick={() => void run(i)}>
                  {i.action.label}
                </Button>
              ))}
            {i.status === 'pending' && i.id === 'roundtrip' && <Loader2 className="size-4 shrink-0 animate-spin text-muted" aria-hidden />}
          </li>
        ))}
      </ol>
    </Card>
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
        <button className="ml-auto font-medium text-accent-ink hover:underline" onClick={() => setAsTable((t) => !t)}>
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
