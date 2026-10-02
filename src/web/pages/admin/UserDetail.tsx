import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, KeyRound, LogOut, Mail, MonitorSmartphone, Pencil, ShieldCheck, ShieldOff, UserX } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize, longDate, number, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Avatar } from '../../components/Avatar';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Menu, Spinner } from '../../components/ui';
import { PageHeader } from './common';
import { EditUserModal, ResetPasswordModal, SignInLinkModal, type AdminUser } from './Users';

interface Detail {
  user: {
    id: number;
    email: string;
    name: string;
    role: AdminUser['role'];
    status: AdminUser['status'];
    createdAt: number;
    lastLoginAt: number | null;
    passwordChangedAt: number | null;
    totpEnabled: boolean;
    passkeys: number;
    recoveryEmail: string | null;
    recoveryVerified: boolean;
    usedBytes: number;
    quotaBytes: number;
    customQuota: boolean;
    sendLimitPerDay: number;
    customSendLimit: boolean;
    sentToday: number;
  };
  storage: { folders: { folder: string; c: number; bytes: number }[]; attachments: { c: number; bytes: number } | null };
  addresses: { id: number; address: string; kind: string; enabled: number; can_send: number; created_by: number | null }[];
  shared: { id: number; email: string; name: string; canSend: boolean }[];
  sessions: { id: string; ip: string | null; userAgent: string | null; createdAt: number; lastSeenAt: number }[];
  signIns: { action: string; ip: string | null; at: number; mfa: boolean; passkey?: boolean }[];
}

const FOLDER_NAMES: Record<string, string> = { inbox: 'Inbox', archive: 'Archive', sent: 'Sent', drafts: 'Drafts', spam: 'Spam', trash: 'Trash' };
const SIGN_IN: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.password_reset': 'Reset password',
  'auth.account_setup': 'Set up account',
};

