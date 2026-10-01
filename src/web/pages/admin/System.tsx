import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, History, Megaphone, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fileSize, longDate, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Field, Input, Spinner, Textarea } from '../../components/ui';
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
  const q = useQuery({ queryKey: ['admin', 'system'], queryFn: () => api.get<any>('/api/admin/system') });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  if (q.isLoading || !q.data) return <Spinner />;
  const s = q.data;
  const workers = s.runtime === 'workers';
  const rows: [string, React.ReactNode][] = [
    ['Version', `Wren ${s.version}`],
    ['Runtime', s.platform],
    ...(workers
      ? ([
          ['Message storage', s.blobStorage],
          ['Email Routing', 'Inbound mail arrives through this Worker’s email() handler'],
          ['send_email binding', s.emailBinding ? <Badge tone="ok">bound as EMAIL</Badge> : <Badge>not bound</Badge>],
        ] as [string, React.ReactNode][])
      : ([
          ['Node.js', s.node],
          ['Memory', fileSize(s.memory)],
          ['Data directory', <code className="text-xs">{s.dataDir}</code>],
          [
            'SMTP (MX)',
            s.smtp.enabled ? (
              <>
                Listening on port {s.smtp.port} as <b>{s.smtp.hostname}</b> {s.smtp.tls ? <Badge tone="ok">STARTTLS</Badge> : <Badge tone="warn">no TLS</Badge>}
              </>
            ) : (
              'Disabled'
            ),
          ],
          ['SMTP submission', s.smtp.submissionPort ? `Port ${s.smtp.submissionPort} (auth with password or API key)` : 'Disabled (set SUBMISSION_PORT)'],
        ] as [string, React.ReactNode][])),
    ['Uptime', relativeTime(Date.now() - s.uptime).replace(' ago', '')],
    ['Public URL', s.publicUrl],
    [
      'Encryption key',
      s.keyMismatch ? (
        <Badge tone="danger">WREN_SECRET changed — encrypted settings can’t be read</Badge>
      ) : s.secretFromEnv ? (
        <Badge tone="ok">from WREN_SECRET</Badge>
      ) : workers ? (
        <Badge>generated automatically, stored in the Durable Object</Badge>
      ) : (
        <Badge tone="warn">auto-generated in data dir</Badge>
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
      <BackupCard workers={workers} pointInTime={s.backup.pointInTime} snapshot={s.backup.snapshot} rebuilding={s.backup.searchRebuilding} />
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

function BackupCard({ workers, pointInTime, snapshot, rebuilding }: { workers: boolean; pointInTime: boolean; snapshot: boolean; rebuilding: boolean }) {
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
        workers
          ? 'Cloudflare keeps 30 days of point-in-time history for the database automatically. Exports are portable copies you can keep anywhere and restore here or on a Docker install. Message files stay in R2.'
          : 'Exports are portable copies you can restore here or on a Cloudflare deployment. Also back up the data directory’s blobs/ folder, which holds message contents and attachments.'
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/admin/export">
            <Button icon={<Download className="size-4" />}>Download export</Button>
          </a>
          {snapshot && (
            <a href="/api/admin/backup">
              <Button variant="ghost" icon={<Download className="size-4" />}>
                SQLite snapshot
              </Button>
            </a>
          )}
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
              <Input type="datetime-local" className="w-auto" value={at} max={toLocalInput(Date.now())} min={toLocalInput(Date.now() - 30 * 86_400_000)} onChange={(e) => setAt(e.target.value)} />
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
