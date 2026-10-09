import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Download, History, Megaphone, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fileSize, longDate, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Field, IconButton, Input, Select, Spinner, Switch, Textarea } from '../../components/ui';
import { useSession } from '../../lib/session';
import { PageHeader, Table } from './common';

export function AuditPage() {
  const q = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api.get<{ items: any[] }>('/api/admin/audit').then((r) => r.items) });
  const [filter, setFilter] = useState('');
  const items = (q.data ?? []).filter((i) => !filter || `${i.action} ${i.target} ${i.user_email ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <PageHeader title="Audit log" description="Security-relevant events: sign-ins, admin changes, provider edits, forwarding changes." />
      <Input className="mb-4 max-w-sm" placeholder="Filter events" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {q.isLoading ? (
        <Spinner />
      ) : (
        <Table head={['Time', 'Actor', 'Event', 'Target', 'IP']}>
          {items.map((i) => (
            <tr key={i.id} className="align-top">
              <td className="text-xs whitespace-nowrap text-muted" title={longDate(i.created_at)}>
                {relativeTime(i.created_at)}
              </td>
              <td className="text-xs">{i.user_email ?? '—'}</td>
              <td>
                <Badge tone={/failed/.test(i.action) ? 'danger' : /deleted|disabled|reset/.test(i.action) ? 'warn' : 'neutral'}>{i.action}</Badge>
              </td>
              <td className="max-w-80 text-xs break-words text-muted">
                {i.target}
                {i.details && Object.keys(i.details).length > 0 && <span className="block text-faint">{JSON.stringify(i.details)}</span>}
              </td>
              <td className="font-mono text-xs text-muted">{i.ip}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export function SystemPage() {
  const toast = useToast();
  const { user } = useSession();
  const q = useQuery({ queryKey: ['admin', 'system'], queryFn: () => api.get<any>('/api/admin/system') });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  if (q.isLoading || !q.data) return <Spinner />;
  const s = q.data;
  const selfHosted = !!s.selfHosted;
  const rows: [string, React.ReactNode][] = [
    ['Version', `Wren ${s.version}`],
    ['Runtime', s.platform],
    ['Message storage', s.blobStorage],
    ['Incoming mail', selfHosted ? 'Provider webhooks (for example Resend inbound)' : 'Cloudflare Email Routing → this Worker, plus any provider webhooks'],
    [
      'Cloudflare Email Service',
      s.emailBindings?.length ? (
        <Badge tone="ok">binding {s.emailBindings.join(', ')} available</Badge>
      ) : selfHosted ? (
        'Only available when deployed to Cloudflare'
      ) : (
        <Badge tone="warn">no send_email binding in wrangler.toml</Badge>
      ),
    ],
    ['Uptime', relativeTime(Date.now() - s.uptime).replace(' ago', '')],
    ['Public URL', s.publicUrl],
    [
      'Encryption key',
      s.keyMismatch ? (
        <Badge tone="danger">WREN_SECRET changed — encrypted settings can’t be read</Badge>
      ) : s.secretFromEnv ? (
        <Badge tone="ok">from WREN_SECRET</Badge>
      ) : (
        <span className="text-muted">Generated automatically, stored with the database</span>
      ),
    ],
    ['Database size', fileSize(s.storage.database)],
    ['Message store size', fileSize(s.storage.blobs)],
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="System & backup" />
      <Card title="System">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[180px_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <AutoBackupCard isOwner={user.role === 'owner'} />
      <BackupCard selfHosted={selfHosted} pointInTime={s.backup.pointInTime} rebuilding={s.backup.searchRebuilding} />
      <Card title="Announcement" description="Email every active user, e.g. about planned maintenance.">
        <div className="grid max-w-xl gap-3">
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
          </Field>
          <div>
            <Button
              icon={<Megaphone className="size-4" />}
              loading={busy}
              disabled={!subject.trim() || !body.trim()}
              onClick={async () => {
                if (!window.confirm('Send this announcement to every active user?')) return;
                setBusy(true);
                try {
                  const html = body
                    .split(/\n{2,}/)
                    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`)
                    .join('');
                  const r = await api.post<{ recipients: number }>('/api/admin/announce', { subject, html });
                  toast(`Announcement sent to ${r.recipients} user(s)`);
                  setSubject('');
                  setBody('');
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send announcement
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

