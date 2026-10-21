/** A message sent as a private link, as its sender sees it: what the link shows, until when, and "Stop sharing now". */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Lock, Paperclip } from 'lucide-react';
import type { AttachmentInfo } from '../../../shared/types';
import { api, linkUrl } from '../../lib/api';
import { fileSize, longDate } from '../../lib/format';
import { MessageBody } from '../../components/MessageBody';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';

const PERIOD: Record<number, string> = { 1: 'a day', 7: 'a week', 30: 'a month' };

export function PrivateLinkCard({ messageId, link }: { messageId: number; link: { days: number; expiresAt: number | null } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const live = !!link.expiresAt && link.expiresAt > Date.now();
  const q = useQuery({
    queryKey: ['private-link', messageId],
    queryFn: () => api.get<{ html: string | null; text: string | null; attachments: AttachmentInfo[] }>(`/api/mail/messages/${messageId}/private`),
    enabled: live,
  });
  const fileUrl = useCallback((id: number) => linkUrl(`/api/mail/messages/${messageId}/private/attachments/${id}?inline=1`), [messageId]);

  if (!link.expiresAt || !live) {
    return (
      <p className="mb-3 flex items-center gap-2 rounded-xl bg-panel2 px-4 py-2.5 text-[13px] text-muted">
        <Lock className="size-4 shrink-0" aria-hidden />
        {link.expiresAt ? `Private link · expired ${longDate(link.expiresAt)}` : `Private link · recipients get a link that stops working ${PERIOD[link.days] ?? `${link.days} days`} after it’s sent`}
      </p>
    );
  }

  const stop = async () => {
    if (!window.confirm('Stop sharing this message? The link stops working right away and the message is deleted from the server.')) return;
    setBusy(true);
    try {
      await api.del(`/api/mail/messages/${messageId}/private`);
      qc.removeQueries({ queryKey: ['private-link', messageId] });
      await qc.invalidateQueries({ queryKey: ['thread'] });
      toast('Stopped sharing. The link no longer works.');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const c = q.data;
  const files = c?.attachments.filter((a) => !a.inline || !c.html?.includes(`cid:${a.contentId}`)) ?? [];
  return (
    <section aria-label="Private link" className="mb-4 max-w-3xl overflow-hidden rounded-2xl border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel2 px-4 py-2.5">
        <Lock className="size-4 shrink-0 text-accent-ink" aria-hidden />
        <span className="min-w-0 flex-1 text-[13px] font-medium">Private link · expires {longDate(link.expiresAt)}</span>
        <Button size="sm" loading={busy} onClick={() => void stop()}>
          Stop sharing now
        </Button>
      </div>
      <div className="p-4">
        {c ? (
          <>
            <MessageBody html={c.html} text={c.text} attachments={c.attachments} allowRemote={false} attachmentUrl={fileUrl} />
            {files.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {files.map((a) => (
                  <li key={a.id}>
                    <a
                      href={linkUrl(`/api/mail/messages/${messageId}/private/attachments/${a.id}`)}
                      className="inline-flex max-w-60 items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1 text-[13px] hover:shadow-panel"
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
            )}
          </>
        ) : (
          <p className="text-[13px] text-muted">{q.isError ? (q.error as Error).message : 'Loading…'}</p>
        )}
      </div>
    </section>
  );
}
