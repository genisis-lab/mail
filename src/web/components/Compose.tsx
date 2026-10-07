import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CalendarClock, ChevronDown, FileText, Maximize2, Minimize2, Minus, Paperclip, Trash2, Type, X, Loader2, Image as ImageIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { Addr, AttachmentInfo, MessageDetail, UserPrefs } from '../../shared/types';
import { apiFor, getApiMailbox } from '../lib/api';
import { mentionsAttachment, ownText } from '../lib/attachment-check';
import { isNetworkError, queueSend } from '../lib/outbox';
import { fileSize } from '../lib/format';
import { sanitizeEditorHtml } from '../lib/sanitize';
import { useMailboxes } from '../lib/mailbox';
import { useSession } from '../lib/session';
import { RecipientInput } from './RecipientInput';
import { RichEditor, type RichEditorHandle } from './RichEditor';
import { useToast } from './toast';
import { Button, cx, IconButton, Input, Menu, Modal } from './ui';

export interface ComposeInit {
  draftId?: number | null;
  from?: string;
  to?: Addr[];
  cc?: Addr[];
  bcc?: Addr[];
  subject?: string;
  html?: string;
  attachments?: AttachmentInfo[];
  replyToId?: number | null;
  forwardOfId?: number | null;
  threadId?: number | null;
  /** The shared mailbox this message is written in (null: the person's own). */
  mailbox?: number | null;
}

interface Window_ extends ComposeInit {
  key: number;
  minimized: boolean;
  maximized: boolean;
}

interface ComposeApi {
  open: (init?: ComposeInit) => void;
  openDraft: (draftId: number) => Promise<void>;
  openTemplate: (messageId: number, mode: 'reply' | 'replyAll' | 'forward') => Promise<ComposeInit>;
}

const ComposeCtx = createContext<ComposeApi | null>(null);

