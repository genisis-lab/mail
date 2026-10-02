import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Flag,
  FolderInput,
  Forward,
  Inbox,
  Mail,
  MoreVertical,
  OctagonAlert,
  Paperclip,
  Printer,
  Reply,
  ReplyAll,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  Ban,
  X,
  FileImage,
  FileArchive,
  Code2,
  AtSign,
  MailX,
} from 'lucide-react';
import type { Label, MessageDetail, ThreadDetail } from '../../../shared/types';
import { api, mailboxUrl } from '../../lib/api';
import { snoozeOptions, useThreadActions, type ThreadAction } from '../../lib/actions';
import { fileSize, longDate, relativeTime, shortDate } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { useLabels, useSession } from '../../lib/session';
import { useMailbox } from '../../lib/mailbox';
import { TABS } from './ThreadList';
import { Avatar } from '../../components/Avatar';
import { ComposeForm, ScheduleModal, useCompose, type ComposeInit } from '../../components/Compose';
import { BlockedImagesBanner, MessageBody } from '../../components/MessageBody';
import { useToast } from '../../components/toast';
import { Badge, Button, cx, Empty, IconButton, Menu, Spinner, type MenuItem } from '../../components/ui';
import { LabelDialog } from '../MailLayout';
import { getListContext, listBase } from './listContext';

