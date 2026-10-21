/** A private message opened from its link (/p/<token>), by anyone who has it: signed in or not. */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock, Download, ImageOff, Lock, Paperclip } from 'lucide-react';
import { APP_NAME } from '../../shared/brand';
import type { Addr, AttachmentInfo } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { fileSize, longDate } from '../lib/format';
import type { Instance } from '../lib/session';
import { Logo } from '../components/Logo';
import { MessageBody } from '../components/MessageBody';
import { Spinner } from '../components/ui';

interface PrivateMessage {
  from: Addr;
  subject: string;
  date: number;
  expiresAt: number;
  html: string | null;
  text: string | null;
  attachments: AttachmentInfo[];
}

export function PrivateMessagePage({ instance }: { instance: Instance }) {
  const { token = '' } = useParams();
  const base = `/api/private/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['private', token], queryFn: () => api.get<PrivateMessage>(base) });
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

  const m = q.data;
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
          ) : !m ? (
            q.error instanceof ApiError && q.error.status === 404 ? (
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
