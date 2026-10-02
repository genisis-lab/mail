import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileArchive, Server, Trash2, Upload, X } from 'lucide-react';
import { MboxSplitter } from '../../../shared/mbox';
import { api } from '../../lib/api';
import { fileSize, number, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../../components/ui';

interface Job {
  id: number;
  kind: 'imap_import' | 'export';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: Record<string, any>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const CHUNK = 8 * 1024 * 1024;
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_COUNT = 50;
const MAX_MESSAGE = 20 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Totals {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  tooLarge: number;
}

/** Upload an mbox file (Google Takeout, Thunderbird, Apple Mail, a Wren export) in batches. */
function MboxImport() {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [pos, setPos] = useState(0);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const start = async (f: File) => {
    setFile(f);
    setPos(0);
    setFinished(false);
    setErrors([]);
    const t: Totals = { imported: 0, duplicates: 0, skipped: 0, failed: 0, tooLarge: 0 };
    setTotals({ ...t });
    setRunning(true);
    stop.current = false;
    const splitter = new MboxSplitter();
    let batch: Uint8Array[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await api.post<{ imported: number; duplicates: number; skipped: number; failed: number; errors: string[] }>('/api/me/import/messages', { messages: batch.map(toBase64) });
      t.imported += r.imported;
      t.duplicates += r.duplicates;
      t.skipped += r.skipped;
      t.failed += r.failed;
      if (r.errors.length) setErrors((e) => [...e, ...r.errors].slice(0, 10));
      batch = [];
      batchBytes = 0;
      setTotals({ ...t });
    };
    const take = async (messages: Uint8Array[]) => {
      for (const m of messages) {
        if (m.length > MAX_MESSAGE) {
          t.tooLarge++;
          continue;
        }
        if (batch.length >= BATCH_COUNT || batchBytes + m.length > BATCH_BYTES) await flush();
        batch.push(m);
        batchBytes += m.length;
      }
    };
    try {
      for (let at = 0; at < f.size && !stop.current; at += CHUNK) {
        const chunk = new Uint8Array(await f.slice(at, at + CHUNK).arrayBuffer());
        await take(splitter.push(chunk));
        setPos(Math.min(f.size, at + CHUNK));
      }
      if (!stop.current) {
        await take(splitter.end());
        await flush();
      }
      if (!stop.current && t.imported + t.duplicates + t.skipped + t.failed + t.tooLarge === 0) {
        toast({ message: 'No messages found. Choose an .mbox file (in Google Takeout: “Mail”).', tone: 'error', duration: 8000 });
      }
      setFinished(true);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error', duration: 8000 });
    } finally {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['counters'] });
      qc.invalidateQueries({ queryKey: ['labels'] });
      if (input.current) input.current.value = '';
    }
  };

  const pct = file && file.size ? Math.round((pos / file.size) * 100) : 0;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <FileArchive className="size-4 text-muted" aria-hidden /> From a file (Gmail Takeout, Thunderbird, Apple Mail)
        </span>
      }
      description="Upload an .mbox file. Gmail labels, read and starred state come along, and messages you already have are skipped."
    >
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>
          Gmail: go to <b>takeout.google.com</b>, choose only <b>Mail</b>, and download the archive. Unzip it; the file ends in <b>.mbox</b>.
        </li>
        <li>Choose the file below and keep this tab open while it uploads. Large mailboxes take a while.</li>
      </ol>
      <input ref={input} id="wren-mbox" type="file" accept=".mbox,application/mbox,text/plain" className="sr-only" disabled={running} onChange={(e) => e.target.files?.[0] && void start(e.target.files[0])} />
      {!running && (
        <label htmlFor="wren-mbox" className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm hover:brightness-110">
          <Upload className="size-4" aria-hidden /> Choose .mbox file
        </label>
      )}
      {file && totals && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {file.name} <span className="text-muted">({fileSize(file.size)})</span>
            </span>
            {running && (
              <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => (stop.current = true)}>
                Stop
              </Button>
            )}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-panel2" role="progressbar" aria-label="Upload progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[13px] text-muted">
            {running ? `${pct}% read · ` : finished ? 'Finished · ' : 'Stopped · '}
            <b className="text-fg">{number(totals.imported)}</b> imported · {number(totals.duplicates)} already here
            {totals.skipped ? ` · ${number(totals.skipped)} chats/drafts skipped` : ''}
            {totals.tooLarge ? ` · ${number(totals.tooLarge)} too large` : ''}
            {totals.failed ? ` · ${number(totals.failed)} failed` : ''}
          </p>
          {errors.length > 0 && <p className="text-xs text-danger">Some messages couldn’t be read: {errors.slice(0, 3).join('; ')}</p>}
        </div>
      )}
    </Card>
  );
}