export function ThreadView() {
  const params = useParams();
  const threadId = Number(params.threadId);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const { prefs, user, refresh: refreshSession } = useSession();
  const mailbox = useMailbox();
  const labels = useLabels();
  const { run } = useThreadActions();
  const base = listBase(location.pathname);
  const backTo = `${base}${location.search}`;

  const thread = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.get<ThreadDetail>(`/api/mail/threads/${threadId}`),
    enabled: Number.isFinite(threadId),
  });

  // Opening marks messages as read on the server; refresh counters/list.
  useEffect(() => {
    if (thread.data) {
      qc.invalidateQueries({ queryKey: ['counters'] });
      qc.invalidateQueries({ queryKey: ['threads'] });
    }
  }, [thread.data?.id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAllCollapsed, setShowAllCollapsed] = useState(false);
  const [reply, setReply] = useState<(ComposeInit & { key: number; mode: string }) | null>(null);
  const [labelDialog, setLabelDialog] = useState(false);
  const [customSnooze, setCustomSnooze] = useState(false);

  const messages = useMemo(() => (thread.data?.messages ?? []).filter((m) => m.folder !== 'drafts'), [thread.data]);
  const drafts = useMemo(() => (thread.data?.messages ?? []).filter((m) => m.folder === 'drafts'), [thread.data]);

  useEffect(() => {
    if (!thread.data) return;
    const last = messages[messages.length - 1];
    setExpanded(new Set(messages.filter((m, i) => i === messages.length - 1 || (!m.isRead && m.id !== last?.id)).map((m) => m.id)));
    setShowAllCollapsed(false);
    setReply(null);
  }, [thread.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = getListContext();
  const idx = ctx.base === base ? ctx.ids.indexOf(threadId) : -1;
  const newer = idx > 0 ? ctx.ids[idx - 1] : null;
  const older = idx >= 0 && idx < ctx.ids.length - 1 ? ctx.ids[idx + 1] : null;
  const goThread = (id: number | null) => id && navigate(`${base}/${id}${location.search}`);

  const act = useCallback(
    async (action: ThreadAction, leave = true) => {
      await run([threadId], action);
      if (leave) {
        // Gmail-style: go to the next conversation, or back to the list.
        if (older) goThread(older);
        else navigate(backTo);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, threadId, older, backTo],
  );

  const startReply = async (m: MessageDetail, mode: 'reply' | 'replyAll' | 'forward') => {
    try {
      const t = await compose.openTemplate(m.id, mode);
      setReply({ ...t, key: Date.now(), mode });
      setTimeout(() => document.getElementById('wren-reply')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };

  const last = messages[messages.length - 1];
  useHotkeys((key) => {
    if (!prefs.keyboardShortcuts || !thread.data) return;
    switch (key) {
      case 'u':
      case 'Escape':
        navigate(backTo);
        return true;
      case 'j':
        goThread(older);
        return true;
      case 'k':
        goThread(newer);
        return true;
      case 'r':
        if (last) void startReply(last, 'reply');
        return true;
      case 'a':
        if (last) void startReply(last, 'replyAll');
        return true;
      case 'f':
        if (last) void startReply(last, 'forward');
        return true;
      case 'e':
        void act({ type: 'archive' });
        return true;
      case '#':
        void act({ type: 'trash' });
        return true;
      case '!':
        void act({ type: 'spam' });
        return true;
      case 's':
        void run([threadId], { type: messages.some((m) => m.isStarred) ? 'unstar' : 'star' }, { quiet: true });
        return true;
      case 'U':
        void run([threadId], { type: 'unread' }, { quiet: true }).then(() => navigate(backTo));
        return true;
    }
  });

  if (thread.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (thread.isError || !thread.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 items-center border-b border-line px-2">
          <IconButton label="Back" onClick={() => navigate(backTo)}>
            <ArrowLeft className="size-[18px]" />
          </IconButton>
        </div>
        <Empty title="Conversation not found">It may have been deleted.</Empty>
      </div>
    );
  }

  const t = thread.data;
  const folders = new Set(t.messages.map((m) => m.folder));
  const inInbox = folders.has('inbox');
  const inTrash = messages.length > 0 && messages.every((m) => m.folder === 'trash');
  const inSpam = messages.length > 0 && messages.every((m) => m.folder === 'spam');
  const threadLabels = new Set(t.messages.flatMap((m) => m.labels));
  const starred = messages.some((m) => m.isStarred);
  const important = messages.some((m) => m.isImportant);

  const labelItems: MenuItem[] = [
    ...(labels.data ?? []).map((l) => ({
      label: l.name,
      checked: threadLabels.has(l.id),
      onClick: () => void run([threadId], { type: threadLabels.has(l.id) ? 'unlabel' : 'label', labelId: l.id }, { quiet: true }),
    })),
    ...(labels.data?.length ? [{ divider: true }] : []),
    { label: 'Create new label…', onClick: () => setLabelDialog(true) },
  ];

  // Collapse long threads: first, "N more", then the last few.
  const collapseMiddle = messages.length > 4 && !showAllCollapsed;
  const visible = collapseMiddle ? [messages[0], null, ...messages.slice(-2)] : messages;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="no-print flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="Back to list (u)" onClick={() => navigate(backTo)}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        {inTrash ? (
          <>
            <IconButton label="Restore" onClick={() => void act({ type: 'untrash' })}>
              <RotateCcw className="size-[18px]" />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete forever?') && void act({ type: 'delete' })}>
              Delete forever
            </Button>
          </>
        ) : inSpam ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void act({ type: 'notspam' })}>
              Not spam
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete forever?') && void act({ type: 'delete' })}>
              Delete forever
            </Button>
          </>
        ) : (
          <>
            {inInbox ? (
              <IconButton label="Archive (e)" onClick={() => void act({ type: 'archive' })}>
                <Archive className="size-[18px]" />
              </IconButton>
            ) : (
              <IconButton label="Move to Inbox" onClick={() => void act({ type: 'inbox' }, false)}>
                <Inbox className="size-[18px]" />
              </IconButton>
            )}
            <IconButton label="Report spam (!)" onClick={() => void act({ type: 'spam' })}>
              <OctagonAlert className="size-[18px]" />
            </IconButton>
            <IconButton label="Delete (#)" onClick={() => void act({ type: 'trash' })}>
              <Trash2 className="size-[18px]" />
            </IconButton>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Mark as unread (U)" onClick={() => void run([threadId], { type: 'unread' }, { quiet: true }).then(() => navigate(backTo))}>
          <Mail className="size-[18px]" />
        </IconButton>
        {!inTrash && !inSpam && (
          <Menu
            trigger={({ onClick }) => (
              <IconButton label="Snooze" onClick={onClick}>
                <Clock className="size-[18px]" />
              </IconButton>
            )}
            width="w-72"
            items={[
              ...snoozeOptions().map((o) => ({ label: o.label, hint: o.hint, onClick: () => void act({ type: 'snooze', until: o.at }) })),
              { divider: true },
              { label: 'Pick date & time', icon: <CalendarClock className="size-4" />, onClick: () => setCustomSnooze(true) },
            ]}
          />
        )}
        <Menu
          trigger={({ onClick }) => (
            <IconButton label="Labels" onClick={onClick}>
              <Tag className="size-[18px]" />
            </IconButton>
          )}
          items={labelItems}
        />
        <Menu
          trigger={({ onClick }) => (
            <IconButton label="Move to" onClick={onClick}>
              <FolderInput className="size-[18px]" />
            </IconButton>
          )}
          items={[
            { label: 'Inbox', icon: <Inbox className="size-4" />, onClick: () => void act({ type: 'inbox' }, false) },
            { label: 'Archive', icon: <Archive className="size-4" />, onClick: () => void act({ type: 'archive' }) },
            { label: 'Spam', icon: <OctagonAlert className="size-4" />, onClick: () => void act({ type: 'spam' }) },
            { label: 'Trash', icon: <Trash2 className="size-4" />, onClick: () => void act({ type: 'trash' }) },
            ...(prefs.inboxTabs && messages.some((m) => m.direction === 'in')
              ? [
                  { divider: true },
                  ...TABS.filter((t) => t.id !== messages.filter((m) => m.direction === 'in').at(-1)?.category).map((t) => ({
                    label: t.label,
                    icon: t.icon,
                    onClick: async () => {
                      await run([threadId], { type: 'category', category: t.id }, { quiet: true });
                      const from = messages.filter((m) => m.direction === 'in').at(-1)?.from;
                      toast(`Moved to ${t.label}. Future mail from ${from?.name || from?.address || 'this sender'} goes there too.`);
                    },
                  })),
                ]
              : []),
          ]}
        />
        <Menu
          trigger={({ onClick }) => (
            <IconButton label="More" onClick={onClick}>
              <MoreVertical className="size-[18px]" />
            </IconButton>
          )}
          items={[
            { label: important ? 'Mark as not important' : 'Mark as important', icon: <Flag className="size-4" />, onClick: () => void run([threadId], { type: important ? 'unimportant' : 'important' }) },
            { label: starred ? 'Remove star' : 'Add star', icon: <Star className="size-4" />, onClick: () => void run([threadId], { type: starred ? 'unstar' : 'star' }, { quiet: true }) },
            { label: 'Print all', icon: <Printer className="size-4" />, onClick: () => window.print() },
          ]}
        />
        <div className="ml-auto flex items-center text-xs text-muted">
          {idx >= 0 && (
            <span className="px-2 max-sm:hidden">
              {idx + 1} of {ctx.ids.length}
            </span>
          )}
          <IconButton label="Newer (k)" disabled={!newer} onClick={() => goThread(newer)}>
            <ChevronLeft className="size-[18px]" />
          </IconButton>
          <IconButton label="Older (j)" disabled={!older} onClick={() => goThread(older)}>
            <ChevronRight className="size-[18px]" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1100px] px-6 pt-5 pb-10 max-sm:px-3">
          <div className="mb-4 flex items-start gap-3 pl-14 max-sm:pl-0">
            <h1 className="flex-1 text-[22px] leading-snug font-normal break-words">
              {t.subject || '(no subject)'}
              {[...threadLabels]
                .map((id) => labels.data?.find((l) => l.id === id))
                .filter((l): l is Label => !!l)
                .map((l) => (
                  <span key={l.id} className="ml-2 inline-flex translate-y-[-3px] items-center gap-1 rounded px-1.5 align-middle text-xs font-medium" style={{ background: `${l.color}22`, color: `color-mix(in srgb, ${l.color} 45%, var(--fg))` }}>
                    {l.name}
                    <button aria-label={`Remove label ${l.name}`} onClick={() => void run([threadId], { type: 'unlabel', labelId: l.id }, { quiet: true })} className="opacity-70 hover:opacity-100">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              {inInbox && <span className="ml-2 inline-flex translate-y-[-3px] rounded bg-panel3 px-1.5 align-middle text-xs text-muted">Inbox</span>}
            </h1>
            <IconButton label="Print" onClick={() => window.print()} className="no-print max-sm:hidden">
              <Printer className="size-[18px]" />
            </IconButton>
          </div>

          <div className="space-y-0">
            {visible.map((m, i) =>
              m === null ? (
                <button
                  key="more"
                  onClick={() => setShowAllCollapsed(true)}
                  className="relative my-1 flex w-full items-center justify-center border-y border-line py-2"
                >
                  <span className="flex size-9 items-center justify-center rounded-full border border-line-strong bg-panel text-xs font-semibold text-muted">
                    {messages.length - 3}
                  </span>
                </button>
              ) : (
                <MessageCard
                  key={m.id}
                  m={m}
                  isLast={i === visible.length - 1}
                  expanded={expanded.has(m.id)}
                  onToggle={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(m.id)) n.delete(m.id);
                      else n.add(m.id);
                      return n;
                    })
                  }
                  onReply={(mode) => void startReply(m, mode)}
                  meAddress={mailbox.current?.address ?? user.email}
                  canBlockRecipients={!mailbox.current && (user.role === 'owner' || user.role === 'admin')}
                  alwaysShowImages={prefs.showImages === 'always'}
                  onAlwaysShowImages={async () => {
                    await api.put('/api/account/prefs', { showImages: 'always' });
                    await refreshSession();
                    toast('Images will always be displayed');
                  }}
                />
              ),
            )}
          </div>

          {drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => void compose.openDraft(d.id)}
              className="mt-3 flex w-full items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3 text-left text-sm hover:bg-hover"
            >
              <span className="font-medium text-danger">Draft</span>
              <span className="truncate text-muted">{d.snippet || '(empty)'}</span>
              <span className="ml-auto shrink-0 text-xs text-faint">{shortDate(d.date)}</span>
            </button>
          ))}

          {reply ? (
            <div id="wren-reply" className="mt-5 flex gap-4">
              <Avatar name={user.name} address={user.email} size={40} className="max-sm:hidden" />
              <div className="flex min-h-[260px] flex-1 flex-col rounded-2xl border border-line-strong bg-panel px-4 pt-2 shadow-panel">
                <div className="flex items-center gap-2 pb-1 text-xs text-muted">
                  {reply.mode === 'forward' ? <Forward className="size-4" /> : reply.mode === 'replyAll' ? <ReplyAll className="size-4" /> : <Reply className="size-4" />}
                  <span className="flex-1">{reply.mode === 'forward' ? 'Forward' : reply.mode === 'replyAll' ? 'Reply all' : 'Reply'}</span>
                  <IconButton
                    size="sm"
                    label="Pop out reply"
                    onClick={() => {
                      const r = reply;
                      setReply(null);
                      compose.open(r);
                    }}
                  >
                    <ExternalLink className="size-4" />
                  </IconButton>
                </div>
                <ComposeForm
                  key={reply.key}
                  init={reply}
                  variant="inline"
                  autoFocusBody={reply.mode !== 'forward'}
                  onClose={() => {
                    setReply(null);
                    void thread.refetch();
                  }}
                  onReopen={(init) => compose.open(init)}
                />
              </div>
            </div>
          ) : (
            last && (
              <div className="no-print mt-6 flex flex-wrap gap-2 pl-14 max-sm:pl-0">
                <Button icon={<Reply className="size-4" />} onClick={() => void startReply(last, 'reply')}>
                  Reply
                </Button>
                {last.to.length + last.cc.length > 1 && (
                  <Button icon={<ReplyAll className="size-4" />} onClick={() => void startReply(last, 'replyAll')}>
                    Reply all
                  </Button>
                )}
                <Button icon={<Forward className="size-4" />} onClick={() => void startReply(last, 'forward')}>
                  Forward
                </Button>
              </div>
            )
          )}
        </div>
      </div>

      <LabelDialog label={labelDialog ? { name: '' } : null} onClose={() => setLabelDialog(false)} onCreated={(l) => void run([threadId], { type: 'label', labelId: l.id }, { quiet: true })} />
      <ScheduleModal
        open={customSnooze}
        title="Snooze until"
        onClose={() => setCustomSnooze(false)}
        onPick={(ts) => {
          setCustomSnooze(false);
          void act({ type: 'snooze', until: ts });
        }}
      />
    </div>
  );
}

