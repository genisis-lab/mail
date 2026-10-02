import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, Cloud, Globe, MinusCircle, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, cx, Empty, Field, IconButton, Input, Modal, Select, Spinner, Switch } from '../../components/ui';
import { CopyField, PageHeader, StatusDot, Table } from './common';
import { useDomains } from './Users';
import { useProviders } from './Providers';

export function DomainsPage() {
  const domains = useDomains();
  const providers = useProviders();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');

  return (
    <div>
      <PageHeader
        title="Domains"
        description="Custom domains hosted on this server. Each domain can send through its own provider."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add domain
          </Button>
        }
      />
      {domains.isLoading ? (
        <Spinner />
      ) : !domains.data?.length ? (
        <Card>
          <Empty icon={<Globe className="size-7" />} title="No domains yet">
            Add the domain you want to host mail for, then follow the DNS checklist.
          </Empty>
        </Card>
      ) : (
        <Table head={['Domain', 'Outbound provider', 'Mailboxes', 'DNS health', '']}>
          {domains.data.map((d) => {
            const dns = d.dns;
            return (
              <tr key={d.id} className="cursor-pointer hover:bg-hover" onClick={() => navigate(`/admin/domains/${d.id}`)}>
                <td>
                  <div className="flex items-center gap-2 font-medium">
                    <StatusDot tone={!d.enabled ? 'muted' : d.verified ? 'ok' : 'warn'} />
                    {d.name}
                    {!d.enabled && <Badge>disabled</Badge>}
                    {d.verified && <Badge tone="ok">verified</Badge>}
                  </div>
                  {d.catchAllEmail && <p className="ml-4 text-xs text-muted">Catch-all → {d.catchAllEmail}</p>}
                </td>
                <td className="text-muted">{d.providerName ?? <span className="text-faint">Default</span>}</td>
                <td className="text-muted tabular-nums">
                  {d.mailboxes} · {d.aliases} alias/group
                </td>
                <td className="text-xs text-muted">
                  {dns ? (
                    <>
                      <DnsBadges dns={dns} />
                      <span className="mt-1 block">checked {relativeTime(d.dnsCheckedAt)}</span>
                    </>
                  ) : (
                    'Not checked yet'
                  )}
                </td>
                <td className="text-right">
                  <Link to={`/admin/domains/${d.id}`} className="text-sm font-medium text-accent-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                    Configure
                  </Link>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add domain"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  const r = await api.post<{ id: number }>('/api/admin/domains', { name, providerId: providerId ? Number(providerId) : null });
                  qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
                  setAdding(false);
                  setName('');
                  navigate(`/admin/domains/${r.id}`);
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                }
              }}
            >
              Add domain
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="Domain name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" autoFocus />
          </Field>
          <Field label="Send through" help="You can change this later.">
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Default provider</option>
              {(providers.data ?? [])
                .filter((p) => p.outbound)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.typeName})
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/** MX / SPF / DKIM / DMARC at a glance. */
function DnsBadges({ dns }: { dns: any }) {
  const dkim = (dns.dkim ?? []) as { found: boolean }[];
  const items: [string, boolean | null][] = [
    ['MX', dns.mx.ok],
    ['SPF', dns.spf.ok && dns.spf.includesProvider !== false],
    ['DKIM', dkim.length ? dkim.some((k) => k.found) : null],
    ['DMARC', dns.dmarc.ok],
  ];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map(([name, ok]) => (
        <Badge key={name} tone={ok === null ? 'neutral' : ok ? 'ok' : name === 'DMARC' ? 'warn' : 'danger'}>
          <span aria-hidden>{ok === null ? '·' : ok ? '✓' : '✕'}</span> {name}
          <span className="sr-only">{ok === null ? (name === 'MX' ? 'not needed, sending only' : 'not checked') : ok ? 'OK' : 'missing'}</span>
        </Badge>
      ))}
    </span>
  );
}

function Check({ ok, label, children }: { ok: boolean | null; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-3">
      {ok === null ? <Circle className="mt-0.5 size-5 shrink-0 text-faint" /> : ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-danger" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {children && <div className="mt-1 text-[13px] text-muted">{children}</div>}
      </div>
    </div>
  );
}

export function DomainDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const providers = useProviders();
  const users = useQuery({ queryKey: ['admin', 'users', ''], queryFn: () => api.get<{ users: any[] }>('/api/admin/users').then((r) => r.users) });
  const q = useQuery({ queryKey: ['admin', 'domain', id], queryFn: () => api.get<{ domain: any; records: any[] }>(`/api/admin/domains/${id}`) });
  const [checking, setChecking] = useState(false);
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data.domain;
  const dns = d.dns;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'domain', id] });
    qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
  };
  const update = async (patch: Record<string, unknown>) => {
    try {
      await api.put(`/api/admin/domains/${d.id}`, patch);
      refresh();
      toast('Domain updated');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const check = async () => {
    setChecking(true);
    try {
      await api.post(`/api/admin/domains/${d.id}/check`);
      refresh();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setChecking(false);
    }
  };
  const outbound = (providers.data ?? []).filter((p) => p.outbound);
  const domainUsers = (users.data ?? []).filter((u) => u.email.endsWith(`@${d.name}`));

  return (
    <div>
      <button onClick={() => navigate('/admin/domains')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Domains
      </button>
      <PageHeader
        title={d.name}
        description={d.verified ? `Verified ${relativeTime(d.verifiedAt)}` : 'Ownership not verified yet — add the TXT record below.'}
        actions={
          <>
            <Button icon={<RefreshCw className={`size-4 ${checking ? 'animate-spin' : ''}`} />} onClick={check} disabled={checking}>
              Check DNS
            </Button>
            <Button
              variant="ghost"
              icon={<Trash2 className="size-4" />}
              onClick={async () => {
                if (!window.confirm(`Remove ${d.name}? Aliases and groups on it will be deleted.`)) return;
                try {
                  await api.del(`/api/admin/domains/${d.id}`);
                  qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
                  navigate('/admin/domains');
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Card title="DNS records" description="Create these at your DNS host (Cloudflare, Route 53, Namecheap…). Values from your provider’s dashboard take precedence.">
            <div className="space-y-4">
              {q.data.records.map((r: any, i: number) => (
                <div key={i} className="rounded-xl border border-line p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{r.type}</Badge>
                    {r.priority !== undefined && <Badge>priority {r.priority}</Badge>}
                    {r.optional && <Badge tone="neutral">optional</Badge>}
                  </div>
                  <p className="mb-2 text-xs leading-relaxed text-muted">{r.purpose}</p>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                    <CopyField value={r.host} label="host name" onCopy={() => toast('Host copied')} />
                    <CopyField value={r.value} label="value" onCopy={() => toast('Value copied')} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="DNS health" description={dns ? `Last checked ${relativeTime(d.dnsCheckedAt)}` : 'Run a check to see what’s configured.'}>
            {!dns ? (
              <Button onClick={check} loading={checking}>
                Check now
              </Button>
            ) : (
              <div className="-my-3 divide-y divide-line">
                <Check ok={dns.verification.ok} label="Ownership verification">
                  {dns.verification.ok ? 'TXT record found.' : `Add TXT ${'_wren.' + d.name} = ${dns.verification.expected}`}
                </Check>
                <Check ok={dns.mx.ok} label="MX (receiving)">
                  {dns.mx.hint}
                  {dns.mx.records.length > 0 && <div className="mt-1 font-mono text-xs">{dns.mx.records.map((m: any) => `${m.priority} ${m.exchange}`).join(' · ')}</div>}
                </Check>
                <Check ok={dns.spf.ok && dns.spf.includesProvider !== false} label={dns.spf.host && dns.spf.host !== d.name ? `SPF (${dns.spf.host})` : 'SPF'}>
                  {dns.spf.record ? <span className="font-mono text-xs break-all">{dns.spf.record}</span> : 'No SPF record found.'}
                  {dns.spf.includesProvider === false && <div className="mt-1 text-warn">Missing include:{dns.spf.expectedInclude} (fine if your provider uses its own return-path domain).</div>}
                </Check>
                {dns.dkim.length === 0 ? (
                  <Check ok={null} label="DKIM">
                    Set the DKIM selector your provider uses (right) to check it.
                  </Check>
                ) : (
                  dns.dkim.map((k: any) => (
                    <Check key={k.selector} ok={k.found} label={`DKIM (${k.selector})`}>
                      {k.found ? <span className="font-mono text-xs break-all">{String(k.value).slice(0, 120)}…</span> : `No record at ${k.selector}._domainkey.${d.name}`}
                    </Check>
                  ))
                )}
                <Check ok={dns.dmarc.ok} label={dns.dmarc.host && dns.dmarc.host !== d.name ? `DMARC (from ${dns.dmarc.host})` : 'DMARC'}>
                  {dns.dmarc.record ? (
                    <>
                      Policy: <b>{dns.dmarc.policy ?? 'unknown'}</b> <span className="font-mono text-xs break-all">{dns.dmarc.record}</span>
                    </>
                  ) : (
                    'No DMARC record — recommended for deliverability.'
                  )}
                </Check>
                {dns.errors.length > 0 && <p className="py-3 text-xs text-danger">{dns.errors.join('; ')}</p>}
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Sending">
            <div className="space-y-4">
              <Field label="Outbound provider">
                <Select value={d.providerId ?? ''} onChange={(e) => void update({ providerId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Default provider</option>
                  {outbound.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Fallback provider" help="Used automatically if the primary fails.">
                <Select value={d.fallbackProviderId ?? ''} onChange={(e) => void update({ fallbackProviderId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">None</option>
                  {outbound.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <DkimField value={d.dkimSelector ?? ''} onSave={(v) => void update({ dkimSelector: v || null })} />
              <SenderStatus domain={d.name} />
            </div>
          </Card>
          <Card title="Receiving">
            <div className="space-y-4">
              <Field label="Catch-all mailbox" help="Deliver mail for unknown addresses on this domain to one user.">
                <Select value={d.catchAllUserId ?? ''} onChange={(e) => void update({ catchAllUserId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Off — reject unknown addresses</option>
                  {domainUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Switch checked={d.enabled} onChange={(v) => void update({ enabled: v })} label="Domain enabled" description="Disabled domains don’t receive mail and can’t be sent from." />
            </div>
          </Card>
          <CatchAllCard domainId={d.id} domain={d.name} enabled={!!d.catchAllUserId} />
          <CloudflareCard domain={d} onDone={refresh} />
        </div>
      </div>
    </div>
  );
}

export interface SenderCheck {
  domain: string;
  provider: { id: number; name: string; type: string } | null;
  verified: boolean | null;
  detail: string;
}

/** What the sending provider says about a domain: verified there, missing, or unknown. */
export function useSenderCheck(domain: string | null | undefined) {
  return useQuery({
    queryKey: ['admin', 'sending-check', domain],
    queryFn: () => api.get<SenderCheck>(`/api/admin/sending-check?domain=${encodeURIComponent(domain ?? '')}`),
    enabled: !!domain,
    staleTime: 60_000,
  });
}

export function SenderStatus({ domain }: { domain: string | null | undefined }) {
  const q = useSenderCheck(domain);
  if (!domain || !q.data) return null;
  const { verified, detail } = q.data;
  const Icon = verified === null ? Circle : verified ? CheckCircle2 : AlertTriangle;
  return (
    <p className="flex gap-2 text-[13px] text-muted" role="status">
      <Icon className={cx('mt-0.5 size-4 shrink-0', verified === null ? 'text-faint' : verified ? 'text-ok' : 'text-warn')} aria-hidden />
      <span>{detail}</span>
    </p>
  );
}

interface CatchAllInfo {
  catchAllUserId: number | null;
  hits: { address: string; count: number; firstAt: number; lastAt: number; lastFrom: string; lastSubject: string; blocked: boolean }[];
  blocked: { address: string; createdAt: number }[];
}

/** What the catch-all has been taking, so a leaked or guessed address can be blocked, or made a real alias. */
function CatchAllCard({ domainId, domain, enabled }: { domainId: number; domain: string; enabled: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [block, setBlock] = useState('');
  const info = useQuery({ queryKey: ['admin', 'catchall', domainId], queryFn: () => api.get<CatchAllInfo>(`/api/admin/domains/${domainId}/catchall`) });
  const hits = info.data?.hits ?? [];
  const blocked = info.data?.blocked ?? [];
  if (!enabled && !blocked.length && !hits.length) return null;
  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ['admin', 'catchall', domainId] });
      qc.invalidateQueries({ queryKey: ['admin', 'addresses'] });
      toast(message);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const doBlock = (address: string) => run(() => api.post('/api/admin/blocked-recipients', { address }), `Mail to ${address} will be refused`);
  const unblock = (address: string) => run(() => api.del(`/api/admin/blocked-recipients/${encodeURIComponent(address)}`), `${address} unblocked`);
  return (
    <Card title="Catch-all activity" description="Addresses without a mailbox or alias that received mail through the catch-all. Block the ones that only get spam.">
      {info.isLoading ? (
        <Spinner />
      ) : hits.length === 0 ? (
        <p className="text-sm text-muted">{enabled ? 'Nothing yet. Mail to unknown addresses will be listed here.' : 'The catch-all is off.'}</p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {hits.map((h) => (
            <li key={h.address} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className={cx('text-sm font-medium break-all', h.blocked && 'text-muted line-through')}>{h.address}</p>
                <p className="truncate text-xs text-muted" title={`${h.lastFrom} — ${h.lastSubject}`}>
                  {h.count.toLocaleString()} message{h.count === 1 ? '' : 's'} · last {relativeTime(h.lastAt)} from {h.lastFrom || 'unknown'}
                  {h.lastSubject ? ` · “${h.lastSubject}”` : ''}
                </p>
              </div>
              {h.blocked ? (
                <Button size="sm" variant="ghost" onClick={() => void unblock(h.address)}>
                  Unblock
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => api.post('/api/admin/catchall/alias', { address: h.address }), `${h.address} is now an alias`)}>
                    Make alias
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void doBlock(h.address)}>
                    Block
                  </Button>
                </>
              )}
              <IconButton size="sm" label={`Hide ${h.address} from this list`} onClick={() => void run(() => api.del(`/api/admin/catchall/hits/${encodeURIComponent(h.address)}`), 'Hidden until it gets mail again')}>
                <XCircle className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 border-t border-line pt-4">
        <p className="text-[13px] font-medium">Blocked addresses</p>
        <p className="mt-0.5 text-xs text-muted">Mail to these is refused, even with the catch-all on.</p>
        {blocked.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {blocked.map((b) => (
              <li key={b.address} className="flex items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-3 text-[13px]">
                <span className="break-all">{b.address}</span>
                <IconButton size="sm" label={`Unblock ${b.address}`} onClick={() => void unblock(b.address)}>
                  <XCircle className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const a = block.includes('@') ? block.trim() : `${block.trim()}@${domain}`;
            void doBlock(a).then(() => setBlock(''));
          }}
        >
          <Input value={block} onChange={(e) => setBlock(e.target.value)} placeholder={`leaked@${domain}`} aria-label="Address to block" />
          <Button type="submit" disabled={!block.trim()}>
            Block
          </Button>
        </form>
      </div>
    </Card>
  );
}

function DkimField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <Field label="DKIM selector(s)" help="Comma-separated, e.g. resend or s1,s2. Used by the DNS check.">
      <div className="flex gap-2">
        <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="Provider default" />
        <Button disabled={v === value} onClick={() => onSave(v)}>
          Save
        </Button>
      </div>
    </Field>
  );
}

interface SetupStep {
  id: string;
  title: string;
  status: 'done' | 'skipped' | 'failed' | 'warn';
  detail: string;
}

/**
 * One-click Cloudflare setup: Email Routing to this Worker, plus Email Sending.
 * A domain whose mail goes somewhere else today is only switched after an
 * explicit confirmation.
 */
function CloudflareCard({ domain: d, onDone }: { domain: any; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cf = useQuery({ queryKey: ['admin', 'cloudflare'], queryFn: () => api.get<{ configured: boolean; workerName: string }>('/api/admin/cloudflare') });
  const [token, setToken] = useState('');
  const [worker, setWorker] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(true);
  const [confirmMx, setConfirmMx] = useState(false);
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [open, setOpen] = useState(false);
  const mx: { exchange: string }[] = d.dns?.mx.records ?? [];
  const elsewhere = mx.filter((m) => !/\.mx\.cloudflare\.net\.?$/i.test(m.exchange));
  const receivesElsewhere = elsewhere.length > 0;
  if (cf.isLoading) return null;

  const saveToken = async () => {
    setBusy(true);
    try {
      await api.put('/api/admin/cloudflare', { apiToken: token.trim(), ...(worker.trim() ? { workerName: worker.trim() } : {}) });
      setToken('');
      await qc.invalidateQueries({ queryKey: ['admin', 'cloudflare'] });
      toast('Cloudflare token saved');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    setBusy(true);
    setSteps(null);
    try {
      const r = await api.post<{ steps: SetupStep[] }>(`/api/admin/domains/${d.id}/cloudflare-setup`, { sending, replaceMx: receivesElsewhere && confirmMx });
      setSteps(r.steps);
      onDone();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // A domain that already receives elsewhere: keep this out of the way until asked for.
  if (receivesElsewhere && !open && !steps) {
    return (
      <Card title={<span className="flex items-center gap-2"><Cloud className="size-4 text-muted" /> Cloudflare</span>}>
        <p className="text-[13px] text-muted">
          {d.name} receives mail through {elsewhere.map((m) => m.exchange).join(', ')}. One-click Cloudflare setup would move it to Cloudflare Email Routing.
        </p>
        <Button size="sm" variant="ghost" className="mt-3 -ml-3" onClick={() => setOpen(true)}>
          Set up with Cloudflare anyway…
        </Button>
      </Card>
    );
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Cloud className="size-4 text-[#f38020]" /> Set up with Cloudflare</span>} description="Turns on Email Routing to this Worker and Email Sending for the domain, and creates the DNS records.">
      {!cf.data?.configured ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            Create an API token in the Cloudflare dashboard (My Profile → API Tokens) with <b>Zone: Read</b>, <b>DNS: Edit</b>, <b>Email Routing Rules: Edit</b>, <b>Zone Settings: Edit</b> and <b>Email Sending: Edit</b> for this zone. It’s stored encrypted.
          </p>
          <Field label="API token">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Worker name" help="As shown in Workers & Pages. Usually wren.">
            <Input value={worker} onChange={(e) => setWorker(e.target.value)} placeholder={cf.data?.workerName ?? 'wren'} />
          </Field>
          <Button variant="primary" size="sm" loading={busy} disabled={token.trim().length < 20} onClick={() => void saveToken()}>
            Save token
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Switch checked={sending} onChange={setSending} label="Also set up sending" description="Onboards the domain in Email Service so Wren can send through it." />
          {receivesElsewhere && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3 text-[13px]">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
                <span>
                  Mail for {d.name} goes to <b>{elsewhere.map((m) => m.exchange).join(', ')}</b> today. Turning on Email Routing replaces those MX records, and that service stops receiving it.
                </span>
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={confirmMx} onChange={(e) => setConfirmMx(e.target.checked)} />
                Yes, move this domain’s mail to Cloudflare
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" loading={busy} disabled={receivesElsewhere && !confirmMx} onClick={() => void run()}>
              {steps ? 'Run again' : 'Set up now'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!window.confirm('Remove the stored Cloudflare token?')) return;
                await api.del('/api/admin/cloudflare');
                await qc.invalidateQueries({ queryKey: ['admin', 'cloudflare'] });
              }}
            >
              Remove token
            </Button>
          </div>
          {steps && (
            <ol className="mt-1 space-y-2 border-t border-line pt-3" aria-live="polite">
              {steps.map((st) => (
                <li key={st.id} className="flex gap-2 text-[13px]">
                  {st.status === 'done' ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Done" />
                  ) : st.status === 'skipped' ? (
                    <MinusCircle className="mt-0.5 size-4 shrink-0 text-faint" aria-label="Already done" />
                  ) : st.status === 'warn' ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Needs attention" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />
                  )}
                  <span className="min-w-0">
                    <span className={cx('font-medium', st.status === 'failed' && 'text-danger')}>{st.title}</span>
                    <span className="block break-words text-muted">{st.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Card>
  );
}