export function useCompose() {
  const v = useContext(ComposeCtx);
  if (!v) throw new Error('useCompose outside provider');
  return v;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function signatureHtml(sig: string): string {
  if (!sig.trim()) return '';
  const body = /<[a-z][\s\S]*>/i.test(sig) ? sig : escapeHtml(sig).replace(/\n/g, '<br>');
  return `<div class="wren-signature"><br>-- <br>${body}</div>`;
}

/** The signature for a From address: its own, or the default one. */
export function signatureFor(prefs: Pick<UserPrefs, 'signature' | 'signatures'>, address: string | undefined): string {
  const own = address ? prefs.signatures?.[address.toLowerCase()] : undefined;
  return own !== undefined && own.trim() ? own : prefs.signature;
}

/** Replace the signature block in a message body (or add one before the quoted text). */
export function swapSignature(html: string, sig: string): string {
  const doc = document.createElement('div');
  doc.innerHTML = sanitizeEditorHtml(html);
  const current = doc.querySelector('.wren-signature');
  const next = sanitizeEditorHtml(signatureHtml(sig));
  if (current) {
    if (next) current.outerHTML = next;
    else current.remove();
  } else if (next) {
    const quote = doc.querySelector('.wren-quote, .wren-forward');
    const holder = document.createElement('div');
    holder.innerHTML = next;
    const node = holder.firstElementChild!;
    if (quote) quote.before(node);
    else doc.append(node);
  }
  return doc.innerHTML;
}

/** Inline images: the editor shows attachment URLs, the message stores cid: references. */
export function cidToUrl(html: string, atts: AttachmentInfo[]) {
  let out = html;
  for (const a of atts) if (a.contentId) out = out.split(`cid:${a.contentId}`).join(`/api/attachments/${a.id}?inline=1`);
  return out;
}
function urlToCid(html: string, atts: AttachmentInfo[]) {
  let out = html;
  for (const a of atts) if (a.contentId) out = out.split(`/api/attachments/${a.id}?inline=1`).join(`cid:${a.contentId}`);
  return out;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<Window_[]>([]);
  const seq = useRef(0);
  const { prefs, user } = useSession();

  const open = useCallback(
    (init: ComposeInit = {}) => {
      // A window belongs to the mailbox that was open when it was started.
      const mailbox = init.mailbox !== undefined ? init.mailbox : getApiMailbox();
      setWindows((ws) => {
        if (init.draftId && ws.some((w) => w.draftId === init.draftId)) {
          return ws.map((w) => (w.draftId === init.draftId ? { ...w, minimized: false } : w));
        }
        const from = mailbox ? undefined : init.from || prefs.defaultFrom || user.identities[0]?.address || user.email;
        const sig = signatureFor(prefs, from);
        const html = init.html ?? (sig ? `<p><br></p>${signatureHtml(sig)}` : '');
        const next = [...ws.map((w) => ({ ...w, minimized: ws.length >= 1 ? true : w.minimized })), { ...init, mailbox, html, key: ++seq.current, minimized: false, maximized: false }];
        return next.slice(-3);
      });
    },
    [prefs, user],
  );

  const openDraft = useCallback(
    async (draftId: number) => {
      const mailbox = getApiMailbox();
      const d = await apiFor(mailbox).get<MessageDetail>(`/api/compose/drafts/${draftId}`);
      open({
        mailbox,
        draftId: d.id,
        from: d.identity ?? d.from.address,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        html: cidToUrl(d.html ?? '', d.attachments),
        attachments: d.attachments,
      });
    },
    [open],
  );

  const openTemplate = useCallback(
    async (messageId: number, mode: 'reply' | 'replyAll' | 'forward') => {
      const mailbox = getApiMailbox();
      const t = await apiFor(mailbox).get<ComposeInit & { html: string }>(`/api/compose/template?messageId=${messageId}&mode=${mode}`);
      const own = signatureFor(prefs, mailbox ? undefined : t.from);
      const sig = own && prefs.signatureOnReplies ? signatureHtml(own) : '';
      return { ...t, mailbox, html: sig ? t.html.replace(/^<p><br><\/p>/, `<p><br></p>${sig}`) : t.html };
    },
    [prefs],
  );

  const close = (key: number) => setWindows((ws) => ws.filter((w) => w.key !== key));
  const patch = (key: number, p: Partial<Window_>) => setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, ...p } : w)));

  const value = useMemo(() => ({ open, openDraft, openTemplate }), [open, openDraft, openTemplate]);

  return (
    <ComposeCtx.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-0 z-50 flex items-end gap-3 max-sm:right-0 max-sm:left-0">
          {windows.map((w) => (
            <ComposeWindow
              key={w.key}
              win={w}
              onClose={() => close(w.key)}
              onPatch={(p) => patch(w.key, p)}
              onReopen={(init) => open(init)}
            />
          ))}
        </div>,
        document.body,
      )}
    </ComposeCtx.Provider>
  );
}

