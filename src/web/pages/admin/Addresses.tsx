import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Inbox, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Checkbox, Empty, Field, IconButton, Input, Modal, Select, Spinner, Switch, Tabs, Textarea } from '../../components/ui';
import { PageHeader, Table } from './common';
import { useDomains } from './Users';

interface AddressRow {
  id: number;
  address: string;
  domain: string;
  kind: 'alias' | 'group';
  name: string;
  userId: number | null;
  userEmail: string | null;
  canSend: boolean;
  enabled: boolean;
  description: string;
  members: ({ userId: number; email: string } | { external: string })[];
}

export function AddressesPage() {
  const [tab, setTab] = useState<'addresses' | 'shared'>(() => (location.hash === '#shared' ? 'shared' : 'addresses'));
  return (
    <div>
      <PageHeader
        title="Aliases & groups"
        description={
          tab === 'shared'
            ? 'Shared mailboxes are inboxes a team reads together, like support@. Members switch to them from the mail sidebar; replies go out from the shared address.'
            : 'Aliases deliver to one mailbox and can be used as a From address. Groups (distribution lists) deliver to several people, including external addresses.'
        }
      />
      <div className="mb-5">
        <Tabs
          value={tab}
          onChange={(t) => {
            setTab(t);
            history.replaceState(null, '', t === 'shared' ? '#shared' : location.pathname);
          }}
          tabs={[
            { value: 'addresses', label: 'Aliases & groups' },
            { value: 'shared', label: 'Shared mailboxes' },
          ]}
        />
      </div>
      {tab === 'shared' ? <SharedMailboxes /> : <AliasesAndGroups />}
    </div>
  );
}

