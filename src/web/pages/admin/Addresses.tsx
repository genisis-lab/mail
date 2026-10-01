import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Select, Spinner, Switch, Tabs, Textarea } from '../../components/ui';
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
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<AddressRow> | null>(null);
  const q = useQuery({ queryKey: ['admin', 'addresses'], queryFn: () => api.get<{ addresses: AddressRow[] }>('/api/admin/addresses').then((r) => r.addresses) });

  return (
    <div>
      <PageHeader
        title="Aliases & groups"
        description="Aliases deliver to one mailbox and can be used as a From address. Groups (distribution lists) deliver to several people — including external addresses."
        actions={
          <>
            <Button icon={<Users className="size-4" />} onClick={() => setEditing({ kind: 'group', canSend: true, enabled: true, members: [] })}>
              New group
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'alias', canSend: true, enabled: true })}>
              New alias
            </Button>
          </>
        }
      />
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
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.kind === 'group' ? 'Acme Team' : ''} />
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
