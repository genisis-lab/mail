import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, MoreVertical, Plus, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { csvRecords, download, pick, toCsv } from '../../lib/csv';
import { fileSize, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Avatar } from '../../components/Avatar';
import { useToast } from '../../components/toast';
import { Badge, Button, Checkbox, cx, Field, Input, Menu, Modal, Select, Spinner } from '../../components/ui';
import { CopyField, PageHeader, Table } from './common';

export interface AdminUser {
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
  recoveryEmail?: string | null;
}

export function useDomains() {
  return useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api.get<{ domains: any[] }>('/api/admin/domains').then((r) => r.domains) });
}

type BulkAction = 'suspend' | 'activate' | 'quota' | 'sendLimit' | 'signout' | 'delete';

export function UsersPage() {
  const { user: me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [linkFor, setLinkFor] = useState<AdminUser | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkValue, setBulkValue] = useState<{ action: 'quota' | 'sendLimit' } | null>(null);
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api.get<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`).then((r) => r.users) });
  const list = users.data ?? [];
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
  const allSelected = list.length > 0 && list.every((u) => selected.has(u.id));
  const toggle = (id: number, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  const bulk = async (action: BulkAction, value?: number | null) => {
    const ids = [...selected];
    if (action === 'delete') {
      const typed = window.prompt(`This permanently deletes ${ids.length} user(s) and all of their mail. Type DELETE to confirm.`);
      if (typed !== 'DELETE') return;
    }
    try {
      const r = await api.post<{ results: { email: string; ok: boolean; error?: string }[] }>('/api/admin/users/bulk', { ids, action, value });
      const failed = r.results.filter((x) => !x.ok);
      refresh();
      setSelected(new Set());
      const done = r.results.length - failed.length;
      toast(
        failed.length
          ? { message: `${done} updated. Skipped ${failed.map((f) => `${f.email} (${f.error})`).join(', ')}`, tone: done ? 'default' : 'error', duration: 9000 }
          : `${done} user${done === 1 ? '' : 's'} updated`,
      );
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
          <>
            <Button icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
              Add user
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input className="pl-9" placeholder="Search users" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 shadow-panel" role="toolbar" aria-label="Bulk actions">
          <span className="mr-1 text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" onClick={() => void bulk('suspend')}>
            Suspend
          </Button>
          <Button size="sm" onClick={() => void bulk('activate')}>
            Reactivate
          </Button>
          <Button size="sm" onClick={() => setBulkValue({ action: 'quota' })}>
            Set quota
          </Button>
          <Button size="sm" onClick={() => setBulkValue({ action: 'sendLimit' })}>
            Set send limit
          </Button>
          <Button size="sm" onClick={() => void bulk('signout')}>
            Sign out
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => void bulk('delete')}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" icon={<X className="size-4" />} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {users.isLoading ? (
        <Spinner />
      ) : (
        <Table
          head={[
            <Checkbox key="all" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={(v) => setSelected(v ? new Set(list.map((u) => u.id)) : new Set())} label="Select all users" />,
            <span key="user">User</span>,
            'Role',
            'Storage',
            'Last sign-in',
            '',
          ]}
        >
          {list.map((u) => {
            const pct = Math.min(100, Math.round((u.usedBytes / u.quotaBytes) * 100));
            return (
              <tr key={u.id} className={cx('cursor-pointer hover:bg-hover', selected.has(u.id) && 'bg-sel')} onClick={() => navigate(`/admin/users/${u.id}`)}>
                <td className="w-10 !pr-0" onClick={(e) => e.stopPropagation()}>
                  <Checkbox checked={selected.has(u.id)} onChange={(v) => toggle(u.id, v)} label={`Select ${u.email}`} />
                </td>
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.name} address={u.email} size={34} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <Link to={`/admin/users/${u.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {u.name || u.email}
                        </Link>
                        {u.id === me.id && <Badge>you</Badge>}
                        {u.status === 'suspended' && <Badge tone="danger">suspended</Badge>}
                        {u.totpEnabled && <ShieldCheck className="size-3.5 text-ok" aria-label="2-step verification on" />}
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
                  <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft max-sm:inline-block max-sm:w-28 max-sm:align-middle">
                    <div className={`h-full rounded-full ${pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted tabular-nums max-sm:ml-2 max-sm:inline">
                    {fileSize(u.usedBytes)} of {fileSize(u.quotaBytes)}
                  </p>
                </td>
                <td className="text-xs whitespace-nowrap text-muted">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</td>
                <td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <Menu
                    align="right"
                    trigger={({ onClick }) => (
                      <button onClick={onClick} aria-label={`Actions for ${u.email}`} className="rounded-full p-2 text-muted hover:bg-hover hover:text-fg">
                        <MoreVertical className="size-4" />
                      </button>
                    )}
                    items={[
                      { label: 'Open details', onClick: () => navigate(`/admin/users/${u.id}`) },
                      { label: 'Edit…', onClick: () => setEditing(u) },
                      { label: 'Send a sign-in link…', onClick: () => setLinkFor(u) },
                      { label: 'Set a password…', onClick: () => setResetting(u) },
                      ...(u.totpEnabled ? [{ label: 'Reset 2-step verification', onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/reset-2fa`), '2-step verification reset') }] : []),
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
      <ImportUsersModal open={importing} onClose={() => setImporting(false)} onImported={refresh} />
      <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
      <SignInLinkModal user={linkFor} onClose={() => setLinkFor(null)} />
      <BulkValueModal
        action={bulkValue?.action ?? null}
        count={selected.size}
        onClose={() => setBulkValue(null)}
        onApply={(v) => {
          const action = bulkValue!.action;
          setBulkValue(null);
          void bulk(action, v);
        }}
      />
    </div>
  );
}