const PRESETS: { id: string; name: string; host: string; note: string }[] = [
  { id: 'gmail', name: 'Gmail', host: 'imap.gmail.com', note: 'Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. Use it instead of your Google password.' },
  { id: 'icloud', name: 'iCloud Mail', host: 'imap.mail.me.com', note: 'Create an app-specific password at account.apple.com (Sign-In and Security). Your username is your full iCloud address.' },
  { id: 'yahoo', name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', note: 'Generate an app password in Yahoo Account Security.' },
  { id: 'fastmail', name: 'Fastmail', host: 'imap.fastmail.com', note: 'Create an app password in Settings → Privacy & Security, with IMAP access.' },
  { id: 'zoho', name: 'Zoho Mail', host: 'imap.zoho.com', note: 'Enable IMAP access in Zoho Mail settings; use an app password if 2FA is on.' },
  { id: 'other', name: 'Other (IMAP)', host: '', note: 'Use the IMAP server details from your provider.' },
];

function ImapImport({ busy }: { busy: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState('gmail');
  const [form, setForm] = useState({ host: 'imap.gmail.com', port: 993, security: 'tls' as 'tls' | 'starttls', username: '', password: '' });
  const [starting, setStarting] = useState(false);
  const p = PRESETS.find((x) => x.id === preset)!;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Server className="size-4 text-muted" aria-hidden /> From another account (IMAP)
        </span>
      }
      description="Wren signs in to your old account and copies every folder in the background. You can close this page; the password is forgotten when it’s done."
      actions={
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setOpen(true)}>
          Connect account
        </Button>
      }
    >
      <p className="text-[13px] text-muted">{busy ? 'An import is running; see its progress below.' : 'Works with Gmail, iCloud, Yahoo, Fastmail, Zoho and any server with IMAP. Folders become labels; Inbox, Sent, Spam and Trash stay where they are.'}</p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import with IMAP"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={starting}
              disabled={!form.host || !form.username || !form.password}
              onClick={async () => {
                setStarting(true);
                try {
                  await api.post('/api/me/import/imap', { ...form, port: Number(form.port) });
                  setOpen(false);
                  setForm((f) => ({ ...f, password: '' }));
                  qc.invalidateQueries({ queryKey: ['me', 'jobs'] });
                  toast('Connected. Your mail is being copied in the background.');
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error', duration: 9000 });
                } finally {
                  setStarting(false);
                }
              }}
            >
              Start import
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="Provider">
            <Select
              value={preset}
              onChange={(e) => {
                const next = PRESETS.find((x) => x.id === e.target.value)!;
                setPreset(next.id);
                setForm((f) => ({ ...f, host: next.host, port: 993, security: 'tls' }));
              }}
            >
              {PRESETS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="-mt-2 rounded-xl bg-panel2 px-3 py-2 text-[13px] text-muted">{p.note}</p>
          {preset === 'other' && (
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label="IMAP server">
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value.trim() })} placeholder="imap.example.com" />
              </Field>
              <Field label="Security">
                <Select value={form.security} onChange={(e) => setForm({ ...form, security: e.target.value as 'tls' | 'starttls', port: e.target.value === 'tls' ? 993 : 143 })}>
                  <option value="tls">SSL/TLS (993)</option>
                  <option value="starttls">STARTTLS (143)</option>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Email address or username">
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="App password" help="Stored encrypted only while the import runs.">
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

function JobRow({ job }: { job: Job }) {
  const qc = useQueryClient();
  const toast = useToast();
  const active = job.status === 'queued' || job.status === 'running';
  const p = job.progress;
  const tone = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'danger' : job.status === 'cancelled' ? 'neutral' : 'accent';
  const statusLabel = { queued: 'starting', running: 'in progress', done: 'done', failed: 'failed', cancelled: 'cancelled' }[job.status];
  const refresh = () => qc.invalidateQueries({ queryKey: ['me', 'jobs'] });
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {job.kind === 'export' ? 'Export of all mail' : `Import from ${p.account ?? 'IMAP'}`}
          <Badge tone={tone}>{statusLabel}</Badge>
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          {job.kind === 'export'
            ? `${number(p.messages ?? 0)}${p.total ? ` of ${number(p.total)}` : ''} messages · ${fileSize(p.bytes ?? 0)}`
            : `${number(p.imported ?? 0)} imported · ${number(p.duplicates ?? 0)} already here${p.failed ? ` · ${number(p.failed)} failed` : ''}${active && p.folder ? ` · ${p.folder} (folder ${p.folderIndex} of ${p.folders})` : ''}`}
          {' · '}
          {active ? `started ${relativeTime(job.createdAt)}` : relativeTime(job.updatedAt)}
        </p>
        {job.error && <p className="mt-1 text-[13px] text-danger">{job.error}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {job.kind === 'export' && job.status === 'done' && (
          <a href={`/api/me/export/${job.id}/download`} download className="inline-flex h-8 items-center gap-2 rounded-full bg-accent px-3 text-[13px] font-medium text-accent-fg hover:brightness-110">
            <Download className="size-3.5" aria-hidden /> Download .mbox
          </a>
        )}
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.post(`/api/me/jobs/${job.id}/cancel`);
              refresh();
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            aria-label="Remove from list"
            onClick={async () => {
              try {
                await api.del(`/api/me/jobs/${job.id}`);
                refresh();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              }
            }}
          >
            <span className="sr-only">Remove</span>
          </Button>
        )}
      </div>
    </li>
  );
}

