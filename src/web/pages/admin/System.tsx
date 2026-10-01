import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Megaphone } from 'lucide-react';
import { api } from '../../lib/api';
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
    ['Encryption key', s.secretFromEnv ? <Badge tone="ok">from WREN_SECRET</Badge> : <Badge tone="warn">auto-generated in data dir</Badge>],
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
      <Card
        title="Backup"
        description={
          workers
            ? 'Durable Objects keep 30 days of point-in-time recovery automatically. You can also download a portable JSON export of the database; message files stay in R2.'
            : 'Download a consistent snapshot of the database (users, settings, message index). Back up the data directory’s blobs/ folder too for message contents and attachments.'
        }
      >
        <a href="/api/admin/backup">
          <Button icon={<Download className="size-4" />}>{workers ? 'Download JSON export' : 'Download database snapshot'}</Button>
        </a>
      </Card>
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
