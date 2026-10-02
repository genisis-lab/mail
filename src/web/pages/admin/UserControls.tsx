/**
 * Admin controls on a user's page: change their address, delete them (handing
 * their addresses to someone), out-of-office and forwarding, and mail export.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fileSize, number, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Field, IconButton, Input, Modal, Select, Switch, Textarea } from '../../components/ui';
import { useDomains } from './Users';

type Run = (fn: () => Promise<unknown>, msg: string) => Promise<void>;

/** New primary address; the old one can stay as an alias. */
export function RenameModal({ user, open, onClose, onDone }: { user: { id: number; email: string }; open: boolean; onClose: () => void; onDone: (email: string) => void }) {
  const toast = useToast();
  const domains = useDomains();
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState('');
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setLocal(user.email.split('@')[0]);
      setDomain(user.email.split('@')[1]);
      setKeep(true);
    }
  }
  const enabled = (domains.data ?? []).filter((d) => d.enabled);
  const next = `${local.trim().toLowerCase()}@${domain}`;
  const unchanged = next === user.email.toLowerCase();
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ email: string }>(`/api/admin/users/${user.id}/rename`, { email: next, keepOldAsAlias: keep });
      toast(`Address changed to ${r.email}`);
      onDone(r.email);
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change address"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!local.trim() || !domain || unchanged} onClick={() => void save()}>
            Change address
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Their sign-in name and main address become the new one. Mail, contacts, settings and signed-in devices stay as they are, and they get a note in their inbox.
        </p>
        <Field label="New address">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <Input value={local} onChange={(e) => setLocal(e.target.value)} aria-label="Name before the @" autoFocus spellCheck={false} />
            <span className="text-muted">@</span>
            <Select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
              {enabled.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Switch checked={keep} onChange={setKeep} label={`Keep ${user.email} as an alias`} description="Mail sent to the old address still reaches them, and they can reply from it. Turn off to free the old address." />
      </div>
    </Modal>
  );
}