/** "Chrome on macOS" from a user-agent string. */
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function UserDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useSession();
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState(false);
  const [link, setLink] = useState(false);
  const q = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.get<Detail>(`/api/admin/users/${id}/detail`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <Empty title="User not found">
          <Link to="/admin/users" className="text-accent-ink hover:underline">
            Back to users
          </Link>
        </Empty>
      </Card>
    );
  }
  const d = q.data;
  const u = d.user;
  const asAdminUser: AdminUser = { ...u, aliases: d.addresses.filter((a) => a.kind === 'alias').length, messages: d.storage.folders.reduce((n, f) => n + f.c, 0) };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'user', id] });
    qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  };
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      refresh();
      toast(msg);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const pct = Math.min(100, Math.round((u.usedBytes / u.quotaBytes) * 100));
  const self = u.id === me.id;

  return (
    <div>
      <button onClick={() => navigate('/admin/users')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Users
      </button>
      <PageHeader
        title={u.name || u.email}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {u.email}
            <Badge tone={u.role === 'user' ? 'neutral' : 'accent'}>{u.role}</Badge>
            {u.status === 'suspended' && <Badge tone="danger">suspended</Badge>}
            {self && <Badge>you</Badge>}
          </span>
        }
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Menu
              align="right"
              width="w-64"
              trigger={({ onClick }) => <Button onClick={onClick}>More</Button>}
              items={[
                { label: 'Send a sign-in link…', icon: <Mail className="size-4" />, onClick: () => setLink(true) },
                ...(u.recoveryEmail
                  ? [
                      {
                        label: `Email a password reset to ${u.recoveryEmail}`,
                        icon: <KeyRound className="size-4" />,
                        onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/reset-link`), `Reset link sent to ${u.recoveryEmail}`),
                      },
                    ]
                  : []),
                { label: 'Set a password…', icon: <KeyRound className="size-4" />, onClick: () => setPassword(true) },
                ...(u.totpEnabled ? [{ label: 'Reset 2-step verification', icon: <ShieldOff className="size-4" />, onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/reset-2fa`), '2-step verification reset') }] : []),
                ...(u.passkeys
                  ? [
                      {
                        label: `Remove ${u.passkeys === 1 ? 'their passkey' : `their ${u.passkeys} passkeys`}`,
                        icon: <ShieldOff className="size-4" />,
                        onClick: () => window.confirm(`Remove ${u.email}’s passkeys? They’ll sign in with their password until they add new ones.`) && void call(() => api.del(`/api/admin/users/${u.id}/passkeys`), 'Passkeys removed'),
                      },
                    ]
                  : []),
                { label: 'Sign out everywhere', icon: <LogOut className="size-4" />, onClick: () => void call(() => api.post(`/api/admin/users/${u.id}/signout`), 'Signed out of all sessions') },
                { divider: true },
                u.status === 'active'
                  ? { label: 'Suspend', icon: <UserX className="size-4" />, disabled: self || u.role === 'owner', onClick: () => void call(() => api.put(`/api/admin/users/${u.id}`, { status: 'suspended' }), `${u.email} suspended`) }
                  : { label: 'Reactivate', onClick: () => void call(() => api.put(`/api/admin/users/${u.id}`, { status: 'active' }), `${u.email} reactivated`) },
              ]}
            />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Account">
          <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted">Created</dt>
            <dd>{longDate(u.createdAt)}</dd>
            <dt className="text-muted">Last sign-in</dt>
            <dd>{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</dd>
            <dt className="text-muted">Password changed</dt>
            <dd>{u.passwordChangedAt ? relativeTime(u.passwordChangedAt) : '—'}</dd>
            <dt className="text-muted">2-step verification</dt>
            <dd className="flex items-center gap-1.5">{u.totpEnabled ? <><ShieldCheck className="size-4 text-ok" /> On</> : 'Off'}</dd>
            <dt className="text-muted">Passkeys</dt>
            <dd>{u.passkeys || 'None'}</dd>
            <dt className="text-muted">Recovery email</dt>
            <dd className="min-w-0 break-words">
              {u.recoveryEmail ? (
                <>
                  {u.recoveryEmail} {u.recoveryVerified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">not verified</Badge>}
                </>
              ) : (
                <span className="text-muted">None, so “Forgot password?” can’t help them</span>
              )}
            </dd>
          </dl>
        </Card>

        <Card title="Storage and sending">
          <div className="h-2 overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
            <div className={`h-full rounded-full ${pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.max(pct, 1)}%` }} />
          </div>
          <p className="mt-1.5 text-sm">
            {fileSize(u.usedBytes)} of {fileSize(u.quotaBytes)} ({pct}%){u.customQuota ? '' : ' · default quota'}
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-muted sm:grid-cols-3">
            {d.storage.folders.map((f) => (
              <li key={f.folder} className="flex justify-between gap-2">
                <span>{FOLDER_NAMES[f.folder] ?? f.folder}</span>
                <span className="tabular-nums">{number(f.c)}</span>
              </li>
            ))}
          </ul>
          {d.storage.attachments && d.storage.attachments.c > 0 && (
            <p className="mt-2 text-[13px] text-muted">
              {number(d.storage.attachments.c)} attachments, {fileSize(d.storage.attachments.bytes)}
            </p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-sm">
            Sent today: <b>{number(u.sentToday)}</b> of {number(u.sendLimitPerDay)} a day{u.customSendLimit ? '' : ' (default limit)'}
          </p>
        </Card>

        <Card title="Addresses" description="Where this person receives mail and what they can send as.">
          {d.addresses.length === 0 && d.shared.length === 0 ? (
            <p className="text-sm text-muted">Only their primary address.</p>
          ) : (
            <ul className="-my-1.5 divide-y divide-line text-sm">
              {d.addresses.map((a) => (
                <li key={`${a.kind}-${a.id}`} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{a.address}</span>
                  <Badge>{a.kind === 'group' ? 'group member' : a.kind}</Badge>
                  {a.created_by === u.id && <Badge tone="accent">self-service</Badge>}
                  {!a.enabled && <Badge tone="warn">disabled</Badge>}
                  {a.can_send ? null : <span className="text-xs text-muted">receive only</span>}
                </li>
              ))}
              {d.shared.map((b) => (
                <li key={`shared-${b.id}`} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{b.email}</span>
                  <Badge tone="accent">shared mailbox</Badge>
                  {!b.canSend && <span className="text-xs text-muted">read only</span>}
                </li>
              ))}
            </ul>
          )}
          <Link to="/admin/addresses" className="mt-3 inline-block text-sm font-medium text-accent-ink hover:underline">
            Manage aliases and shared mailboxes
          </Link>
        </Card>

        <Card title="Signed-in devices" description={d.sessions.length ? undefined : 'Not signed in anywhere right now.'}>
          {d.sessions.length > 0 && (
            <ul className="-my-1.5 divide-y divide-line text-sm">
              {d.sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2">
                  <MonitorSmartphone className="size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{device(s.userAgent)}</p>
                    <p className="text-xs text-muted">
                      {s.ip ?? 'unknown IP'} · active {relativeTime(s.lastSeenAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void call(() => api.del(`/api/admin/users/${u.id}/sessions/${s.id}`), 'Device signed out')}>
                    Sign out
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent sign-in activity" className="lg:col-span-2">
          {d.signIns.length === 0 ? (
            <p className="text-sm text-muted">No sign-ins yet.</p>
          ) : (
            <ul className="-my-1.5 divide-y divide-line text-sm">
              {d.signIns.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                  {s.action === 'auth.login_failed' ? <UserX className="size-4 text-danger" aria-hidden /> : <CheckCircle2 className="size-4 text-ok" aria-hidden />}
                  <span className={s.action === 'auth.login_failed' ? 'text-danger' : ''}>{SIGN_IN[s.action] ?? s.action}</span>
                  {s.mfa && <Badge tone="ok">2-step</Badge>}
                  {s.passkey && <Badge tone="ok">passkey</Badge>}
                  <span className="text-muted">{s.ip ?? ''}</span>
                  <span className="ml-auto text-xs text-muted">{longDate(s.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <EditUserModal user={editing ? asAdminUser : null} onClose={() => setEditing(false)} onSaved={refresh} />
      <ResetPasswordModal user={password ? asAdminUser : null} onClose={() => setPassword(false)} />
      <SignInLinkModal user={link ? asAdminUser : null} onClose={() => setLink(false)} />
    </div>
  );
}
