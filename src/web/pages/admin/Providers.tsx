import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ExternalLink, FlaskConical, PlugZap, Plus, RotateCw, Search, Send, Trash2, XCircle } from 'lucide-react';
import type { ProviderTypeInfo } from '../../../shared/types';
import { api } from '../../lib/api';
import { number, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, cx, Empty, Field, Input, Modal, Select, Spinner, Switch, Textarea } from '../../components/ui';
import { CopyField, PageHeader, StatusDot } from './common';

export interface ProviderRow {
  id: number;
  name: string;
  type: string;
  typeName: string;
  enabled: boolean;
  isDefault: boolean;
  outbound: boolean;
  inbound: boolean;
  inboundUrl: string | null;
  sentCount: number;
  failedCount: number;
  receivedCount: number;
  lastUsedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  domains: string[];
  config?: Record<string, string | number | boolean>;
}

export function useProviders() {
  return useQuery({ queryKey: ['admin', 'providers'], queryFn: () => api.get<{ providers: ProviderRow[] }>('/api/admin/providers').then((r) => r.providers) });
}

function useProviderTypes() {
  return useQuery({ queryKey: ['admin', 'provider-types'], queryFn: () => api.get<{ types: ProviderTypeInfo[] }>('/api/admin/provider-types').then((r) => r.types), staleTime: Infinity });
}

const CATEGORY_LABEL: Record<ProviderTypeInfo['category'], string> = {
  api: 'Email APIs',
  smtp: 'SMTP',
  'self-hosted': 'Self-hosted',
  inbound: 'Inbound only',
  other: 'Other',
};

function ProviderBadge({ name, className }: { name: string; className?: string }) {
  const letters = name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={cx('flex shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white', className ?? 'size-10')} style={{ background: `hsl(${h % 360} 55% 45%)` }}>
      {letters}
    </span>
  );
}