function BulkValueModal({ action, count, onClose, onApply }: { action: 'quota' | 'sendLimit' | null; count: number; onClose: () => void; onApply: (v: number | null) => void }) {
  const [v, setV] = useState('');
  const quota = action === 'quota';
  return (
    <Modal
      open={!!action}
      onClose={onClose}
      title={quota ? 'Set mailbox quota' : 'Set daily send limit'}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onApply(null)}>
            Use the default
          </Button>
          <Button variant="primary" disabled={!v || Number(v) < (quota ? 1 : 0)} onClick={() => (onApply(Number(v)), setV(''))}>
            Apply to {count}
          </Button>
        </>
      }
    >
      <Field label={quota ? 'Quota (MB)' : 'Messages per day'} help={`For the ${count} selected user${count === 1 ? '' : 's'}.`}>
        <Input type="number" min={quota ? 1 : 0} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

/** One-time "choose your password" link: email it to the person, or copy it. */
export function SignInLinkModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  if (user && user.id !== lastId) {
    setLastId(user.id);
    setTo(user.recoveryEmail ?? '');
    setUrl(null);
  }
  const create = async (email: boolean) => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.post<{ url: string; sentTo: string | null }>(`/api/admin/users/${user.id}/setup-link`, email ? { sendTo: to } : {});
      setUrl(r.url);
      if (r.sentTo) toast(`Link sent to ${r.sentTo}`);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title="Send a sign-in link"
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" loading={busy} onClick={() => void create(false)}>
              Just create the link
            </Button>
            <Button variant="primary" loading={busy} disabled={!to.trim()} onClick={() => void create(true)}>
              Email the link
            </Button>
          </>
        )
      }
    >
      <p className="mb-4 text-sm text-muted">
        {user?.email} opens the link and chooses a new password. It works once and expires in 7 days; the current password keeps working until then.
      </p>
      {url ? (
        <Field label="One-time link" help="Share it privately. Anyone with it can set this account’s password.">
          <CopyField value={url} label="link" onCopy={() => toast('Link copied')} />
        </Field>
      ) : (
        <Field label="Send to" help="The person’s current email elsewhere (their new mailbox can’t receive the link if they can’t sign in).">
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@gmail.com" autoFocus />
        </Field>
      )}
    </Modal>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const domains = useDomains();
  const toast = useToast();
  const empty = { localPart: '', domain: '', name: '', password: '', setupEmail: '', how: 'link' as 'link' | 'password', role: 'user', quotaMb: '' };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; setupUrl: string | null; emailed: string | null } | null>(null);
  const domain = form.domain || domains.data?.[0]?.name || '';
  const close = () => {
    setCreated(null);
    setForm(empty);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={created ? 'User created' : 'Add user'}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              icon={<Plus className="size-4" />}
              disabled={!form.localPart || !form.name.trim() || (form.how === 'password' ? !form.password : !form.setupEmail.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  const email = `${form.localPart}@${domain}`;
                  const r = await api.post<{ id: number; setupUrl: string | null }>('/api/admin/users', {
                    email,
                    name: form.name,
                    ...(form.how === 'password' ? { password: form.password } : { setupEmail: form.setupEmail.trim() }),
                    role: form.role,
                    quotaMb: form.quotaMb ? Number(form.quotaMb) : null,
                  });
                  onCreated();
                  if (form.how === 'link') setCreated({ email, setupUrl: r.setupUrl ?? null, emailed: form.setupEmail.trim() });
                  else {
                    toast(`${email} created`);
                    close();
                  }
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
        )
      }
    >
      {created ? (
        <div className="space-y-4 text-sm">
          <p>
            <b>{created.email}</b> is ready. We emailed a link to <b>{created.emailed}</b> so they can choose a password; it expires in 7 days.
          </p>
          {created.setupUrl && (
            <Field label="Or share the link yourself">
              <CopyField value={created.setupUrl} label="link" onCopy={() => toast('Link copied')} />
            </Field>
          )}
        </div>
      ) : !domains.data?.length ? (
        <p className="text-sm text-muted">Add a domain first.</p>
      ) : (
        <div className="grid gap-4">
          <Field label="Full name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Email address">
            <div className="flex items-center gap-2 max-sm:flex-wrap">
              <Input value={form.localPart} onChange={(e) => setForm({ ...form, localPart: e.target.value.toLowerCase() })} placeholder="jane" aria-label="Address before the @" />
              <span className="text-muted">@</span>
              <Select value={domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className="w-56 shrink-0 max-sm:w-full" aria-label="Domain">
                {domains.data.map((d) => (
                  <option key={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">How they sign in the first time</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['link', 'Email them a setup link', 'They choose their own password.'],
                  ['password', 'Set a password', 'You share it with them.'],
                ] as const
              ).map(([v, title, sub]) => (
                <label key={v} className={cx('flex cursor-pointer gap-2 rounded-xl border p-3', form.how === v ? 'border-accent bg-accent-softer' : 'border-line hover:bg-hover')}>
                  <input type="radio" name="how" className="mt-1 accent-[var(--accent)]" checked={form.how === v} onChange={() => setForm({ ...form, how: v })} />
                  <span>
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted">{sub}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {form.how === 'link' ? (
            <Field label="Their current email" help="Also becomes their recovery email for “Forgot password?”.">
              <Input type="email" value={form.setupEmail} onChange={(e) => setForm({ ...form, setupEmail: e.target.value })} placeholder="jane@gmail.com" />
            </Field>
          ) : (
            <Field label="Temporary password" help="Share it securely; they can change it in Settings → Security.">
              <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="text" autoComplete="off" />
            </Field>
          )}
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

// ── CSV import ──────────────────────────────────────────────────────────────

interface ImportRow {
  email: string;
  name: string;
  password?: string;
  role?: 'user' | 'admin';
  quotaMb?: number | null;
  sendLimitPerDay?: number | null;
  setupEmail?: string;
}

interface RowResult {
  row: number;
  email: string;
  ok: boolean;
  error?: string;
  setupUrl?: string | null;
}

const SAMPLE = 'email,name,setup_email,password,role,quota_mb,send_limit\r\njane@example.com,Jane Doe,jane@gmail.com,,user,2048,\r\nsam@example.com,Sam Lee,,a long temporary passphrase,admin,,500\r\n';

function toRows(text: string): { rows: ImportRow[]; warning: string | null } {
  const { headers, records } = csvRecords(text);
  if (!headers.some((h) => ['email', 'address', 'emailaddress'].includes(h))) return { rows: [], warning: 'The first line must name the columns, including “email”.' };
  const num = (v: string) => (v && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  return {
    warning: null,
    rows: records.map((r) => {
      const role = pick(r, 'role').toLowerCase();
      return {
        email: pick(r, 'email', 'address', 'emailaddress'),
        name: pick(r, 'name', 'fullname', 'displayname'),
        password: pick(r, 'password', 'temporarypassword') || undefined,
        role: role === 'admin' || role === 'administrator' ? 'admin' : role ? 'user' : undefined,
        quotaMb: num(pick(r, 'quotamb', 'quota')),
        sendLimitPerDay: num(pick(r, 'sendlimit', 'sendlimitperday', 'dailylimit')),
        setupEmail: pick(r, 'setupemail', 'personalemail', 'recoveryemail', 'currentemail') || undefined,
      };
    }),
  };
}

function ImportUsersModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<RowResult[] | null>(null);
  const [done, setDone] = useState<RowResult[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const reset = () => {
    setRows([]);
    setFileName('');
    setCheck(null);
    setDone(null);
    setProgress(null);
    if (file.current) file.current.value = '';
  };
  const close = () => {
    reset();
    onClose();
  };
  // The server takes 100 rows per request (password hashing is slow); row numbers continue across batches.
  const send = async (list: ImportRow[], dryRun: boolean): Promise<RowResult[]> => {
    const out: RowResult[] = [];
    try {
      for (let i = 0; i < list.length; i += 100) {
        setProgress(i / list.length);
        const r = await api.post<{ results: RowResult[] }>('/api/admin/users/import', { rows: list.slice(i, i + 100), dryRun });
        out.push(...r.results.map((x) => ({ ...x, row: x.row + i })));
      }
    } finally {
      setProgress(null);
    }
    return out;
  };
  const load = async (f: File) => {
    reset();
    setFileName(f.name);
    const parsed = toRows(await f.text());
    if (parsed.warning) return toast({ message: parsed.warning, tone: 'error' });
    if (!parsed.rows.length) return toast({ message: 'The file has no rows', tone: 'error' });
    if (parsed.rows.length > 5000) return toast({ message: 'Import at most 5,000 users at a time', tone: 'error' });
    setRows(parsed.rows);
    try {
      setCheck(await send(parsed.rows, true));
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const checked = check?.filter((r) => r.ok).length ?? 0;
  const problems = (check ?? []).filter((r) => !r.ok);
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import users from CSV"
      width="max-w-2xl"
      footer={
        done ? (
          <>
            {done.some((r) => r.setupUrl) && (
              <Button onClick={() => download('wren-setup-links.csv', toCsv([['email', 'setup_link'], ...done.filter((r) => r.setupUrl).map((r) => [r.email, r.setupUrl])]))}>
                Download setup links
              </Button>
            )}
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!check || checked === 0 || progress !== null}
              loading={progress !== null && !!check}
              onClick={async () => {
                try {
                  // Only the rows that passed the check.
                  const good = new Set(check!.filter((r) => r.ok).map((r) => r.row));
                  setDone(await send(rows.filter((_, i) => good.has(i + 1)), false));
                  onImported();
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                }
              }}
            >
              Import {checked || ''} user{checked === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="space-y-3 text-sm" aria-live="polite">
          <p>
            Created <b>{done.filter((r) => r.ok).length}</b> user{done.filter((r) => r.ok).length === 1 ? '' : 's'}.
            {done.some((r) => r.setupUrl) && ' People with a setup email were sent a link to choose their password.'}
          </p>
          {done.some((r) => !r.ok) && <ResultList results={done.filter((r) => !r.ok)} />}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            One user per line. Columns: <code>email</code>, <code>name</code>, and either <code>setup_email</code> (we email them a link to choose a password) or <code>password</code>. Optional: <code>role</code>,{' '}
            <code>quota_mb</code>, <code>send_limit</code>.{' '}
            <button className="font-medium text-accent-ink hover:underline" onClick={() => download('wren-users-template.csv', SAMPLE)}>
              Download a template
            </button>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" id="wren-user-csv" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
            <label htmlFor="wren-user-csv" className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line-strong px-4 text-sm font-medium hover:bg-hover">
              <FileUp className="size-4" /> Choose file
            </label>
            {fileName && <span className="truncate text-muted">{fileName}</span>}
          </div>
          {progress !== null && (
            <div className="flex items-center gap-2 text-muted" aria-live="polite">
              <Spinner className="size-4" /> Checking {rows.length} row{rows.length === 1 ? '' : 's'}…
            </div>
          )}
          {check && (
            <div aria-live="polite">
              <p>
                <b>{checked}</b> of {check.length} row{check.length === 1 ? '' : 's'} ready to import.
                {problems.length > 0 && ' Rows with problems are skipped:'}
              </p>
              {problems.length > 0 && <ResultList results={problems} />}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ResultList({ results }: { results: RowResult[] }) {
  return (
    <ul className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-line text-[13px]">
      {results.map((r) => (
        <li key={r.row} className="flex gap-3 border-b border-line px-3 py-1.5 last:border-0">
          <span className="w-16 shrink-0 text-muted tabular-nums">Line {r.row + 1}</span>
          <span className="min-w-0 flex-1 truncate">{r.email || '(no email)'}</span>
          <span className="shrink-0 text-danger">{r.error}</span>
        </li>
      ))}
    </ul>
  );
}

export function EditUserModal({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => void }) {
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

export function ResetPasswordModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title="Set a password"
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
            Set password
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">They’re signed out everywhere and use this password next time. Prefer letting them choose? Send a sign-in link instead.</p>
      <Field label={`New password for ${user?.email}`}>
        <Input value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="off" />
      </Field>
    </Modal>
  );
}
