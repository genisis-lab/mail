import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Plus, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Avatar } from '../../components/Avatar';
import { useToast } from '../../components/toast';
import { Badge, Button, Field, Input, Menu, Modal, Select, Spinner } from '../../components/ui';
import { PageHeader, Table } from './common';

interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'user';
  status: 'active' | 'suspended';
  usedBytes: number;
  quotaBytes: number;
  customQuota: boolean;
  sendLimitPerDay: number;
  customSendLimit: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  aliases: number;
  messages: number;
}

export function useDomains() {
  return useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api.get<{ domains: any[] }>('/api/admin/domains').then((r) => r.domains) });
}

export function UsersPage() {
  const { user: me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api.get<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`).then((r) => r.users) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      refresh();
      toast(msg);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };

  return (
    <div>
      <PageHeader
        title="Users"
        description="Mailboxes on this server. Each user gets a primary address and can have aliases."
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
            Add user
          </Button>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input className="pl-9" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {users.isLoading ? (
        <Spinner />
      ) : (
        <Table head={['User', 'Role', 'Storage', 'Last sign-in', '']}>
          {(users.data ?? []).map((u) => {
            const pct = Math.min(100, Math.round((u.usedBytes / u.quotaBytes) * 100));
            return (
              <tr key={u.id} className="hover:bg-hover">
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.name} address={u.email} size={34} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {u.name || u.email}
                        {u.id === me.id && <Badge>you</Badge>}
                        {u.status === 'suspended' && <Badge tone="danger">suspended</Badge>}
                        {u.totpEnabled && <ShieldCheck className="size-3.5 text-ok" aria-label="2FA enabled" />}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {u.email}
                        {u.aliases ? ` · ${u.aliases} alias${u.aliases > 1 ? 'es' : ''}` : ''}
                      </p>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge tone={u.role === 'user' ? 'neutral' : 'accent'}>{u.role}</Badge>
                </td>
                <td className="w-48">
                  <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft">
                    <div className={`h-full rounded-full ${pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted tabular-nums">
                    {fileSize(u.usedBytes)} of {fileSize(u.quotaBytes)}
                  </p>
                </td>
                <td className="text-xs whitespace-nowrap text-muted">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</td>
                <td className="text-right">
                  <Menu
                    align="right"
                    trigger={({ onClick }) => (
                      <button onClick={onClick} aria-label="User actions" className="rounded-full p-2 text-muted hover:bg-hover hover:text-fg">
                        <MoreVertical className="size-4" />
                      </button>
                    )}
                    items={[
                      { label: 'Edit…', onClick: () => setEditing(u) },
                      { label: 'Reset password…', onClick: () => setResetting(u) },
                      ...(u.totpEnabled ? [{ label: 'Reset 2-step verification', onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/reset-2fa`), '2FA reset') }] : []),
                      { label: 'Sign out everywhere', onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/signout`), 'Signed out of all sessions') },
                      { divider: true },
                      u.status === 'active'
                        ? { label: 'Suspend', disabled: u.id === me.id, onClick: () => void call(() => api.put(`/api/admin/users/${u.id}`, { status: 'suspended' }), `${u.email} suspended`) }
                        : { label: 'Reactivate', onClick: () => void call(() => api.put(`/api/admin/users/${u.id}`, { status: 'active' }), `${u.email} reactivated`) },
                      {
                        label: 'Delete user',
                        danger: true,
                        disabled: u.id === me.id || u.role === 'owner',
                        onClick: () => {
                          if (window.prompt(`This permanently deletes ${u.email} and all of their mail (${u.messages} messages). Type the address to confirm.`) === u.email) {
                            void call(() => api.del(`/api/admin/users/${u.id}`), 'User deleted');
                          }
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <CreateUserModal open={creating} onClose={() => setCreating(false)} onCreated={refresh} />
      <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const domains = useDomains();
  const toast = useToast();
  const [form, setForm] = useState({ localPart: '', domain: '', name: '', password: '', role: 'user', quotaMb: '' });
  const [busy, setBusy] = useState(false);
  const domain = form.domain || domains.data?.[0]?.name || '';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add user"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<Plus className="size-4" />}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/admin/users', {
                  email: `${form.localPart}@${domain}`,
                  name: form.name,
                  password: form.password,
                  role: form.role,
                  quotaMb: form.quotaMb ? Number(form.quotaMb) : null,
                });
                toast(`${form.localPart}@${domain} created`);
                setForm({ localPart: '', domain: '', name: '', password: '', role: 'user', quotaMb: '' });
                onCreated();
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Create user
          </Button>
        </>
      }
    >
      {!domains.data?.length ? (
        <p className="text-sm text-muted">Add a domain first.</p>
      ) : (
        <div className="grid gap-4">
          <Field label="Full name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Email address">
            <div className="flex items-center gap-2">
              <Input value={form.localPart} onChange={(e) => setForm({ ...form, localPart: e.target.value.toLowerCase() })} placeholder="jane" />
              <span className="text-muted">@</span>
              <Select value={domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className="w-56 shrink-0">
                {domains.data.map((d) => (
                  <option key={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="Temporary password" help="Share it securely; the user can change it in Settings → Security.">
            <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="text" autoComplete="off" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </Select>
            </Field>
            <Field label="Quota (MB)" help="Blank = default">
              <Input type="number" min={1} value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { user: me } = useSession();
  const [form, setForm] = useState<{ name: string; role: string; quotaMb: string; sendLimit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  if (user && user.id !== lastId) {
    setLastId(user.id);
    setForm({
      name: user.name,
      role: user.role,
      quotaMb: user.customQuota ? String(Math.round(user.quotaBytes / 1024 / 1024)) : '',
      sendLimit: user.customSendLimit ? String(user.sendLimitPerDay) : '',
    });
  }
  if (!user && lastId !== null) setLastId(null);
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Edit ${user?.email ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!user || !form) return;
              setBusy(true);
              try {
                await api.put(`/api/admin/users/${user.id}`, {
                  name: form.name,
                  ...(form.role !== user.role ? { role: form.role } : {}),
                  quotaMb: form.quotaMb ? Number(form.quotaMb) : null,
                  sendLimitPerDay: form.sendLimit ? Number(form.sendLimit) : null,
                });
                onSaved();
                onClose();
                toast('User updated');
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {form && user && (
        <div className="grid gap-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={form.role} disabled={user.id === me.id} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
              {me.role === 'owner' && <option value="owner">Owner</option>}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mailbox quota (MB)" help={`Blank = default. Using ${fileSize(user.usedBytes)}.`}>
              <Input type="number" min={1} value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: e.target.value })} />
            </Field>
            <Field label="Daily send limit" help="Blank = default.">
              <Input type="number" min={0} value={form.sendLimit} onChange={(e) => setForm({ ...form, sendLimit: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title="Reset password"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api.post(`/api/admin/users/${user!.id}/password`, { password: pw });
                toast('Password reset. The user was signed out everywhere.');
                setPw('');
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              }
            }}
          >
            Reset password
          </Button>
        </>
      }
    >
      <Field label={`New password for ${user?.email}`}>
        <Input value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="off" />
      </Field>
    </Modal>
  );
}
