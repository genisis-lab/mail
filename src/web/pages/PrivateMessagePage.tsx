/**
 * A private message opened from its link (/p/<token>), signed in or not. It
 * opens only after the viewer enters a code emailed to one of its recipients.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock, Download, ImageOff, Lock, Mail, Paperclip } from 'lucide-react';
import { APP_NAME } from '../../shared/brand';
import type { Addr, AttachmentInfo } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { fileSize, longDate } from '../lib/format';
import type { Instance } from '../lib/session';
import { Logo } from '../components/Logo';
import { MessageBody } from '../components/MessageBody';
import { Button, Field, Input, Spinner } from '../components/ui';

interface PrivateMessage {
  from: Addr;
  subject: string;
  date: number;
  expiresAt: number;
  html: string | null;
  text: string | null;
  attachments: AttachmentInfo[];
}

/** Not opened here yet: only who it's from, until a code is entered. */
interface LockedMessage {
  locked: true;
  from: Addr;
}

export function PrivateMessagePage({ instance }: { instance: Instance }) {
  const { token = '' } = useParams();
  const base = `/api/private/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['private', token], queryFn: () => api.get<PrivateMessage | LockedMessage>(base), gcTime: 0, retry: false, refetchOnMount: 'always', refetchInterval: 30_000 });
  const [blocked, setBlocked] = useState(0);
  const pictureUrl = useCallback((id: number) => `${base}/attachments/${id}?inline=1`, [base]);

  // The token is in the address: keep it out of Referer headers and search engines.
  useEffect(() => {
    const metas = [
      ['referrer', 'no-referrer'],
      ['robots', 'noindex'],
    ].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.append(meta);
      return meta;
    });
    return () => metas.forEach((m) => m.remove());
  }, []);

  const opened = q.data && !('locked' in q.data) ? q.data : undefined;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!opened || opened.expiresAt <= Date.now()) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.max(0, opened.expiresAt - Date.now()) + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [opened, clock]);
  const expired = !!opened && opened.expiresAt <= Math.max(clock, Date.now());
  const locked = !q.isError && q.data && 'locked' in q.data ? q.data : undefined;
  const m = q.isError || expired ? undefined : opened;
  const files = m?.attachments.filter((a) => !a.inline || !m.html?.includes(`cid:${a.contentId}`)) ?? [];

  return (
    <main className="flex min-h-full flex-col items-center bg-bg px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="mb-8 flex justify-center">
          <Logo name={instance.name || APP_NAME} />
        </div>
        <div className="rounded-3xl border border-line bg-panel p-8 shadow-panel max-sm:p-5">
          {q.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-6" />
            </div>
          ) : locked ? (
            <Unlock base={base} from={locked.from} onOpen={() => void q.refetch()} />
          ) : !m ? (
            expired || (q.error instanceof ApiError && q.error.status === 404) ? (
              <>
                <h1 className="text-xl font-semibold">This message has expired or was withdrawn</h1>
                <p className="mt-2 text-sm text-muted">If you still need it, ask the person who sent it to share it again.</p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-semibold">Can’t open this message</h1>
                <p className="mt-2 text-sm text-muted">Check your connection and reload the page.</p>
              </>
            )
          ) : (
            <article>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
                <Lock className="size-3.5" aria-hidden /> Private message
              </p>
              <h1 className="text-xl font-semibold break-words">{m.subject || '(no subject)'}</h1>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-2 border-b border-line pb-4 text-sm">
                <span className="font-semibold">{m.from.name || m.from.address}</span>
                {m.from.name && <span className="text-xs text-muted">&lt;{m.from.address}&gt;</span>}
                <span className="ml-auto text-xs text-muted">{longDate(m.date)}</span>
              </div>
              {blocked > 0 && (
                <p className="mt-4 flex items-center gap-2 rounded-lg bg-panel2 px-3 py-2 text-[13px] text-muted">
                  <ImageOff className="size-4 shrink-0" aria-hidden /> Pictures from other sites are hidden to protect your privacy.
                </p>
              )}
              <div className="mt-4">
                {/* shortcut: remote pictures stay hidden here, since the image proxy needs a signed-in session; sign them for link viewers if people ask. */}
                <MessageBody html={m.html} text={m.text} attachments={m.attachments} allowRemote={false} attachmentUrl={pictureUrl} onBlockedImages={setBlocked} />
              </div>
              {files.length > 0 && (
                <div className="mt-5 border-t border-line pt-4">
                  <p className="mb-3 text-sm font-medium">
                    {files.length} attachment{files.length > 1 ? 's' : ''}
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {files.map((a) => (
                      <li key={a.id}>
                        <a
                          href={`${base}/attachments/${a.id}`}
                          className="inline-flex max-w-72 items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-2 text-[13px] hover:shadow-panel"
                          aria-label={`Download ${a.filename}, ${fileSize(a.size)}`}
                        >
                          <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />
                          <span className="truncate font-medium">{a.filename}</span>
                          <span className="shrink-0 text-xs text-muted">{fileSize(a.size)}</span>
                          <Download className="size-3.5 shrink-0 text-muted" aria-hidden />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-6 flex items-center gap-1.5 text-xs text-muted">
                <Clock className="size-3.5" aria-hidden /> This link stops working on {longDate(m.expiresAt)}.
              </p>
            </article>
          )}
        </div>
      </div>
    </main>
  );
}

/** Ask for a code at one of the recipients' addresses, then enter it. */
function Unlock({ base, from, onOpen }: { base: string; from: Addr; onOpen: () => void }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendCode = run(async () => {
    await api.post(`${base}/code`, { email: email.trim() });
    setResent(!!sentTo);
    setSentTo(email.trim());
    setCode('');
  });
  const verify = run(async () => {
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) throw new Error('Enter the 6-digit code from the email.');
    await api.post(`${base}/verify`, { email: sentTo, code: digits });
    onOpen();
  });

  return (
    <div className="mx-auto max-w-sm">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        {sentTo ? <Mail className="size-6" aria-hidden /> : <Lock className="size-6" aria-hidden />}
      </div>
      {!sentTo ? (
        <form className="mt-4 space-y-4" onSubmit={sendCode}>
          <div>
            <h1 className="text-xl font-semibold">{from.name || from.address} sent you a private message</h1>
            <p className="mt-1 text-sm text-muted">To open it, enter the email address it was sent to. We’ll email a code there.</p>
          </div>
          <Field label="Your email address" error={error}>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Send code
          </Button>
        </form>
      ) : (
        <form className="mt-4 space-y-4" onSubmit={verify}>
          <div>
            <h1 className="text-xl font-semibold" role="status">
              Check your email
            </h1>
            <p className="mt-1 text-sm text-muted">
              If this message was sent to <b className="text-fg">{sentTo}</b>, a 6-digit code is on its way there. It works for 10 minutes.
            </p>
            <p className="mt-2 text-sm text-muted" aria-live="polite">
              {resent && 'A new code was sent. Only the newest one works.'}
            </p>
          </div>
          <Field label="Code" error={error}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required placeholder="123456" />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Open message
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="text-muted hover:text-fg" onClick={() => void sendCode()} disabled={busy}>
              Send a new code
            </button>
            <button
              type="button"
              className="text-muted hover:text-fg"
              onClick={() => {
                setSentTo(null);
                setResent(false);
                setError(null);
              }}
            >
              Use a different address
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