function ComposeWindow({ win, onClose, onPatch, onReopen }: { win: Window_; onClose: () => void; onPatch: (p: Partial<Window_>) => void; onReopen: (init: ComposeInit) => void }) {
  const [subject, setSubject] = useState(win.subject ?? '');
  const title = subject.trim() || 'New message';

  if (win.minimized) {
    return (
      <div className="pointer-events-auto w-72 overflow-hidden rounded-t-xl bg-panel shadow-float">
        <div className="flex h-10 cursor-pointer items-center gap-2 bg-[#3c4043] px-3 text-sm text-white dark:bg-panel3" onClick={() => onPatch({ minimized: false })}>
          <span className="flex-1 truncate font-medium">{title}</span>
          <button className="rounded p-1 hover:bg-white/10" aria-label="Expand" onClick={(e) => (e.stopPropagation(), onPatch({ minimized: false }))}>
            <Maximize2 className="size-3.5" />
          </button>
          <button className="rounded p-1 hover:bg-white/10" aria-label="Close" onClick={(e) => (e.stopPropagation(), onClose())}>
            <X className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  const frame = win.maximized
    ? 'fixed inset-x-[6vw] top-[5vh] bottom-[5vh] w-auto rounded-xl'
    : // On phones: full width, below the status bar, with the Send row above the home indicator.
      'h-[min(600px,calc(100vh-80px))] w-[540px] max-sm:w-full max-sm:h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] max-sm:pb-[env(safe-area-inset-bottom)] rounded-t-xl max-sm:rounded-t-2xl';

  return (
    <>
      {win.maximized && <div className="pointer-events-auto fixed inset-0 bg-black/40" onClick={() => onPatch({ maximized: false })} />}
      <div className={cx('animate-slide-up pointer-events-auto flex flex-col overflow-hidden bg-panel shadow-float', frame)}>
        <div className="flex h-10 shrink-0 items-center gap-1 bg-panel2 pr-1.5 pl-4 text-sm">
          <span className="flex-1 truncate font-medium">{title}</span>
          <IconButton size="sm" label="Minimize" onClick={() => onPatch({ minimized: true, maximized: false })}>
            <Minus className="size-4" />
          </IconButton>
          <IconButton size="sm" label={win.maximized ? 'Exit full screen' : 'Full screen'} onClick={() => onPatch({ maximized: !win.maximized })}>
            {win.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </IconButton>
          <IconButton size="sm" label="Save & close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <ComposeForm init={win} onSubjectChange={setSubject} onClose={onClose} onReopen={onReopen} variant="window" />
      </div>
    </>
  );
}

/** The compose form itself — used by floating windows and inline replies. */
export function ComposeForm({
  init,
  onClose,
  onReopen,
  onSubjectChange,
  variant,
  autoFocusBody,
}: {
  init: ComposeInit;
  onClose: () => void;
  onReopen?: (init: ComposeInit) => void;
  onSubjectChange?: (s: string) => void;
  variant: 'window' | 'inline';
  autoFocusBody?: boolean;
}) {
  const { user, prefs } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Pinned for the life of this form, even if the person switches mailbox meanwhile.
  const [mailboxId] = useState<number | null>(() => (init.mailbox !== undefined ? init.mailbox : getApiMailbox()));
  const api = useMemo(() => apiFor(mailboxId), [mailboxId]);
  const boxes = useMailboxes();
  const box = mailboxId ? boxes.data?.find((b) => b.id === mailboxId) ?? null : null;
  const identities = useMemo(() => (mailboxId ? (box ? [{ address: box.address, name: box.name, kind: 'mailbox' as const }] : []) : user.identities), [mailboxId, box, user.identities]);
  const readOnly = !!box && !box.canSend;

  const [draftId, setDraftId] = useState<number | null>(init.draftId ?? null);
  // In a shared mailbox the server sends from the mailbox's own address.
  const [from, setFrom] = useState(mailboxId ? '' : init.from || user.prefs.defaultFrom || identities[0]?.address || user.email);
  const [to, setTo] = useState<Addr[]>(init.to ?? []);
  const [cc, setCc] = useState<Addr[]>(init.cc ?? []);
  const [bcc, setBcc] = useState<Addr[]>(init.bcc ?? []);
  const [showCc, setShowCc] = useState((init.cc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((init.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(init.subject ?? '');
  const [attachments, setAttachments] = useState<AttachmentInfo[]>(init.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [toolbar, setToolbar] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  const html = useRef(init.html ?? '');
  const dirty = useRef(false);
  const saving = useRef<Promise<number | null> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  const payload = useCallback(
    () => ({
      from,
      to,
      cc,
      bcc,
      subject,
      html: urlToCid(html.current, attachments),
      attachments: attachments.map((a) => a.id),
      replyToId: init.replyToId ?? null,
      forwardOfId: init.forwardOfId ?? null,
    }),
    [from, to, cc, bcc, subject, attachments, init.replyToId, init.forwardOfId],
  );

  const save = useCallback(async (): Promise<number | null> => {
    if (saving.current) await saving.current;
    const p = payload();
    setSaveState('saving');
    const run = (async () => {
      try {
        const r = draftId
          ? await api.put<{ id: number; attachments: AttachmentInfo[] }>(`/api/compose/drafts/${draftId}`, p)
          : await api.post<{ id: number; attachments: AttachmentInfo[] }>('/api/compose/drafts', p);
        setDraftId(r.id);
        // Attachments copied from a forwarded message get new ids.
        if (r.attachments.length !== attachments.length || r.attachments.some((a, i) => a.id !== attachments[i]?.id)) {
          html.current = cidToUrl(urlToCid(html.current, attachments), r.attachments);
          setAttachments(r.attachments);
        }
        dirty.current = false;
        setSaveState('saved');
        qc.invalidateQueries({ queryKey: ['counters'] });
        return r.id;
      } catch (err) {
        setSaveState('idle');
        // Offline: keep quiet; the draft is saved once the connection is back, or queued on Send.
        if (!isNetworkError(err)) toast({ message: (err as Error).message, tone: 'error' });
        return null;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = run;
    return run;
  }, [payload, draftId, attachments, qc, toast]);

  // Autosave after a pause in typing.
  const markDirty = () => {
    dirty.current = true;
    setSaveState('idle');
  };
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      if (dirty.current && !closed.current) void save();
    }, 1500);
    return () => clearTimeout(t);
  });

  useEffect(() => onSubjectChange?.(subject), [subject, onSubjectChange]);

  const upload = async (files: File[], inline = false) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    try {
      const fd = new FormData();
      for (const f of files) fd.append(inline ? 'inline' : 'file', f);
      const r = await api.post<{ attachments: AttachmentInfo[] }>('/api/compose/uploads', fd);
      setAttachments((a) => [...a, ...r.attachments]);
      if (inline) {
        for (const a of r.attachments) editor.current?.insertHtml(`<img src="/api/attachments/${a.id}?inline=1" alt="${escapeHtml(a.filename)}" style="max-width:100%">`);
      }
      markDirty();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setUploading((n) => n - files.length);
    }
  };

  const handleFiles = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (images.length) void upload(images, true);
    if (others.length) void upload(others);
  };

  const send = async (sendAt: number | null = null) => {
    if (readOnly) {
      toast({ message: `You can read ${box!.address}, but not send from it`, tone: 'error' });
      return;
    }
    if (!to.length && !cc.length && !bcc.length) {
      toast({ message: 'Add at least one recipient', tone: 'error' });
      return;
    }
    if (!subject.trim() && !window.confirm('Send this message without a subject?')) return;
    if (!attachments.length && !uploading) {
      const said = mentionsAttachment(subject, ownText(editor.current?.getHtml() ?? html.current));
      if (said && !window.confirm(`Did you mean to attach files?\n\nYou wrote “${said}”, but there are no files attached. Send anyway?`)) return;
    }
    if (uploading) {
      toast('Wait for attachments to finish uploading');
      return;
    }
    // Offline: keep it on this device and send it when the connection is back.
    const queueIt = () => {
      queueSend({ userId: user.id, mailbox: mailboxId, subject, payload: { ...payload(), draftId, sendAt } });
      closed.current = true;
      onClose();
      toast('You’re offline. It’ll be sent as soon as you’re back online.');
    };
    if (!navigator.onLine) return queueIt();
    setSending(true);
    try {
      if (saving.current) await saving.current.catch(() => {});
      const r = await api.post<{ id: number; sendAt: number; undoUntil: number | null }>('/api/compose/send', { ...payload(), draftId, sendAt });
      closed.current = true;
      onClose();
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['thread'] });
      qc.invalidateQueries({ queryKey: ['counters'] });
      const undo = async () => {
        try {
          const res = await api.post<{ draftId: number }>(`/api/compose/messages/${r.id}/cancel`);
          qc.invalidateQueries({ queryKey: ['threads'] });
          qc.invalidateQueries({ queryKey: ['counters'] });
          const d = await api.get<MessageDetail>(`/api/compose/drafts/${res.draftId}`);
          const reopen: ComposeInit = {
            mailbox: mailboxId,
            draftId: d.id,
            from: d.identity ?? d.from.address,
            to: d.to,
            cc: d.cc,
            bcc: d.bcc,
            subject: d.subject,
            html: cidToUrl(d.html ?? '', d.attachments),
            attachments: d.attachments,
          };
          if (onReopen) onReopen(reopen);
          toast(sendAt ? 'Scheduled send cancelled' : 'Sending undone');
        } catch (err) {
          toast({ message: (err as Error).message, tone: 'error' });
        }
      };
      if (sendAt) {
        toast({ message: `Send scheduled for ${new Date(sendAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, action: { label: 'Undo', onClick: undo } });
      } else {
        const ms = r.undoUntil ? Math.max(1500, r.undoUntil - Date.now()) : 4000;
        toast({
          message: r.undoUntil ? 'Sending…' : 'Message sent',
          action: r.undoUntil ? { label: 'Undo', onClick: undo } : undefined,
          secondary: { label: 'View message', onClick: () => navigate(`/sent`) },
          duration: ms + 500,
        });
        if (r.undoUntil) {
          setTimeout(() => {
            qc.invalidateQueries({ queryKey: ['threads'] });
            qc.invalidateQueries({ queryKey: ['thread'] });
          }, ms + 1500);
        }
      }
    } catch (err) {
      if (isNetworkError(err)) queueIt();
      else toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    closed.current = true;
    if (saving.current) await saving.current;
    if (draftId) {
      await api.del(`/api/compose/drafts/${draftId}`).catch(() => {});
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['counters'] });
    }
    onClose();
    toast('Draft discarded');
  };

  // Save on close if there's anything worth keeping.
  useEffect(
    () => () => {
      if (!closed.current && dirty.current) void save();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const ownIdentity = identities.find((i) => i.address === from);

  const changeFrom = (next: string) => {
    const before = signatureFor(prefs, from);
    const after = signatureFor(prefs, next);
    setFrom(next);
    if (before !== after) {
      const updated = swapSignature(editor.current?.getHtml() ?? html.current, after);
      editor.current?.setHtml(updated);
      html.current = updated;
    }
    markDirty();
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles([...e.dataTransfer.files]);
      }}
    >
      <div className={cx('shrink-0', variant === 'window' ? 'px-3' : 'px-0')}>
        {box && (
          <div className="flex h-10 items-center gap-2 border-b border-line px-1 text-sm">
            <span className="text-muted">From</span>
            <span className="min-w-0 flex-1 truncate">
              {box.name} &lt;{box.address}&gt;
            </span>
            {readOnly && <span className="shrink-0 text-xs text-warn">read only</span>}
          </div>
        )}
        {!mailboxId && identities.length > 1 && (
          <div className="flex h-10 items-center gap-2 border-b border-line px-1">
            <label htmlFor={`from-${draftId ?? 'new'}`} className="text-sm text-muted">
              From
            </label>
            <select
              id={`from-${draftId ?? 'new'}`}
              value={from}
              onChange={(e) => changeFrom(e.target.value)}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
            >
              {identities.map((i) => (
                <option key={i.address} value={i.address}>
                  {i.name ? `${i.name} <${i.address}>` : i.address}
                  {i.kind !== 'mailbox' ? ` (${i.kind})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <RecipientInput
          label="To"
          value={to}
          onChange={(v) => {
            setTo(v);
            markDirty();
          }}
          autoFocus={variant === 'window' && !to.length}
          trailing={
            <span className="flex shrink-0 gap-2 pt-1.5 text-sm text-muted">
              {!showCc && (
                <button type="button" className="hover:text-fg hover:underline" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              )}
              {!showBcc && (
                <button type="button" className="hover:text-fg hover:underline" onClick={() => setShowBcc(true)}>
                  Bcc
                </button>
              )}
            </span>
          }
        />
        {showCc && (
          <RecipientInput
            label="Cc"
            value={cc}
            onChange={(v) => {
              setCc(v);
              markDirty();
            }}
          />
        )}
        {showBcc && (
          <RecipientInput
            label="Bcc"
            value={bcc}
            onChange={(v) => {
              setBcc(v);
              markDirty();
            }}
          />
        )}
        {variant === 'window' && (
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              markDirty();
            }}
            aria-label="Subject"
            placeholder="Subject"
            className="h-10 w-full border-b border-line bg-transparent px-1 text-sm outline-none placeholder:text-muted"
          />
        )}
      </div>

      <div className={cx('flex min-h-0 flex-1 flex-col', variant === 'window' ? 'px-3' : '')}>
        <RichEditor
          ref={editor}
          initialHtml={init.html ?? ''}
          autoFocus={autoFocusBody || (variant === 'window' && to.length > 0)}
          placeholder={variant === 'inline' ? 'Write your reply…' : ''}
          showToolbar={toolbar}
          onPasteFiles={handleFiles}
          onChange={(h) => {
            html.current = h;
            markDirty();
          }}
          className="flex-1"
        />
        {(attachments.filter((a) => !a.inline).length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 py-2">
            {attachments
              .filter((a) => !a.inline)
              .map((a) => (
                <span key={a.id} className="inline-flex max-w-60 items-center gap-2 rounded-lg border border-line bg-panel2 py-1 pr-1 pl-2.5 text-[13px]">
                  <Paperclip className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate font-medium">{a.filename}</span>
                  <span className="shrink-0 text-xs text-muted">{fileSize(a.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.filename}`}
                    className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                    onClick={() => {
                      setAttachments((list) => list.filter((x) => x.id !== a.id));
                      markDirty();
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            {uploading > 0 && (
              <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 py-1 text-[13px] text-muted">
                <Loader2 className="size-3.5 animate-spin" /> Uploading {uploading}…
              </span>
            )}
          </div>
        )}
      </div>

      <div className={cx('flex shrink-0 items-center gap-1 py-2.5', variant === 'window' ? 'px-3' : '')}>
        <div className="flex overflow-hidden rounded-full bg-accent text-accent-fg shadow-sm">
          <button
            type="button"
            disabled={sending || readOnly}
            title={readOnly ? 'You can read this shared mailbox, but not send from it' : undefined}
            onClick={() => void send()}
            className="h-9 pr-4 pl-5 text-sm font-semibold hover:brightness-110 disabled:opacity-60"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          <Menu
            align="left"
            trigger={({ onClick }) => (
              <button type="button" aria-label="More send options" onClick={onClick} className="h-9 border-l border-white/25 px-2 hover:brightness-110">
                <ChevronDown className="size-4" />
              </button>
            )}
            items={[{ label: 'Schedule send', icon: <CalendarClock className="size-4" />, onClick: () => setScheduleOpen(true) }]}
          />
        </div>
        <IconButton size="sm" label="Formatting options" active={toolbar} onClick={() => setToolbar((t) => !t)}>
          <Type className="size-4" />
        </IconButton>
        <IconButton size="sm" label="Attach files" onClick={() => fileInput.current?.click()}>
          <Paperclip className="size-4" />
        </IconButton>
        <IconButton size="sm" label="Insert photo" onClick={() => imageInput.current?.click()}>
          <ImageIcon className="size-4" />
        </IconButton>
        <SavedRepliesMenu
          onInsert={(h) => {
            editor.current?.insertHtml(h);
            markDirty();
          }}
          currentHtml={() => editor.current?.getHtml() ?? html.current}
          subject={subject}
        />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (void upload([...(e.target.files ?? [])]), (e.target.value = ''))} />
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => (void upload([...(e.target.files ?? [])], true), (e.target.value = ''))} />
        <span className="ml-auto truncate px-2 text-xs text-faint">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Draft saved' : ownIdentity && identities.length > 1 ? '' : ''}
        </span>
        <IconButton size="sm" label="Discard draft" onClick={() => void discard()}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onPick={(t) => {
          setScheduleOpen(false);
          void send(t);
        }}
      />
    </div>
  );
}

function at(daysAhead: number, hour: number, weekday?: number): Date {
  const d = new Date();
  if (weekday !== undefined) {
    const diff = (weekday + 7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + diff);
  } else d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export function ScheduleModal({ open, onClose, onPick, title = 'Schedule send' }: { open: boolean; onClose: () => void; onPick: (ts: number) => void; title?: string }) {
  const [custom, setCustom] = useState('');
  const presets = [
    { label: 'Tomorrow morning', date: at(1, 8) },
    { label: 'Tomorrow afternoon', date: at(1, 13) },
    { label: 'Monday morning', date: at(0, 8, 1) },
  ];
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-sm">
      <div className="-mx-2 flex flex-col">
        {presets.map((p) => (
          <button key={p.label} onClick={() => onPick(p.date.getTime())} className="flex items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm hover:bg-hover">
            <span>{p.label}</span>
            <span className="text-muted">{p.date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 border-t border-line pt-4">
        <label className="mb-1.5 block text-[13px] font-medium">Pick date & time</label>
        <div className="flex gap-2">
          <Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button
            variant="primary"
            disabled={!custom || new Date(custom).getTime() < Date.now() + 60_000}
            onClick={() => onPick(new Date(custom).getTime())}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface SavedReply {
  id: number;
  name: string;
  html: string;
}

export function useSavedReplies() {
  return useQuery({ queryKey: ['me', 'saved-replies'], queryFn: () => apiFor(null).get<{ replies: SavedReply[] }>('/api/me/saved-replies').then((r) => r.replies), staleTime: 60_000 });
}

/** Insert a saved reply, or save what's written as a new one. */
function SavedRepliesMenu({ onInsert, currentHtml, subject }: { onInsert: (html: string) => void; currentHtml: () => string; subject: string }) {
  const replies = useSavedReplies();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Menu
      align="left"
      width="w-64"
      trigger={({ onClick }) => (
        <IconButton size="sm" label="Saved replies" onClick={onClick}>
          <FileText className="size-4" />
        </IconButton>
      )}
      items={[
        ...(replies.data ?? []).map((r) => ({ label: r.name, onClick: () => onInsert(r.html) })),
        ...(replies.data?.length ? [{ divider: true }] : []),
        {
          label: 'Save this message as a reply…',
          onClick: async () => {
            // Without the signature and quoted text: just what was written.
            const doc = document.createElement('div');
            doc.innerHTML = currentHtml();
            doc.querySelectorAll('.wren-signature, .wren-quote, .wren-forward').forEach((n) => n.remove());
            const body = doc.innerHTML.trim();
            if (!doc.textContent?.trim()) return void toast({ message: 'Write something first', tone: 'error' });
            const name = window.prompt('Name this saved reply', subject.replace(/^(re|fwd?):\s*/i, '').slice(0, 60))?.trim();
            if (!name) return;
            try {
              await apiFor(null).post('/api/me/saved-replies', { name, html: body });
              qc.invalidateQueries({ queryKey: ['me', 'saved-replies'] });
              toast(`Saved “${name}”`);
            } catch (err) {
              toast({ message: (err as Error).message, tone: 'error' });
            }
          },
        },
        { label: 'Manage saved replies', onClick: () => navigate('/settings/replies') },
      ]}
    />
  );
}