export function ImportExportTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const jobs = useQuery({
    queryKey: ['me', 'jobs'],
    queryFn: () => api.get<{ jobs: Job[] }>('/api/me/jobs').then((r) => r.jobs),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false),
  });
  const list = jobs.data ?? [];
  const importing = list.some((j) => j.kind === 'imap_import' && (j.status === 'queued' || j.status === 'running'));
  const exporting = list.some((j) => j.kind === 'export' && (j.status === 'queued' || j.status === 'running'));
  // Refresh the mail views when a background import finishes.
  const lastDone = useRef<string>('');
  useEffect(() => {
    const key = list.filter((j) => j.status === 'done').map((j) => j.id).join(',');
    if (lastDone.current && key !== lastDone.current) {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['counters'] });
      qc.invalidateQueries({ queryKey: ['labels'] });
    }
    lastDone.current = key;
  }, [list, qc]);

  return (
    <div className="space-y-6">
      <MboxImport />
      <ImapImport busy={importing} />
      <Card
        title={
          <span className="flex items-center gap-2">
            <Download className="size-4 text-muted" aria-hidden /> Export all mail
          </span>
        }
        description="Download everything as one .mbox file, which most mail apps can open. Folders, labels and stars are kept, so it imports back into Wren as it was."
        actions={
          <Button
            size="sm"
            disabled={exporting}
            onClick={async () => {
              try {
                await api.post('/api/me/export');
                qc.invalidateQueries({ queryKey: ['me', 'jobs'] });
                toast('Preparing your export…');
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              }
            }}
          >
            {exporting ? 'Preparing…' : 'Export'}
          </Button>
        }
      >
        <p className="text-[13px] text-muted">Exports are kept for 7 days.</p>
      </Card>
      {list.length > 0 && (
        <Card title="Recent imports and exports">
          <ul className="-my-3 divide-y divide-line" aria-live="polite">
            {list.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