/** Delete, optionally giving their addresses (and catch-all) to another account first. */
export function DeleteUserModal({ user, open, onClose, onDone }: { user: { id: number; email: string; messages: number }; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const users = useQuery({ queryKey: ['admin', 'users', ''], queryFn: () => api.get<{ users: { id: number; email: string; status: string }[] }>('/api/admin/users').then((r) => r.users), enabled: open });
  const [to, setTo] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const others = (users.data ?? []).filter((u) => u.id !== user.id && u.status === 'active');
  const go = async () => {
    setBusy(true);
    try {
      await api.del(`/api/admin/users/${user.id}${to ? `?transferTo=${to}` : ''}`);
      toast(to ? `${user.email} deleted; their addresses now reach ${others.find((o) => String(o.id) === to)?.email}` : `${user.email} deleted`);
      onDone();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Delete ${user.email}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={typed.trim().toLowerCase() !== user.email.toLowerCase()} onClick={() => void go()}>
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          This deletes the account and all of its mail ({number(user.messages)} messages). It can’t be undone; export their mail first if you might need it.
        </p>
        <Field label="Then send mail for their addresses to" help="Their address and aliases become aliases of this account, so nothing sent to them bounces. Their catch-alls move too.">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Nobody — the addresses stop working</option>
            {others.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Type ${user.email} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
      </div>
    </Modal>
  );
}

interface Vacation {
  enabled: boolean;
  subject: string;
  message: string;
  startAt: number | null;
  endAt: number | null;
  contactsOnly: boolean;
}
interface Forwarding {
  enabled: boolean;
  to: string;
  keep: 'inbox' | 'archive' | 'read' | 'trash';
}

const dayInput = (ts: number | null) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : '');
const endOfDay = (v: string) => (v ? new Date(`${v}T23:59:59`).getTime() : null);

/** Out-of-office reply and forwarding, set by an admin for someone who is away or has left. */
export function MailHandlingCard({ userId, value, onSaved }: { userId: number; value: { vacation: Vacation; forwarding: Forwarding }; onSaved: () => void }) {
  const toast = useToast();
  const [vacation, setVacation] = useState(value.vacation);
  const [forwarding, setForwarding] = useState(value.forwarding);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify({ vacation, forwarding }) !== JSON.stringify(value);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/admin/users/${userId}/mail-handling`, { vacation, forwarding });
      toast('Saved');
      onSaved();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Out of office and forwarding"
      description="For someone who’s away or has left. They see and can change these in their own settings."
      actions={
        <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Switch checked={vacation.enabled} onChange={(v) => setVacation({ ...vacation, enabled: v })} label="Automatic reply" description="Answers each sender once every few days." />
        {vacation.enabled && (
          <div className="grid gap-3">
            <Field label="Subject">
              <Input value={vacation.subject} onChange={(e) => setVacation({ ...vacation, subject: e.target.value })} placeholder="Out of office" />
            </Field>
            <Field label="Message">
              <Textarea rows={4} value={vacation.message} onChange={(e) => setVacation({ ...vacation, message: e.target.value })} placeholder="I’m away until Monday. For anything urgent, write to …" />
            </Field>
            <Field label="Until" help="Leave empty to keep replying until it’s turned off.">
              <Input type="date" value={dayInput(vacation.endAt)} onChange={(e) => setVacation({ ...vacation, endAt: endOfDay(e.target.value) })} />
            </Field>
          </div>
        )}
        <Switch checked={forwarding.enabled} onChange={(v) => setForwarding({ ...forwarding, enabled: v })} label="Forward their mail" description="Every message that arrives is also sent to another address." />
        {forwarding.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Forward to">
              <Input type="email" value={forwarding.to} onChange={(e) => setForwarding({ ...forwarding, to: e.target.value })} placeholder="colleague@example.com" />
            </Field>
            <Field label="Their copy">
              <Select value={forwarding.keep} onChange={(e) => setForwarding({ ...forwarding, keep: e.target.value as Forwarding['keep'] })}>
                <option value="inbox">Keep in inbox</option>
                <option value="read">Keep, marked read</option>
                <option value="archive">Archive it</option>
                <option value="trash">Move to trash</option>
              </Select>
            </Field>
          </div>
        )}
      </div>
    </Card>
  );
}

interface ExportJob {
  id: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: { messages?: number; bytes?: number };
  error: string | null;
  createdAt: number;
}

/** Export someone's mail as .mbox (when they leave, or for a legal hold). */
export function ExportCard({ userId, jobs, run }: { userId: number; jobs: ExportJob[]; run: Run }) {
  const running = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  return (
    <Card
      title="Mail export"
      description="All of their mail as one .mbox file, which Gmail, Outlook, Thunderbird and Apple Mail can import. They can see that an export was made."
      actions={
        <Button size="sm" disabled={running} onClick={() => void run(() => api.post(`/api/admin/users/${userId}/export`), 'Export started. It runs in the background.')}>
          {running ? 'Exporting…' : 'Export mail'}
        </Button>
      }
    >
      {jobs.length === 0 ? (
        <p className="text-sm text-muted">No exports yet.</p>
      ) : (
        <ul className="-my-1.5 divide-y divide-line text-sm">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p>
                  {relativeTime(j.createdAt)}{' '}
                  <Badge tone={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'danger' : 'neutral'}>{j.status === 'done' ? 'ready' : j.status}</Badge>
                </p>
                <p className="text-xs text-muted">
                  {j.progress.messages !== undefined ? `${number(j.progress.messages)} messages` : ''}
                  {j.progress.bytes ? ` · ${fileSize(j.progress.bytes)}` : ''}
                  {j.error ? ` · ${j.error}` : ''}
                </p>
              </div>
              {j.status === 'done' && (
                <a href={`/api/admin/users/${userId}/export/${j.id}/download`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">
                  <Download className="size-4" aria-hidden /> Download
                </a>
              )}
              <IconButton size="sm" label="Delete this export" onClick={() => void run(() => api.del(`/api/admin/users/${userId}/export/${j.id}`), 'Export deleted')}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