function AliasesAndGroups() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<AddressRow> | null>(null);
  const q = useQuery({ queryKey: ['admin', 'addresses'], queryFn: () => api.get<{ addresses: AddressRow[] }>('/api/admin/addresses').then((r) => r.addresses) });

  return (
    <div>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
          <>
            <Button icon={<Users className="size-4" />} onClick={() => setEditing({ kind: 'group', canSend: true, enabled: true, members: [] })}>
              New group
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'alias', canSend: true, enabled: true })}>
              New alias
            </Button>
          </>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <Card>
          <Empty icon={<AtSign className="size-7" />} title="No aliases or groups">
            Create addresses like hello@, support@ or team@ that route to your users.
          </Empty>
        </Card>
      ) : (
        <Table head={['Address', 'Type', 'Delivers to', 'Send as', '']}>
          {q.data.map((a) => (
            <tr key={a.id} className="hover:bg-hover">
              <td>
                <p className="font-medium">{a.address}</p>
                {(a.name || a.description) && <p className="text-xs text-muted">{a.name || a.description}</p>}
              </td>
              <td>
                <Badge tone={a.kind === 'group' ? 'accent' : 'neutral'}>{a.kind}</Badge> {!a.enabled && <Badge tone="warn">disabled</Badge>}
              </td>
              <td className="max-w-xs truncate text-muted">
                {a.kind === 'alias' ? a.userEmail : a.members.map((m) => ('email' in m ? m.email : m.external)).join(', ')}
              </td>
              <td>{a.canSend ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>}</td>
              <td className="text-right whitespace-nowrap">
                <IconButton size="sm" label="Edit" onClick={() => setEditing(a)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton
                  size="sm"
                  label="Delete"
                  onClick={async () => {
                    if (!window.confirm(`Delete ${a.address}? Mail to it will be rejected.`)) return;
                    await api.del(`/api/admin/addresses/${a.id}`);
                    qc.invalidateQueries({ queryKey: ['admin', 'addresses'] });
                    toast('Deleted');
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <AddressDialog value={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function AddressDialog({ value, onClose }: { value: Partial<AddressRow> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const users = useQuery({ queryKey: ['admin', 'users', ''], queryFn: () => api.get<{ users: any[] }>('/api/admin/users').then((r) => r.users) });
  const [form, setForm] = useState<any>(null);
  const [key, setKey] = useState<unknown>(null);
  const k = value ? value.id ?? `new-${value.kind}` : null;
  if (k !== key) {
    setKey(k);
    if (value) {
      const [local, dom] = (value.address ?? '@').split('@');
      setForm({
        kind: value.kind ?? 'alias',
        local: local ?? '',
        domain: dom || '',
        name: value.name ?? '',
        userId: value.userId ?? '',
        members: (value.members ?? []).map((m) => ('email' in m ? m.email : m.external)).join('\n'),
        canSend: value.canSend ?? true,
        enabled: value.enabled ?? true,
        description: value.description ?? '',
      });
    }
  }
  if (!value || !form) return null;
  const isNew = !value.id;
  const domain = form.domain || domains.data?.[0]?.name || '';
  const save = async () => {
    try {
      const members = String(form.members)
        .split(/[\n,;]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (isNew) {
        await api.post('/api/admin/addresses', {
          address: `${form.local}@${domain}`,
          kind: form.kind,
          name: form.name,
          userId: form.kind === 'alias' ? Number(form.userId) : null,
          members,
          canSend: form.canSend,
          enabled: form.enabled,
          description: form.description,
        });
      } else {
        await api.put(`/api/admin/addresses/${value.id}`, {
          name: form.name,
          userId: form.kind === 'alias' ? Number(form.userId) : undefined,
          members: form.kind === 'group' ? members : undefined,
          canSend: form.canSend,
          enabled: form.enabled,
          description: form.description,
        });
      }
      qc.invalidateQueries({ queryKey: ['admin', 'addresses'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast(isNew ? 'Created' : 'Saved');
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? (form.kind === 'group' ? 'New group' : 'New alias') : `Edit ${value.address}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {isNew && (
          <Tabs
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: v })}
            tabs={[
              { value: 'alias', label: 'Alias' },
              { value: 'group', label: 'Group / distribution list' },
            ]}
          />
        )}
        {isNew && (
          <Field label="Address">
            <div className="flex items-center gap-2">
              <Input value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value.toLowerCase() })} placeholder={form.kind === 'group' ? 'team' : 'hello'} autoFocus />
              <span className="text-muted">@</span>
              <Select value={domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className="w-56 shrink-0">
                {(domains.data ?? []).map((d) => (
                  <option key={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        <Field label="Display name" help="Used as the sender name when sending from this address.">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.kind === 'group' ? 'Design Team' : ''} />
        </Field>
        {form.kind === 'alias' ? (
          <Field label="Delivers to">
            <Select value={String(form.userId)} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              <option value="">Choose a mailbox…</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} <${u.email}>` : u.email}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Members" help="One address per line. Local users get mail directly; external addresses receive a forwarded copy.">
            <Textarea value={form.members} onChange={(e) => setForm({ ...form, members: e.target.value })} rows={5} placeholder={'alice@yourdomain.com\nbob@yourdomain.com\npartner@gmail.com'} />
          </Field>
        )}
        <Switch
          checked={form.canSend}
          onChange={(v) => setForm({ ...form, canSend: v })}
          label="Allow sending as this address"
          description={form.kind === 'group' ? 'Members can choose it as their From address.' : 'The mailbox owner can choose it as their From address.'}
        />
        <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
      </div>
    </Modal>
  );
}

// ── Shared mailboxes ────────────────────────────────────────────────────────

interface SharedMailbox {
  id: number;
  address: string;
  name: string;
  status: 'active' | 'suspended';
  usedBytes: number;
  quotaBytes: number;
  unread: number;
  members: { userId: number; email: string; name: string; canSend: boolean }[];
}

function SharedMailboxes() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<SharedMailbox> | null>(null);
  const q = useQuery({ queryKey: ['admin', 'shared'], queryFn: () => api.get<{ mailboxes: SharedMailbox[] }>('/api/admin/shared-mailboxes').then((r) => r.mailboxes) });
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ members: [] })}>
          New shared mailbox
        </Button>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <Card>
          <Empty icon={<Inbox className="size-7" />} title="No shared mailboxes">
            Create one for addresses a team answers together, like support@ or sales@. Unlike a group, everyone sees the same conversations and who replied.
          </Empty>
        </Card>
      ) : (
        <Table head={['Mailbox', 'Members', 'Unread', 'Storage', '']}>
          {q.data.map((b) => (
            <tr key={b.id} className="hover:bg-hover">
              <td>
                <p className="font-medium">{b.address}</p>
                <p className="text-xs text-muted">
                  {b.name} {b.status === 'suspended' && <Badge tone="warn">paused</Badge>}
                </p>
              </td>
              <td className="max-w-xs text-xs text-muted">
                {b.members.length === 0 ? <span className="text-warn">No members yet</span> : b.members.map((m) => `${m.email}${m.canSend ? '' : ' (read only)'}`).join(', ')}
              </td>
              <td className="tabular-nums">{b.unread || '—'}</td>
              <td className="text-xs whitespace-nowrap text-muted">
                {fileSize(b.usedBytes)} of {fileSize(b.quotaBytes)}
              </td>
              <td className="text-right whitespace-nowrap">
                <IconButton size="sm" label={`Edit ${b.address}`} onClick={() => setEditing(b)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`Delete ${b.address}`}
                  onClick={async () => {
                    if (window.prompt(`This deletes ${b.address} and all of its mail. Type the address to confirm.`) !== b.address) return;
                    await api.del(`/api/admin/shared-mailboxes/${b.id}`);
                    qc.invalidateQueries({ queryKey: ['admin', 'shared'] });
                    toast('Shared mailbox deleted');
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <SharedDialog value={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function SharedDialog({ value, onClose }: { value: Partial<SharedMailbox> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const users = useQuery({ queryKey: ['admin', 'users', ''], queryFn: () => api.get<{ users: { id: number; email: string; name: string }[] }>('/api/admin/users').then((r) => r.users) });
  const [form, setForm] = useState<{ local: string; domain: string; name: string; quotaMb: string; active: boolean; members: Map<number, boolean> } | null>(null);
  const [key, setKey] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const k = value ? value.id ?? 'new' : null;
  if (k !== key) {
    setKey(k);
    setFilter('');
    if (value) {
      const [local, dom] = (value.address ?? '@').split('@');
      setForm({
        local: local ?? '',
        domain: dom ?? '',
        name: value.name ?? '',
        quotaMb: '',
        active: value.status !== 'suspended',
        members: new Map((value.members ?? []).map((m) => [m.userId, m.canSend])),
      });
    }
  }
  if (!value || !form) return null;
  const isNew = !value.id;
  const domain = form.domain || domains.data?.[0]?.name || '';
  const people = (users.data ?? []).filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));
  const setMember = (id: number, v: boolean | null) =>
    setForm((f) => {
      const members = new Map(f!.members);
      if (v === null) members.delete(id);
      else members.set(id, v);
      return { ...f!, members };
    });
  const save = async () => {
    setBusy(true);
    try {
      const members = [...form.members].map(([userId, canSend]) => ({ userId, canSend }));
      if (isNew) {
        await api.post('/api/admin/shared-mailboxes', { address: `${form.local}@${domain}`, name: form.name, members, quotaMb: form.quotaMb ? Number(form.quotaMb) : null });
      } else {
        await api.put(`/api/admin/shared-mailboxes/${value.id}`, { name: form.name, members, status: form.active ? 'active' : 'suspended', ...(form.quotaMb ? { quotaMb: Number(form.quotaMb) } : {}) });
      }
      qc.invalidateQueries({ queryKey: ['admin', 'shared'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      toast(isNew ? 'Shared mailbox created' : 'Saved');
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New shared mailbox' : `Edit ${value.address}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim() || (isNew && !form.local)} onClick={() => void save()}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {isNew && (
          <Field label="Address">
            <div className="flex items-center gap-2 max-sm:flex-wrap">
              <Input value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value.toLowerCase() })} placeholder="support" autoFocus aria-label="Address before the @" />
              <span className="text-muted">@</span>
              <Select value={domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className="w-56 shrink-0 max-sm:w-full" aria-label="Domain">
                {(domains.data ?? []).map((d) => (
                  <option key={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        <Field label="Display name" help="Shown as the sender name on replies.">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Support team" />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Members ({form.members.size})</legend>
          {(users.data?.length ?? 0) > 8 && <Input className="mb-2" placeholder="Find people" aria-label="Find people" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <ul className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {people.map((u) => {
              const member = form.members.has(u.id);
              return (
                <li key={u.id} className="flex items-center gap-2 border-b border-line px-2 py-1 last:border-0">
                  <Checkbox checked={member} onChange={(v) => setMember(u.id, v ? true : null)} label={`Member: ${u.email}`} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {u.name} <span className="text-muted">{u.email}</span>
                  </span>
                  {member && (
                    <Select value={form.members.get(u.id) ? 'send' : 'read'} onChange={(e) => setMember(u.id, e.target.value === 'send')} className="w-36 shrink-0" aria-label={`Access for ${u.email}`}>
                      <option value="send">Read and send</option>
                      <option value="read">Read only</option>
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
        <Field label="Quota (MB)" help="Blank keeps the current quota (or the default for a new mailbox).">
          <Input type="number" min={1} value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: e.target.value })} className="max-w-40" />
        </Field>
        {!isNew && <Switch checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Receiving mail" description="Paused mailboxes reject new mail; members can still read what’s there." />}
      </div>
    </Modal>
  );
}