export function ProvidersPage() {
  const providers = useProviders();
  const types = useProviderTypes();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<{ type: ProviderTypeInfo; id?: number } | null>(null);

  return (
    <div>
      <PageHeader
        title="Providers"
        description="Connect the services Wren sends and receives mail through. Assign a provider per domain, or mark one as the default."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPicking(true)}>
            Add provider
          </Button>
        }
      />
      {providers.isLoading || types.isLoading ? (
        <Spinner />
      ) : !providers.data?.length ? (
        <Card>
          <Empty icon={<PlugZap className="size-7" />} title="No providers connected">
            Wren supports Cloudflare Email Service, Resend, Amazon SES, Postmark, SendGrid, Mailgun, Brevo and more — or plain SMTP.
            <div className="mt-4">
              <Button variant="primary" onClick={() => setPicking(true)}>
                Connect a provider
              </Button>
            </div>
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {providers.data.map((p) => {
            const t = types.data?.find((x) => x.type === p.type);
            const recentError = p.lastErrorAt && (!p.lastUsedAt || p.lastErrorAt > p.lastUsedAt);
            return (
              <button
                key={p.id}
                onClick={() => t && setEditing({ type: t, id: p.id })}
                className="flex flex-col rounded-2xl border border-line bg-panel p-5 text-left transition-shadow hover:shadow-panel"
              >
                <div className="flex items-start gap-3">
                  <ProviderBadge name={p.typeName} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold">
                      {p.name}
                      {p.isDefault && <Badge tone="accent">default</Badge>}
                      {!p.enabled && <Badge>disabled</Badge>}
                    </p>
                    {/* The type only when the name doesn't already say it; then what it's used for. */}
                    <p className="text-[13px] text-muted">
                      {p.name.toLowerCase() !== p.typeName.toLowerCase() ? `${p.typeName} · ` : ''}
                      {p.outbound && p.inbound ? 'Sending and receiving' : p.outbound ? 'Sending' : 'Receiving'}
                    </p>
                  </div>
                  <StatusDot tone={!p.enabled ? 'muted' : recentError ? 'danger' : 'ok'} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  {p.outbound && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-panel2 px-2 py-1">
                      <ArrowUpFromLine className="size-3" /> {number(p.sentCount)} sent
                    </span>
                  )}
                  {p.inbound && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-panel2 px-2 py-1">
                      <ArrowDownToLine className="size-3" /> {number(p.receivedCount)} received
                    </span>
                  )}
                  {p.failedCount > 0 && <span className="inline-flex items-center gap-1 rounded-md bg-panel2 px-2 py-1 text-danger">{number(p.failedCount)} failed</span>}
                </div>
                <p className="mt-3 truncate text-xs text-muted">
                  {recentError ? <span className="text-danger">Last error {relativeTime(p.lastErrorAt!)}: {p.lastError}</span> : p.domains.length ? `Used by ${p.domains.join(', ')}` : p.isDefault ? 'Used by domains without their own provider' : 'Not assigned to a domain'}
                </p>
              </button>
            );
          })}
        </div>
      )}
      <TypePicker open={picking} types={types.data ?? []} onClose={() => setPicking(false)} onPick={(t) => (setPicking(false), setEditing({ type: t }))} />
      {editing && <ProviderDialog type={editing.type} id={editing.id} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TypePicker({ open, types, onClose, onPick }: { open: boolean; types: ProviderTypeInfo[]; onClose: () => void; onPick: (t: ProviderTypeInfo) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const f = q.toLowerCase();
    const list = types.filter((t) => !f || t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f));
    return (Object.keys(CATEGORY_LABEL) as ProviderTypeInfo['category'][]).map((c) => ({ c, items: list.filter((t) => t.category === c) })).filter((g) => g.items.length);
  }, [types, q]);
  return (
    <Modal open={open} onClose={onClose} title="Add a provider" width="max-w-3xl">
      <div className="relative mb-4">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search providers" autoFocus />
      </div>
      <div className="max-h-[60vh] space-y-5 overflow-y-auto pb-4">
        {groups.map((g) => (
          <div key={g.c}>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{CATEGORY_LABEL[g.c]}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.items.map((t) => (
                <button key={t.type} onClick={() => onPick(t)} className="flex items-start gap-3 rounded-xl border border-line p-3 text-left hover:border-accent hover:bg-accent-softer">
                  <ProviderBadge name={t.name} className="size-9" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{t.name}</p>
                    <p className="line-clamp-2 text-xs text-muted">{t.description}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {t.recommended && <Badge tone="ok">recommended</Badge>}
                      {t.outbound && <Badge>send</Badge>}
                      {t.inbound ? <Badge>receive</Badge> : t.inboundVia ? <Badge>receive via {t.inboundVia}</Badge> : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ProviderDialog({ type, id, onClose }: { type: ProviderTypeInfo; id?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useSession();
  const [savedId, setSavedId] = useState<number | undefined>(id);
  const existing = useQuery({
    queryKey: ['admin', 'provider', savedId],
    queryFn: () => api.get<{ provider: ProviderRow }>(`/api/admin/providers/${savedId}`).then((r) => r.provider),
    enabled: !!savedId,
  });
  const [cfg, setCfg] = useState<Record<string, any> | null>(id ? null : Object.fromEntries(type.fields.map((f) => [f.key, f.default ?? (f.type === 'boolean' ? false : '')])));
  const [name, setName] = useState(id ? '' : type.name);
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testTo, setTestTo] = useState(user.email);
  const [testFrom, setTestFrom] = useState(user.email);

  if (id && existing.data && cfg === null) {
    setCfg(existing.data.config ?? {});
    setName(existing.data.name);
    setEnabled(existing.data.enabled);
    setIsDefault(existing.data.isDefault);
  }
  const provider = existing.data;
  const inboundUrl = provider?.inboundUrl;

  const save = async () => {
    setBusy(true);
    try {
      if (savedId) await api.put(`/api/admin/providers/${savedId}`, { name, enabled, isDefault, config: cfg ?? {} });
      else {
        const r = await api.post<{ id: number }>('/api/admin/providers', { name, type: type.type, enabled, isDefault, config: cfg ?? {} });
        setSavedId(r.id);
      }
      qc.invalidateQueries({ queryKey: ['admin', 'providers'] });
      qc.invalidateQueries({ queryKey: ['admin', 'provider'] });
      toast(savedId ? 'Provider saved' : 'Connected — send a test email to confirm it works');
      if (savedId) onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setResult(null);
    const r = await api.post<{ ok: boolean; message: string }>(`/api/admin/providers/${savedId}/verify`);
    setResult(r);
  };
  const test = async () => {
    setResult(null);
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/admin/providers/${savedId}/test`, { from: testFrom, to: testTo });
      setResult(r);
      qc.invalidateQueries({ queryKey: ['admin', 'providers'] });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const shownUrl = inboundUrl;
  const setupText = (s?: string) => (s ?? '').replace(/\{\{url\}\}/g, shownUrl ?? 'the webhook URL (shown once you save)');

  return (
    <Modal open onClose={onClose} title={id ? `Edit ${provider?.name ?? type.name}` : `Connect ${type.name}`} width="max-w-2xl">
      {id && !cfg ? (
        <Spinner />
      ) : (
        <div className="space-y-5 pb-2">
          <div className="flex items-start gap-3 rounded-xl bg-panel2 p-3">
            <ProviderBadge name={type.name} className="size-9" />
            <div className="min-w-0 text-[13px]">
              <p className="text-muted">{type.description}</p>
              {type.website && (
                <a href={type.website} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
                  {new URL(type.website).hostname} <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>

          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {type.presets && type.presets.length > 0 && (
            <Field label="Preset" help="Fills in host and port for well-known services.">
              <Select
                defaultValue=""
                onChange={(e) => {
                  const p = type.presets!.find((x) => x.label === e.target.value);
                  if (p) setCfg((c) => ({ ...(c ?? {}), ...p.values }));
                }}
              >
                <option value="">Choose a preset…</option>
                {type.presets.map((p) => (
                  <option key={p.label}>{p.label}</option>
                ))}
              </Select>
            </Field>
          )}

          {type.fields.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {type.fields.map((f) => {
                const v = cfg?.[f.key];
                const set = (val: unknown) => setCfg((c) => ({ ...(c ?? {}), [f.key]: val }));
                const wide = f.type === 'textarea' || f.type === 'url' || f.type === 'password' || f.inbound;
                if (f.type === 'boolean') {
                  return (
                    <div key={f.key} className="sm:col-span-2">
                      <Switch checked={!!v} onChange={set} label={f.label} description={f.help} />
                    </div>
                  );
                }
                return (
                  <Field
                    key={f.key}
                    className={wide ? 'sm:col-span-2' : ''}
                    label={
                      <>
                        {f.label} {f.required && <span className="text-danger">*</span>} {f.inbound && <Badge>inbound</Badge>}
                      </>
                    }
                    help={f.help}
                  >
                    {f.type === 'select' ? (
                      <Select value={String(v ?? '')} onChange={(e) => set(e.target.value)}>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    ) : f.type === 'textarea' ? (
                      <Textarea value={String(v ?? '')} onChange={(e) => set(e.target.value)} className="font-mono text-xs" />
                    ) : (
                      <Input
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        value={String(v ?? '')}
                        placeholder={f.placeholder}
                        autoComplete="off"
                        onFocus={(e) => f.type === 'password' && e.target.value === '••••••••' && e.target.select()}
                        onChange={(e) => set(f.type === 'number' ? e.target.value : e.target.value)}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-6">
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
            {type.outbound && <Switch checked={isDefault} onChange={setIsDefault} label="Default outbound provider" description="Used by domains without their own provider." />}
          </div>

          {type.outbound && type.outboundSetup && (
            <div className="rounded-xl border border-line p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <ArrowUpFromLine className="size-4 text-muted" /> Sending setup
              </p>
              <p className="text-[13px] leading-relaxed text-muted">{type.outboundSetup}</p>
            </div>
          )}
          {type.inbound && (
            <div className="rounded-xl border border-line p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <ArrowDownToLine className="size-4 text-muted" /> Receiving setup
              </p>
              <p className="mb-3 text-[13px] leading-relaxed text-muted">{setupText(type.inboundSetup)}</p>
              {shownUrl ? (
                <>
                  <CopyField value={shownUrl} onCopy={() => toast('Inbound URL copied')} />
                  <p className="mt-2 text-xs text-faint">Keep this URL secret — anyone with it can deliver mail to your users.</p>
                  {savedId && (
                    <button
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline"
                      onClick={async () => {
                        if (!window.confirm('Generate a new URL? The old one stops working immediately.')) return;
                        await api.post(`/api/admin/providers/${savedId}/rotate-token`);
                        qc.invalidateQueries({ queryKey: ['admin', 'provider', savedId] });
                        qc.invalidateQueries({ queryKey: ['admin', 'providers'] });
                      }}
                    >
                      <RotateCw className="size-3" /> Rotate URL
                    </button>
                  )}
                </>
              ) : (
                <p className="text-xs text-faint">Save the provider to get its inbound webhook URL.</p>
              )}
            </div>
          )}

          {type.outbound && type.eventsSetup && (
            <div className="rounded-xl border border-line p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Activity className="size-4 text-muted" /> Delivery status
              </p>
              <p className="mb-3 text-[13px] leading-relaxed text-muted">
                {type.eventsWebhook ? 'Bounces and spam complaints show in the delivery log, and those addresses aren’t mailed again. ' : ''}
                {setupText(type.eventsSetup)}
              </p>
              {type.eventsWebhook &&
                (shownUrl ? (
                  !type.inbound && <CopyField value={shownUrl} onCopy={() => toast('Webhook URL copied')} />
                ) : (
                  <p className="text-xs text-faint">Save the provider to get its webhook URL.</p>
                ))}
            </div>
          )}

          {savedId && type.outbound && (
            <div className="rounded-xl border border-line p-4">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <FlaskConical className="size-4 text-muted" /> Test connection
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From">
                  <Input value={testFrom} onChange={(e) => setTestFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                </Field>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={verify}>
                  Verify credentials
                </Button>
                <Button size="sm" icon={<Send className="size-3.5" />} onClick={test} loading={busy}>
                  Send test email
                </Button>
              </div>
            </div>
          )}
          {result && (
            <div className={cx('flex items-start gap-2 rounded-xl px-4 py-3 text-[13px]', result.ok ? 'bg-[color-mix(in_srgb,var(--ok)_10%,transparent)]' : 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]')}>
              {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
              <span className="break-words">{result.message}</span>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-line pt-4">
            {savedId && (
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                onClick={async () => {
                  if (!window.confirm('Delete this provider? Domains using it fall back to the default.')) return;
                  await api.del(`/api/admin/providers/${savedId}`);
                  qc.invalidateQueries({ queryKey: ['admin', 'providers'] });
                  onClose();
                }}
              >
                Delete
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              {savedId && !id ? 'Done' : 'Cancel'}
            </Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {savedId ? 'Save' : 'Connect'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