async function uploadRestore(file: File, allowKeyMismatch: boolean) {
  const res = await fetch(`/api/admin/restore${allowKeyMismatch ? '?allowKeyMismatch=1' : ''}`, {
    method: 'POST',
    headers: { 'X-Wren': '1', 'Content-Type': 'application/x-ndjson' },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Restore failed (${res.status})`, res.status, data.error);
  return data as { exportedAt: number; rows: Record<string, number>; skipped: number; keyMismatch: boolean };
}

function toLocalInput(ts: number) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function BackupCard({ selfHosted, pointInTime, rebuilding }: { selfHosted: boolean; pointInTime: boolean; rebuilding: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'restore' | 'pit' | null>(null);
  const [at, setAt] = useState(() => toLocalInput(Date.now() - 3_600_000));
  const fileRef = useRef<HTMLInputElement>(null);

  const restore = async (file: File) => {
    if (!window.confirm(`Replace ALL data on this instance with “${file.name}”? Everyone, including you, will be signed out.`)) return;
    setBusy('restore');
    try {
      let r;
      try {
        r = await uploadRestore(file, false);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'key_mismatch')) throw err;
        const go = window.confirm(
          'This export was made with a different encryption key (WREN_SECRET). Provider credentials and two-factor secrets in it can’t be read here.\n\nRestore anyway? Two-factor sign-in will be turned off for all users and you’ll re-enter provider settings. (To keep them, set WREN_SECRET to the original instance’s key first.)',
        );
        if (!go) return;
        r = await uploadRestore(file, true);
      }
      const total = Object.values(r.rows).reduce((a, b) => a + b, 0);
      window.alert(`Restored ${total.toLocaleString()} records from ${new Date(r.exportedAt).toLocaleString()}.${r.skipped ? ` ${r.skipped} could not be restored.` : ''} Sign in again to continue.`);
      window.location.href = '/login';
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Backup & restore"
      description={
        selfHosted
          ? 'Exports are portable copies of the database you can restore here or on Cloudflare. Message files live in the /data volume, so back that up too.'
          : 'Cloudflare keeps 30 days of point-in-time history for the database automatically. Exports are portable copies you can keep anywhere and restore here. Message files stay in R2.'
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/admin/export">
            <Button icon={<Download className="size-4" />}>Download export</Button>
          </a>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.ndjson,.json,application/x-ndjson"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void restore(f);
            }}
          />
          <Button variant="ghost" icon={<Upload className="size-4" />} loading={busy === 'restore'} onClick={() => fileRef.current?.click()}>
            Restore from export…
          </Button>
          {rebuilding && <Badge tone="warn">Rebuilding the search index…</Badge>}
        </div>

        {pointInTime && (
          <div className="border-t border-line pt-4">
            <div className="mb-2 text-sm font-medium">Point-in-time recovery</div>
            <p className="mb-3 text-[13px] text-muted">
              Roll the whole database back to any moment in the last 30 days, for example after an accidental bulk delete. Files deleted in that window are kept, so restored messages keep their contents.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="datetime-local" aria-label="Moment to restore to" className="w-auto" value={at} max={toLocalInput(Date.now())} min={toLocalInput(Date.now() - 30 * 86_400_000)} onChange={(e) => setAt(e.target.value)} />
              <Button
                icon={<History className="size-4" />}
                loading={busy === 'pit'}
                onClick={async () => {
                  const ts = new Date(at).getTime();
                  if (!Number.isFinite(ts)) return;
                  if (!window.confirm(`Restore the database to ${new Date(ts).toLocaleString()}? Everything after that moment is undone.`)) return;
                  setBusy('pit');
                  try {
                    await api.post('/api/admin/restore-point', { at: ts });
                    toast('Restoring… the app will reload in a few seconds.');
                    setTimeout(() => window.location.reload(), 4000);
                  } catch (err) {
                    toast({ message: (err as Error).message, tone: 'error' });
                    setBusy(null);
                  }
                }}
              >
                Restore to this time
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

interface StoredBackup {
  id: number;
  kind: 'auto' | 'manual';
  status: 'running' | 'done' | 'failed';
  rows: number;
  bytes: number;
  parts: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  createdBy: string | null;
}

/** Daily backups kept in storage, plus backing up on demand. */
function AutoBackupCard({ isOwner }: { isOwner: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () => api.get<{ settings: { enabled: boolean; keep: number; hour: number }; nextAt: number | null; backups: StoredBackup[] }>('/api/admin/backups'),
    refetchInterval: (query) => (query.state.data?.backups.some((b) => b.status === 'running') ? 2000 : false),
  });
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'backups'] });
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.put('/api/admin/settings', patch);
      refresh();
      toast('Saved');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  if (!q.data) return null;
  const { settings, backups, nextAt } = q.data;
  const running = backups.some((b) => b.status === 'running');
  const restore = async (b: StoredBackup, allowKeyMismatch = false): Promise<void> => {
    if (!allowKeyMismatch && !window.confirm(`Replace ALL data with the backup from ${longDate(b.createdAt)}? Everything since then is lost, and everyone, including you, is signed out.`)) return;
    setBusy(b.id);
    try {
      const r = await api.post<{ rows: Record<string, number>; skipped: number; exportedAt: number }>(`/api/admin/backups/${b.id}/restore${allowKeyMismatch ? '?allowKeyMismatch=1' : ''}`);
      const total = Object.values(r.rows).reduce((x, y) => x + y, 0);
      window.alert(`Restored ${total.toLocaleString()} records from ${new Date(r.exportedAt).toLocaleString()}.${r.skipped ? ` ${r.skipped} could not be restored.` : ''} Sign in again to continue.`);
      window.location.href = '/login';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'key_mismatch' && !allowKeyMismatch) {
        if (window.confirm('This backup was made with a different encryption key (WREN_SECRET). Restore anyway? Two-factor sign-in will be turned off and provider settings must be re-entered.')) return restore(b, true);
      } else toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="Automatic backups"
      description="A copy of the database is saved to storage (R2) every day. Message files are already in R2 and are kept for 30 days after they’re deleted, so a restore brings messages back whole."
      actions={
        <Button
          icon={<DatabaseBackup className="size-4" />}
          loading={busy === 'new' || running}
          onClick={async () => {
            setBusy('new');
            try {
              await api.post('/api/admin/backups');
              refresh();
              toast('Backing up…');
            } catch (err) {
              toast({ message: (err as Error).message, tone: 'error' });
            } finally {
              setBusy(null);
            }
          }}
        >
          {running ? 'Backing up…' : 'Back up now'}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <Switch checked={settings.enabled} onChange={(v) => void save({ 'backups.enabled': v })} label="Back up every day" description={settings.enabled && nextAt ? `Next: ${longDate(nextAt)}` : undefined} />
          <Field label="Time (UTC)" className="w-32">
            <Select value={String(settings.hour)} disabled={!settings.enabled} onChange={(e) => void save({ 'backups.hour': Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep" className="w-36">
            <Select value={String(settings.keep)} disabled={!settings.enabled} onChange={(e) => void save({ 'backups.keep': Number(e.target.value) })}>
              {[3, 7, 14, 30, 60].map((n) => (
                <option key={n} value={n}>
                  last {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {backups.length === 0 ? (
          <p className="text-sm text-muted">No backups yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {backups.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {longDate(b.createdAt)} <span className="font-normal text-muted">· {b.kind === 'auto' ? 'daily' : `by ${b.createdBy ?? 'an admin'}`}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {b.status === 'done'
                      ? `${b.rows.toLocaleString()} records · ${fileSize(b.bytes)}`
                      : b.status === 'running'
                        ? `In progress · ${b.rows.toLocaleString()} records so far`
                        : `Failed: ${b.error ?? 'unknown error'}`}
                  </p>
                </div>
                <Badge tone={b.status === 'done' ? 'ok' : b.status === 'running' ? 'accent' : 'danger'}>{b.status === 'done' ? 'ready' : b.status === 'running' ? 'running' : 'failed'}</Badge>
                {b.status === 'done' && (
                  <>
                    <a href={`/api/admin/backups/${b.id}/download`}>
                      <Button size="sm" variant="ghost" icon={<Download className="size-4" />}>
                        Download
                      </Button>
                    </a>
                    {isOwner && (
                      <Button size="sm" variant="ghost" loading={busy === b.id} onClick={() => void restore(b)}>
                        Restore
                      </Button>
                    )}
                  </>
                )}
                {b.status !== 'running' && (
                  <IconButton
                    size="sm"
                    label={`Delete the backup from ${longDate(b.createdAt)}`}
                    onClick={async () => {
                      if (!window.confirm('Delete this backup?')) return;
                      await api.del(`/api/admin/backups/${b.id}`);
                      refresh();
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