function recipientsSummary(m: MessageDetail, me: string): string {
  const all = [...m.to, ...m.cc];
  if (!all.length) return m.bcc.length ? 'bcc: ' + m.bcc.map((a) => a.name || a.address).join(', ') : '';
  return all
    .slice(0, 4)
    .map((a) => (a.address.toLowerCase() === me.toLowerCase() ? 'me' : a.name?.split(' ')[0] || a.address))
    .join(', ')
    .concat(all.length > 4 ? ` +${all.length - 4}` : '');
}

function MessageCard({
  m,
  isLast,
  expanded,
  onToggle,
  onReply,
  meAddress,
  alwaysShowImages,
  onAlwaysShowImages,
  canBlockRecipients,
}: {
  canBlockRecipients: boolean;
  m: MessageDetail;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward') => void;
  meAddress: string;
  alwaysShowImages: boolean;
  onAlwaysShowImages: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showDetails, setShowDetails] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const fromName = m.direction === 'out' && m.from.address.toLowerCase() === meAddress.toLowerCase() ? m.from.name || 'me' : m.from.name || m.from.address;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['thread'] });
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['counters'] });
  };
  const msgAction = async (type: string) => {
    await api.post(`/api/mail/messages/${m.id}/actions`, { type });
    invalidate();
  };
  const via = m.direction === 'in' && m.deliveredTo && m.deliveredTo.toLowerCase() !== meAddress.toLowerCase() ? m.deliveredTo : null;
  const aliases = useQuery({ queryKey: ['me', 'aliases'], queryFn: () => api.get<{ aliases: { id: number; address: string; kind: string; enabled: boolean }[] }>('/api/me/aliases'), enabled: !!via && expanded });
  const viaAlias = via ? aliases.data?.aliases.find((a) => a.kind === 'alias' && a.address.toLowerCase() === via.toLowerCase()) : undefined;
  const unsubscribe = async () => {
    if (!window.confirm(`Unsubscribe from ${m.from.name || m.from.address}? Wren asks the sender to stop mailing you.`)) return;
    try {
      const r = await api.post<{ method: 'one-click' | 'email' | 'link'; url?: string }>(`/api/mail/messages/${m.id}/unsubscribe`);
      invalidate();
      if (r.method === 'link' && r.url) {
        window.open(r.url, '_blank', 'noopener,noreferrer');
        toast('The sender’s unsubscribe page opened in a new tab');
      } else toast(r.method === 'email' ? `Unsubscribe request sent to ${m.from.name || m.from.address}` : `Unsubscribed from ${m.from.name || m.from.address}`);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const visibleAttachments = m.attachments.filter((a) => !a.inline || !m.html?.includes(`cid:${a.contentId}`));
  const scheduled = m.status === 'queued' && m.sendAt && m.sendAt > Date.now() + 30_000;

  if (!expanded) {
    return (
      <div onClick={onToggle} className="flex cursor-pointer items-center gap-4 border-t border-line px-2 py-3 hover:bg-hover">
        <Avatar name={m.from.name} address={m.from.address} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cx('truncate text-sm', !m.isRead ? 'font-bold' : 'font-semibold')}>{fromName}</span>
            {m.attachments.some((a) => !a.inline) && <Paperclip className="size-3.5 shrink-0 text-muted" />}
          </div>
          <p className="truncate text-sm text-muted">{m.snippet}</p>
        </div>
        <span className="shrink-0 text-xs text-muted">{shortDate(m.date)}</span>
      </div>
    );
  }

  return (
    <article className={cx('border-t border-line px-2 pt-4', isLast ? 'pb-2' : 'pb-5')}>
      <header className="flex items-start gap-4">
        <Avatar name={m.from.name} address={m.from.address} size={40} className="cursor-pointer" />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-bold">{fromName}</span>
            <span className="truncate text-xs text-muted">&lt;{m.from.address}&gt;</span>
            {m.sentBy && <span className="rounded bg-accent-soft px-1.5 text-[11px] leading-[18px] font-medium text-accent-ink">sent by {m.sentBy.name || m.sentBy.email}</span>}
            {m.canUnsubscribe &&
              (m.unsubscribed ? (
                <span className="text-xs text-faint">Unsubscribed</span>
              ) : (
                <button
                  type="button"
                  className="no-print text-xs font-medium text-accent-ink underline-offset-2 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    void unsubscribe();
                  }}
                >
                  Unsubscribe
                </button>
              ))}
          </div>
          <button
            className="flex items-center gap-0.5 text-xs text-muted hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails((s) => !s);
            }}
          >
            to {recipientsSummary(m, meAddress)}
            {via && <span className="ml-1 text-faint">· via {via}</span>}
            <ChevronDown className={cx('size-3.5 transition-transform', showDetails && 'rotate-180')} />
          </button>
        </div>
        <div className="no-print flex shrink-0 items-center gap-0.5">
          <span className="mr-2 text-xs text-muted max-sm:hidden" title={longDate(m.date)}>
            {longDate(m.date)} ({relativeTime(m.date)})
          </span>
          <IconButton size="sm" label={m.isStarred ? 'Remove star' : 'Add star'} aria-pressed={m.isStarred} onClick={() => void msgAction(m.isStarred ? 'unstar' : 'star')}>
            <Star className={cx('size-[18px]', m.isStarred && 'fill-[#f4b400] text-[#f4b400]')} />
          </IconButton>
          <IconButton size="sm" label="Reply" onClick={() => onReply('reply')}>
            <Reply className="size-[18px]" />
          </IconButton>
          <Menu
            align="right"
            trigger={({ onClick }) => (
              <IconButton size="sm" label="More" onClick={onClick}>
                <MoreVertical className="size-[18px]" />
              </IconButton>
            )}
            items={[
              { label: 'Reply', icon: <Reply className="size-4" />, onClick: () => onReply('reply') },
              { label: 'Reply all', icon: <ReplyAll className="size-4" />, onClick: () => onReply('replyAll') },
              { label: 'Forward', icon: <Forward className="size-4" />, onClick: () => onReply('forward') },
              { divider: true },
              { label: 'Print', icon: <Printer className="size-4" />, onClick: () => window.print() },
              { label: 'Show original', icon: <Code2 className="size-4" />, onClick: () => window.open(mailboxUrl(`/api/mail/messages/${m.id}/raw`), '_blank') },
              { label: 'Download message', icon: <Download className="size-4" />, onClick: () => (window.location.href = mailboxUrl(`/api/mail/messages/${m.id}/raw?download=1`)) },
              { divider: true },
              { label: 'Mark unread from here', icon: <Mail className="size-4" />, onClick: () => void msgAction('unread') },
              ...(m.canUnsubscribe && !m.unsubscribed ? [{ label: 'Unsubscribe', icon: <MailX className="size-4" />, onClick: () => void unsubscribe() }] : []),
              ...(viaAlias?.enabled
                ? [
                    {
                      label: `Turn off ${viaAlias.address}`,
                      icon: <AtSign className="size-4" />,
                      onClick: async () => {
                        if (!window.confirm(`Turn off ${viaAlias.address}? Mail sent to it will bounce. You can turn it back on in Settings → Accounts.`)) return;
                        await api.put(`/api/me/aliases/${viaAlias.id}`, { enabled: false });
                        qc.invalidateQueries({ queryKey: ['me', 'aliases'] });
                        toast(`${viaAlias.address} turned off`);
                      },
                    },
                  ]
                : via && !viaAlias && aliases.isSuccess && canBlockRecipients
                  ? [
                      {
                        label: `Block mail to ${via}`,
                        icon: <AtSign className="size-4" />,
                        onClick: async () => {
                          if (!window.confirm(`Refuse all mail to ${via}? It reached you through the catch-all. You can undo this under Admin → Domains.`)) return;
                          await api.post('/api/admin/blocked-recipients', { address: via });
                          toast(`Mail to ${via} will be refused`);
                        },
                      },
                    ]
                  : []),
              ...(m.direction === 'in'
                ? [
                    {
                      label: `Block “${m.from.name || m.from.address}”`,
                      icon: <Ban className="size-4" />,
                      onClick: async () => {
                        if (!window.confirm(`Block ${m.from.address}? Future messages go to Spam.`)) return;
                        const r = await api.post<{ moved: number }>('/api/mail/block', { address: m.from.address });
                        invalidate();
                        toast(`${m.from.address} blocked${r.moved ? ` · ${r.moved} message(s) moved to Spam` : ''}`);
                      },
                    },
                  ]
                : []),
              {
                label: m.folder === 'trash' ? 'Delete forever' : 'Delete this message',
                icon: <Trash2 className="size-4" />,
                danger: true,
                onClick: () => void msgAction(m.folder === 'trash' ? 'delete' : 'trash'),
              },
            ]}
          />
        </div>
      </header>

      {showDetails && (
        <div className="mt-2 ml-14 rounded-xl border border-line bg-panel p-4 text-[13px] shadow-panel max-sm:ml-0">
          <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1">
            <dt className="text-right text-muted">from:</dt>
            <dd className="break-all">
              <b>{m.from.name}</b> &lt;{m.from.address}&gt;
            </dd>
            {m.replyTo && (
              <>
                <dt className="text-right text-muted">reply-to:</dt>
                <dd className="break-all">{m.replyTo}</dd>
              </>
            )}
            <dt className="text-right text-muted">to:</dt>
            <dd className="break-all">{m.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ') || '—'}</dd>
            {m.cc.length > 0 && (
              <>
                <dt className="text-right text-muted">cc:</dt>
                <dd className="break-all">{m.cc.map((a) => a.address).join(', ')}</dd>
              </>
            )}
            {m.bcc.length > 0 && (
              <>
                <dt className="text-right text-muted">bcc:</dt>
                <dd className="break-all">{m.bcc.map((a) => a.address).join(', ')}</dd>
              </>
            )}
            {via && (
              <>
                <dt className="text-right text-muted">delivered to:</dt>
                <dd className="break-all">{via}</dd>
              </>
            )}
            <dt className="text-right text-muted">date:</dt>
            <dd>{longDate(m.date)}</dd>
            <dt className="text-right text-muted">subject:</dt>
            <dd>{m.subject}</dd>
            {m.authResults && (
              <>
                <dt className="text-right text-muted">security:</dt>
                <dd className="flex flex-wrap gap-1">
                  {(['spf', 'dkim', 'dmarc'] as const)
                    .filter((k) => m.authResults?.[k])
                    .map((k) => (
                      <Badge key={k} tone={m.authResults?.[k] === 'pass' ? 'ok' : m.authResults?.[k] === 'fail' ? 'danger' : 'neutral'}>
                        {k.toUpperCase()}: {m.authResults?.[k]}
                      </Badge>
                    ))}
                  {m.spamScore !== null && <Badge>spam score {m.spamScore}</Badge>}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="mt-3 ml-14 max-sm:ml-0">
        {m.folder === 'spam' && (
          <div className="mb-3 flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-4 py-3 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              <p className="font-medium">Why is this message in spam?</p>
              <p className="mt-0.5 text-muted">
                {m.authResults?.reasons ? `Spam signals: ${m.authResults.reasons}` : 'It matched spam filters or a sender you blocked.'}
              </p>
            </div>
          </div>
        )}
        {m.direction === 'out' && m.status === 'failed' && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3 text-[13px]">
            <OctagonAlert className="size-4 shrink-0 text-danger" />
            <span className="min-w-0 flex-1">
              <b>Not delivered.</b> {m.lastError}
            </span>
            <Button
              size="sm"
              onClick={async () => {
                await api.post(`/api/mail/messages/${m.id}/retry`);
                invalidate();
                toast('Retrying delivery…');
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {m.direction === 'out' && (m.status === 'queued' || m.status === 'sending') && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-accent-softer px-4 py-3 text-[13px]">
            {scheduled ? <CalendarClock className="size-4 text-accent-ink" /> : <Clock className="size-4 text-accent-ink" />}
            <span className="flex-1">
              {scheduled ? (
                <>
                  Scheduled to send <b>{longDate(m.sendAt!)}</b>
                </>
              ) : m.lastError ? (
                <>Delivery is being retried. {m.lastError}</>
              ) : (
                'Sending…'
              )}
            </span>
            {m.status === 'queued' && (
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await api.post(`/api/compose/messages/${m.id}/cancel`);
                    invalidate();
                    toast(scheduled ? 'Scheduled send cancelled — the message is in Drafts' : 'Sending cancelled');
                  } catch (err) {
                    toast({ message: (err as Error).message, tone: 'error' });
                  }
                }}
              >
                {scheduled ? 'Cancel send' : 'Cancel'}
              </Button>
            )}
          </div>
        )}
        {m.direction === 'in' && m.authResults?.dmarc === 'fail' && m.folder !== 'spam' && (
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-4 py-2.5 text-[13px] text-warn">
            <ShieldAlert className="size-4" /> Be careful with this message — the sender couldn’t be verified.
          </div>
        )}
        {m.direction === 'in' && m.authResults?.dkim === 'pass' && m.authResults?.spf === 'pass' && showDetails && (
          <p className="mb-2 flex items-center gap-1 text-xs text-ok">
            <ShieldCheck className="size-3.5" /> Signed and verified
          </p>
        )}

        {!alwaysShowImages && !showImages && <BlockedImagesBanner count={blocked} onShow={() => setShowImages(true)} onAlways={onAlwaysShowImages} />}
        <MessageBody html={m.html} text={m.text} attachments={m.attachments} allowRemote={alwaysShowImages || showImages} onBlockedImages={setBlocked} />

        {visibleAttachments.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-3 text-sm font-medium">
              {visibleAttachments.length} attachment{visibleAttachments.length > 1 ? 's' : ''}
            </p>
            <div className="flex flex-wrap gap-3">
              {visibleAttachments.map((a) => (
                <a
                  key={a.id}
                  href={`/api/attachments/${a.id}`}
                  className="group relative flex h-[120px] w-[180px] flex-col overflow-hidden rounded-xl border border-line bg-panel2 hover:shadow-panel"
                  title={`Download ${a.filename}`}
                >
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                    {a.contentType.startsWith('image/') ? (
                      <img src={`/api/attachments/${a.id}?inline=1`} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <AttachmentIcon type={a.contentType} name={a.filename} />
                    )}
                  </div>
                  <div className="flex items-center gap-2 border-t border-line bg-panel px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.filename}</span>
                    <span className="shrink-0 text-[11px] text-muted">{fileSize(a.size)}</span>
                  </div>
                  <span className="absolute top-2 right-2 hidden rounded-full bg-black/60 p-1.5 text-white group-hover:block">
                    <Download className="size-3.5" />
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function AttachmentIcon({ type, name }: { type: string; name: string }) {
  const ext = name.split('.').pop()?.toUpperCase().slice(0, 4) ?? '';
  const Icon = type.startsWith('image/') ? FileImage : /zip|compressed|tar|rar|7z/.test(type) ? FileArchive : FileText;
  const color = /pdf/.test(type) ? '#d93025' : /sheet|excel|csv/.test(type) ? '#188038' : /word|document/.test(type) ? '#1a73e8' : /presentation|powerpoint/.test(type) ? '#e8710a' : 'var(--muted)';
  return (
    <div className="flex flex-col items-center gap-1">
      <Icon className="size-10" style={{ color }} strokeWidth={1.5} />
      <span className="text-[10px] font-bold tracking-wider" style={{ color }}>
        {ext}
      </span>
    </div>
  );
}
