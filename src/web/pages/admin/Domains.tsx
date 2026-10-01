import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle, Globe, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, Switch } from '../../components/ui';
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
        <Table head={['Domain', 'Outbound provider', 'Mailboxes', 'DNS', '']}>
          {domains.data.map((d) => {
            const dns = d.dns;
            const okCount = dns ? [dns.verification.ok, dns.mx.ok, dns.spf.ok, dns.dmarc.ok, ...(dns.dkim ?? []).map((k: any) => k.found)].filter(Boolean).length : 0;
            const total = dns ? 4 + (dns.dkim?.length ?? 0) : 0;
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
                <td className="text-xs text-muted">{dns ? `${okCount}/${total} records OK · ${relativeTime(d.dnsCheckedAt)}` : 'Not checked'}</td>
                <td className="text-right">
                  <Link to={`/admin/domains/${d.id}`} className="text-sm font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
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

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card title="DNS records" description="Create these at your DNS host (Cloudflare, Route 53, Namecheap…). Values from your provider’s dashboard take precedence.">
            <div className="space-y-4">
              {q.data.records.map((r: any, i: number) => (
                <div key={i} className="rounded-xl border border-line p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone="accent">{r.type}</Badge>
                    {r.priority !== undefined && <Badge>priority {r.priority}</Badge>}
                    {r.optional && <Badge>optional</Badge>}
                    <span className="text-xs text-muted">{r.purpose}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
                    <CopyField value={r.host} onCopy={() => toast('Copied')} />
                    <CopyField value={r.value} onCopy={() => toast('Copied')} />
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
                <Check ok={dns.spf.ok && dns.spf.includesProvider !== false} label="SPF">
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
                <Check ok={dns.dmarc.ok} label="DMARC">
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

        <div className="space-y-6">
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
        </div>
      </div>
    </div>
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
