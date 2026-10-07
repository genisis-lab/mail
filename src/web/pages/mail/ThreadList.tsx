import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  FolderInput,
  Inbox,
  MailOpen,
  Mail,
  MoreVertical,
  OctagonAlert,
  Paperclip,
  RefreshCw,
  Star,
  Tag,
  Trash2,
  CalendarClock,
  Search,
  Send,
  File as FileIcon,
  Megaphone,
  BellRing,
  BellOff,
  Combine,
} from 'lucide-react';
import type { Category, Label, ThreadSummary, View } from '../../../shared/types';
import { api, qs } from '../../lib/api';
import { snoozeOptions, useThreadActions, type ThreadAction } from '../../lib/actions';
import { shortDate, number, relativeTime } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { PHONE, useMediaQuery } from '../../lib/media';
import { useCounters, useLabels, useSession } from '../../lib/session';
import { useCompose, ScheduleModal } from '../../components/Compose';
import { useToast } from '../../components/toast';
import { Button, Checkbox, cx, Empty, IconButton, Menu, Spinner, type MenuItem } from '../../components/ui';
import { LabelDialog, SaveSearchButton } from '../MailLayout';
import { setListContext } from './listContext';
import { PhoneRow } from './PhoneRow';
import { ViaChip } from './Via';
import { NudgeChip } from './NudgeChip';
import { CodeChip } from '../../components/CodeChip';

export const TABS: { id: Category; label: string; icon: React.ReactNode; empty: string }[] = [
  { id: 'primary', label: 'Primary', icon: <Inbox className="size-[18px]" />, empty: 'You’re all caught up' },
  { id: 'updates', label: 'Updates', icon: <BellRing className="size-[18px]" />, empty: 'No updates: receipts, alerts and notifications go here' },
  { id: 'promotions', label: 'Promotions', icon: <Megaphone className="size-[18px]" />, empty: 'No promotions: newsletters and offers go here' },
];

interface ListResponse {
  threads: ThreadSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const TITLES: Record<View, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  important: 'Important',
  sent: 'Sent',
  scheduled: 'Scheduled',
  drafts: 'Drafts',
  all: 'All Mail',
  spam: 'Spam',
  trash: 'Trash',
};

const EMPTY: Record<View, { icon: React.ReactNode; title: string; body?: string }> = {
  inbox: { icon: <Inbox className="size-7" />, title: 'You’re all caught up', body: 'New mail will show up here.' },
  starred: { icon: <Star className="size-7" />, title: 'No starred messages', body: 'Stars let you give messages a special status to make them easier to find.' },
  snoozed: { icon: <Clock className="size-7" />, title: 'Nothing snoozed', body: 'Snooze a conversation to have it return to your inbox later.' },
  important: { icon: <Flag className="size-7" />, title: 'No important messages' },
  sent: { icon: <Send className="size-7" />, title: 'No sent messages', body: 'Messages you send will appear here.' },
  scheduled: { icon: <CalendarClock className="size-7" />, title: 'Nothing scheduled', body: 'Use “Schedule send” from the Send button.' },
  drafts: { icon: <FileIcon className="size-7" />, title: 'You don’t have any saved drafts', body: 'Saving a draft allows you to keep a message you aren’t ready to send yet.' },
  all: { icon: <Mail className="size-7" />, title: 'No conversations yet' },
  spam: { icon: <OctagonAlert className="size-7" />, title: 'Hooray, no spam here!' },
  trash: { icon: <Trash2 className="size-7" />, title: 'No conversations in Trash' },
};

export function ThreadList() {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { prefs, instance } = useSession();
  const labels = useLabels();
  const counters = useCounters();
  const compose = useCompose();
  const toast = useToast();
  const { run, refresh } = useThreadActions();
  const phone = useMediaQuery(PHONE);
  const pull = usePullToRefresh(phone, async () => {
    await Promise.all([list.refetch(), counters.refetch()]);
  });

  const view = (params.view as View | undefined) ?? (params.labelId || params.q ? undefined : 'inbox');
  const labelId = params.labelId ? Number(params.labelId) : undefined;
  const q = params.q ? decodeURIComponent(params.q) : undefined;
  const page = Math.max(1, Number(search.get('page') ?? 1));
  const base = location.pathname;
  const tabbed = view === 'inbox' && prefs.inboxTabs;
  const tab: Category | undefined = tabbed ? (TABS.find((t) => t.id === search.get('tab'))?.id ?? 'primary') : undefined;
  /** Change the page or tab, keeping the other. */
  const go = (next: { page?: number; tab?: Category }) => {
    const p = new URLSearchParams();
    const nt = next.tab ?? tab;
    if (nt && nt !== 'primary') p.set('tab', nt);
    const np = next.tab !== undefined ? 1 : (next.page ?? page);
    if (np > 1) p.set('page', String(np));
    setSearch(p);
  };

  const list = useQuery({
    queryKey: ['threads', { view, labelId, q, page, pageSize: prefs.pageSize, category: tab }],
    queryFn: () => api.get<ListResponse>(`/api/mail/threads${qs({ view, label: labelId, q, page, pageSize: prefs.pageSize, category: tab })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const threads = useMemo(() => list.data?.threads ?? [], [list.data]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [labelDialog, setLabelDialog] = useState(false);
  const [customSnooze, setCustomSnooze] = useState(false);

  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setCursor(0);
  }, [view, labelId, q, page, tab]);

  useEffect(() => {
    setListContext(base, threads.map((t) => t.id), search.toString());
  }, [base, threads, search]);

  const label = labelId ? labels.data?.find((l) => l.id === labelId) : undefined;
  const title = q ? `Search results` : label ? label.name : tab && tab !== 'primary' ? TABS.find((t) => t.id === tab)!.label : TITLES[view ?? 'inbox'];
  const total = list.data?.total ?? 0;
  const pageSize = list.data?.pageSize ?? prefs.pageSize;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);
  const selIds = [...selected];
  const allOnPage = threads.length > 0 && threads.every((t) => selected.has(t.id));

  const open = (t: ThreadSummary) => {
    if (view === 'drafts' || (t.hasDraft && t.count === 0)) {
      api.get<{ messages: { id: number; folder: string }[] }>(`/api/mail/threads/${t.id}?markRead=0`).then((th) => {
        const draft = th.messages.find((m) => m.folder === 'drafts');
        if (draft) void compose.openDraft(draft.id);
      });
      return;
    }
    navigate(`${base}/${t.id}${search.toString() ? `?${search.toString()}` : ''}`);
  };

  const act = async (action: ThreadAction) => {
    if (allMatching) {
      await api.post('/api/mail/threads/bulk', { view, label: labelId, q, category: tab, action });
      refresh();
      toast('Done');
    } else await run(selIds, action);
    setSelected(new Set());
    setAllMatching(false);
  };

  const moveToTab = async (category: Category) => {
    const senders = [...new Set(threads.filter((t) => selected.has(t.id)).flatMap((t) => t.participants.filter((p) => !p.me).map((p) => p.name)))];
    await act({ type: 'category', category });
    const name = TABS.find((x) => x.id === category)!.label;
    toast(senders.length === 1 ? `Moved to ${name}. Future mail from ${senders[0]} goes there too.` : `Moved to ${name}. Future mail from these senders goes there too.`);
  };

  const selectBy = (pred: (t: ThreadSummary) => boolean) => {
    setSelected(new Set(threads.filter(pred).map((t) => t.id)));
    setAllMatching(false);
  };

  useHotkeys((key) => {
    if (!prefs.keyboardShortcuts || !threads.length) return;
    const t = threads[Math.min(cursor, threads.length - 1)];
    const target = selIds.length ? selIds : t ? [t.id] : [];
    switch (key) {
      case 'j':
        setCursor((c) => Math.min(c + 1, threads.length - 1));
        return true;
      case 'k':
        setCursor((c) => Math.max(c - 1, 0));
        return true;
      case 'o':
      case 'Enter':
        if (t) open(t);
        return true;
      case 'x':
        if (t)
          setSelected((s) => {
            const n = new Set(s);
            if (n.has(t.id)) n.delete(t.id);
            else n.add(t.id);
            return n;
          });
        return true;
      case 's':
        if (t) void run([t.id], { type: t.starred ? 'unstar' : 'star' }, { quiet: true });
        return true;
      case 'e':
        void run(target, { type: 'archive' });
        setSelected(new Set());
        return true;
      case '#':
        void run(target, { type: 'trash' });
        setSelected(new Set());
        return true;
      case '!':
        void run(target, { type: 'spam' });
        setSelected(new Set());
        return true;
      case 'I':
        void run(target, { type: 'read' }, { quiet: true });
        return true;
      case 'U':
        void run(target, { type: 'unread' }, { quiet: true });
        return true;
    }
  });

  const labelItems: MenuItem[] = [
    ...(labels.data ?? []).map((l) => ({
      label: (
        <span className="flex items-center gap-2">
          <Tag className="size-3.5" style={{ color: l.color }} />
          {l.name}
        </span>
      ),
      onClick: () => void act({ type: 'label', labelId: l.id }),
    })),
    ...(labels.data?.length ? [{ divider: true }] : []),
    { label: 'Create new label…', onClick: () => setLabelDialog(true) },
  ];

  const inTrash = view === 'trash';
  const inSpam = view === 'spam';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">{title}</h1>
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex items-center">
          <Checkbox
            checked={allOnPage}
            indeterminate={selected.size > 0 && !allOnPage}
            onChange={(v) => (v ? selectBy(() => true) : setSelected(new Set()))}
            label="Select"
          />
          <Menu
            trigger={({ onClick }) => (
              <button aria-label="Selection options" onClick={onClick} className="-ml-1.5 rounded p-0.5 text-muted hover:bg-hover">
                <ChevronDown className="size-3.5" />
              </button>
            )}
            width="w-40"
            items={[
              { label: 'All', onClick: () => selectBy(() => true) },
              { label: 'None', onClick: () => selectBy(() => false) },
              { label: 'Read', onClick: () => selectBy((t) => !t.unread) },
              { label: 'Unread', onClick: () => selectBy((t) => t.unread) },
              { label: 'Starred', onClick: () => selectBy((t) => t.starred) },
              { label: 'Unstarred', onClick: () => selectBy((t) => !t.starred) },
            ]}
          />
        </div>
        {selected.size === 0 ? (
          <>
            <IconButton label="Refresh" onClick={() => (refresh(), counters.refetch())}>
              <RefreshCw className={cx('size-[18px]', list.isFetching && 'animate-spin')} />
            </IconButton>
            <Menu
              trigger={({ onClick }) => (
                <IconButton label="More" onClick={onClick}>
                  <MoreVertical className="size-[18px]" />
                </IconButton>
              )}
              items={[{ label: 'Mark all as read', icon: <MailOpen className="size-4" />, onClick: () => void (async () => {
                await api.post('/api/mail/threads/bulk', { view, label: labelId, q, category: tab, action: { type: 'read' } });
                refresh();
                toast('All conversations marked as read');
              })() }]}
            />
          </>
        ) : (
          <div className="flex items-center">
            {inTrash ? (
              <>
                <IconButton label="Restore" onClick={() => void act({ type: 'untrash' })}>
                  <ArchiveRestore className="size-[18px]" />
                </IconButton>
                <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete forever? This can’t be undone.') && void act({ type: 'delete' })}>
                  Delete forever
                </Button>
              </>
            ) : inSpam ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => void act({ type: 'notspam' })}>
                  Not spam
                </Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete forever? This can’t be undone.') && void act({ type: 'delete' })}>
                  Delete forever
                </Button>
              </>
            ) : (
              <>
                {view === 'inbox' || view === 'snoozed' || !view ? (
                  <IconButton label="Archive (e)" onClick={() => void act({ type: 'archive' })}>
                    <Archive className="size-[18px]" />
                  </IconButton>
                ) : (
                  <IconButton label="Move to Inbox" onClick={() => void act({ type: 'inbox' })}>
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
            {threads.filter((t) => selected.has(t.id)).some((t) => t.unread) ? (
              <IconButton label="Mark as read" onClick={() => void act({ type: 'read' })}>
                <MailOpen className="size-[18px]" />
              </IconButton>
            ) : (
              <IconButton label="Mark as unread" onClick={() => void act({ type: 'unread' })}>
                <Mail className="size-[18px]" />
              </IconButton>
            )}
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
                { label: 'Inbox', icon: <Inbox className="size-4" />, onClick: () => void act({ type: 'inbox' }) },
                { label: 'Archive', icon: <Archive className="size-4" />, onClick: () => void act({ type: 'archive' }) },
                { label: 'Spam', icon: <OctagonAlert className="size-4" />, onClick: () => void act({ type: 'spam' }) },
                { label: 'Trash', icon: <Trash2 className="size-4" />, onClick: () => void act({ type: 'trash' }) },
                ...(prefs.inboxTabs && !inTrash && !inSpam
                  ? [
                      { divider: true },
                      ...TABS.filter((x) => x.id !== tab).map((x) => ({ label: x.label, icon: x.icon, onClick: () => void moveToTab(x.id) })),
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
                { label: 'Mark as important', icon: <Flag className="size-4" />, onClick: () => void act({ type: 'important' }) },
                { label: 'Mark as not important', onClick: () => void act({ type: 'unimportant' }) },
                { label: 'Add star', icon: <Star className="size-4" />, onClick: () => void act({ type: 'star' }) },
                { label: 'Remove star', onClick: () => void act({ type: 'unstar' }) },
                { divider: true },
                threads.filter((t) => selected.has(t.id)).every((t) => t.muted)
                  ? { label: 'Unmute', icon: <BellRing className="size-4" />, onClick: () => void act({ type: 'unmute' }) }
                  : { label: 'Mute', icon: <BellOff className="size-4" />, onClick: () => void act({ type: 'mute' }) },
                ...(selected.size >= 2 && !allMatching
                  ? [
                      {
                        label: 'Merge conversations',
                        icon: <Combine className="size-4" />,
                        onClick: () => window.confirm(`Merge these ${selected.size} conversations into one?`) && void act({ type: 'merge' }),
                      },
                    ]
                  : []),
                ...(label ? [{ divider: true }, { label: `Remove label “${label.name}”`, onClick: () => void act({ type: 'unlabel', labelId: label.id }) }] : []),
              ]}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs text-muted">
          {total > 0 && (
            <span className="px-2 whitespace-nowrap">
              {number(from)}–{number(to)} of {total > 10_000 ? 'many' : number(total)}
            </span>
          )}
          <IconButton label="Newer" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
            <ChevronLeft className="size-[18px]" />
          </IconButton>
          <IconButton label="Older" disabled={to >= total} onClick={() => go({ page: page + 1 })}>
            <ChevronRight className="size-[18px]" />
          </IconButton>
        </div>
      </div>

      {tabbed && <InboxTabs current={tab!} onPick={(id) => go({ tab: id })} />}

      {/* Banners */}
      {allOnPage && total > threads.length && (
        <div className="shrink-0 bg-panel2 px-4 py-2 text-center text-[13px]">
          {allMatching ? (
            <>
              All <b>{number(total)}</b> conversations in {title} are selected.{' '}
              <button className="font-medium text-accent-ink hover:underline" onClick={() => (setAllMatching(false), setSelected(new Set()))}>
                Clear selection
              </button>
            </>
          ) : (
            <>
              All <b>{threads.length}</b> conversations on this page are selected.{' '}
              <button className="font-medium text-accent-ink hover:underline" onClick={() => setAllMatching(true)}>
                Select all {number(total)} conversations in {title}
              </button>
            </>
          )}
        </div>
      )}
      {(inTrash || inSpam) && threads.length > 0 && (
        <div className="flex shrink-0 items-center justify-center gap-3 bg-panel2 px-4 py-2 text-[13px] text-muted">
          {inTrash
            ? `Messages that have been in Trash more than ${instance.retention.trashDays} days will be deleted automatically.`
            : `Messages that have been in Spam more than ${instance.retention.spamDays} days will be deleted automatically.`}
          <button
            className="font-medium text-accent-ink hover:underline"
            onClick={async () => {
              if (!window.confirm(`Permanently delete all ${inTrash ? 'trash' : 'spam'}?`)) return;
              await api.post('/api/mail/threads/bulk', { view, action: { type: 'delete' } });
              refresh();
              toast(inTrash ? 'Trash emptied' : 'Spam deleted');
            }}
          >
            {inTrash ? 'Empty Trash now' : 'Delete all spam messages now'}
          </button>
        </div>
      )}

      {/* List */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {phone && <PullIndicator offset={pull.offset} refreshing={pull.refreshing} />}
      <div
        ref={pull.ref}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
        style={pull.offset ? { transform: `translateY(${pull.offset}px)`, transition: pull.dragging ? 'none' : 'transform 0.2s ease-out' } : undefined}
      >
        {q && (
          <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[13px] text-muted">
            <Search className="size-4 shrink-0" aria-hidden /> <span className="min-w-0 truncate">Results for <span className="font-medium text-fg">{q}</span></span>
            <span className="ml-auto shrink-0">
              <SaveSearchButton query={q} />
            </span>
          </div>
        )}
        {list.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : list.isError ? (
          <Empty title="Couldn’t load conversations">{(list.error as Error).message}</Empty>
        ) : threads.length === 0 ? (
          q ? (
            <Empty icon={<Search className="size-7" />} title="No messages matched your search">
              Try different keywords or use the search options.
            </Empty>
          ) : label ? (
            <Empty icon={<Tag className="size-7" />} title={`There are no conversations with this label.`} />
          ) : tab && tab !== 'primary' ? (
            <Empty icon={TABS.find((x) => x.id === tab)!.icon} title={TABS.find((x) => x.id === tab)!.empty} />
          ) : (
            <Empty icon={EMPTY[view ?? 'inbox'].icon} title={EMPTY[view ?? 'inbox'].title}>
              {EMPTY[view ?? 'inbox'].body}
            </Empty>
          )
        ) : phone ? (
          <div role="list" aria-label={title}>
            {threads.map((t) => (
              <PhoneRow
                key={t.id}
                thread={t}
                labels={labels.data ?? []}
                view={view}
                currentLabel={labelId}
                selected={selected.has(t.id)}
                selecting={selected.size > 0}
                onSelect={(v) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (v) n.add(t.id);
                    else n.delete(t.id);
                    return n;
                  })
                }
                onOpen={() => open(t)}
                onAction={(a) => void run([t.id], a, { quiet: a.type === 'star' || a.type === 'unstar' })}
              />
            ))}
          </div>
        ) : (
          <div role="list" aria-label={title}>
          {threads.map((t, i) => (
            <ThreadRow
              key={t.id}
              thread={t}
              labels={labels.data ?? []}
              view={view}
              currentLabel={labelId}
              selected={selected.has(t.id)}
              cursor={i === cursor}
              compact={prefs.density === 'compact'}
              onSelect={(v) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (v) n.add(t.id);
                  else n.delete(t.id);
                  return n;
                })
              }
              onOpen={() => open(t)}
              onAction={(a) => void run([t.id], a, { quiet: a.type === 'star' || a.type === 'unstar' || a.type === 'important' || a.type === 'unimportant' })}
            />
          ))}
          </div>
        )}
        {!list.isLoading && threads.length > 0 && <div className="h-20" aria-hidden />}
      </div>
      </div>

      <LabelDialog label={labelDialog ? { name: '' } : null} onClose={() => setLabelDialog(false)} onCreated={(l) => void act({ type: 'label', labelId: l.id })} />
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

function ThreadRow({
  thread: t,
  labels,
  view,
  currentLabel,
  selected,
  cursor,
  compact,
  onSelect,
  onOpen,
  onAction,
}: {
  thread: ThreadSummary;
  labels: Label[];
  view?: View;
  currentLabel?: number;
  selected: boolean;
  cursor: boolean;
  compact: boolean;
  onSelect: (v: boolean) => void;
  onOpen: () => void;
  onAction: (a: ThreadAction) => void;
}) {
  const recipientsView = view === 'sent' || view === 'drafts' || view === 'scheduled';
  const people = t.participants;
  const names =
    people.length === 0
      ? recipientsView
        ? '(no recipients)'
        : '(unknown)'
      : people
          .slice(-3)
          .map((p, i, arr) => {
            const n = p.me ? 'me' : arr.length > 1 ? p.name.split(/[\s@]/)[0] : p.name;
            return { n, unread: p.unread };
          });
  const rowLabels = t.labels.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => !!l && l.id !== currentLabel);
  const scheduled = t.status === 'queued' && t.sendAt && t.sendAt > Date.now() + 30_000;

  return (
    <div
      role="listitem"
      tabIndex={-1}
      aria-current={cursor || undefined}
      aria-label={`${t.unread ? 'Unread, ' : ''}${typeof names === 'string' ? names : names.map((p) => p.n).join(', ')}, ${t.subject || 'no subject'}, ${shortDate(t.date)}${t.starred ? ', starred' : ''}`}
      onClick={onOpen}
      className={cx(
        'thread-row group relative flex cursor-pointer items-center gap-1 border-b border-line pr-3 pl-1 text-sm transition-colors',
        compact ? 'h-9' : 'h-11',
        selected ? 'bg-sel' : t.unread ? 'bg-unread-row' : 'bg-read-row',
        'hover:z-[1] hover:shadow-[inset_1px_0_0_var(--line-strong),inset_-1px_0_0_var(--line-strong),0_1px_3px_rgba(0,0,0,.12)]',
      )}
    >
      {cursor && <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-accent" />}
      <Checkbox checked={selected} onChange={onSelect} label="Select conversation" />
      <button
        aria-label={t.starred ? 'Remove star' : 'Add star'}
        aria-pressed={t.starred}
        onClick={(e) => {
          e.stopPropagation();
          onAction({ type: t.starred ? 'unstar' : 'star' });
        }}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-faint hover:bg-hover hover:text-muted"
      >
        <Star className={cx('size-[18px]', t.starred && 'fill-[#f4b400] text-[#f4b400]')} />
      </button>
      <button
        aria-label={t.important ? 'Mark as not important' : 'Mark as important'}
        aria-pressed={t.important}
        onClick={(e) => {
          e.stopPropagation();
          onAction({ type: t.important ? 'unimportant' : 'important' });
        }}
        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-faint hover:text-muted max-sm:hidden"
      >
        <Flag className={cx('size-[15px]', t.important ? 'fill-[#f4b400] text-[#f4b400]' : 'opacity-0 group-hover:opacity-100')} />
      </button>

      <div className={cx('w-52 shrink-0 truncate pr-3 max-md:w-32', t.unread ? 'font-bold' : 'text-fg')}>
        {recipientsView && <span className="font-normal text-muted">To: </span>}
        {typeof names === 'string'
          ? names
          : names.map((p, i) => (
              <span key={i} className={p.unread ? 'font-bold' : 'font-normal'}>
                {i > 0 ? ', ' : ''}
                {p.n}
              </span>
            ))}
        {t.count > 1 && <span className="ml-1 text-xs font-normal text-muted">{t.count}</span>}
        {t.hasDraft && view !== 'drafts' && <span className="ml-1 font-normal text-danger">Draft</span>}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {t.folders.includes('inbox') && view !== 'inbox' && !recipientsView && view !== 'spam' && view !== 'trash' && (
          <span className="shrink-0 rounded bg-panel3 px-1.5 text-[11px] leading-[18px] text-muted">Inbox</span>
        )}
        {t.via && !recipientsView && <ViaChip address={t.via} />}
        {rowLabels.slice(0, 3).map((l) => (
          <span key={l.id} className="max-w-28 shrink-0 truncate rounded px-1.5 text-[11px] leading-[18px] font-medium" style={{ background: `${l.color}22`, color: `color-mix(in srgb, ${l.color} 45%, var(--fg))` }}>
            {l.name}
          </span>
        ))}
        {t.status === 'failed' && <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-1.5 text-[11px] leading-[18px] font-medium text-danger">Failed</span>}
        {scheduled && <span className="shrink-0 rounded bg-accent-soft px-1.5 text-[11px] leading-[18px] font-medium text-accent-ink">Scheduled</span>}
        {t.nudge && <NudgeChip sentAt={t.nudge.sentAt} />}
        {t.muted && <BellOff className="size-3.5 shrink-0 text-muted" aria-label="Muted" />}
        {t.code && <CodeChip code={t.code} />}
        <span className="min-w-0 truncate">
          <span className={t.unread ? 'font-bold' : ''}>{t.subject || '(no subject)'}</span>
          {t.snippet && <span className="text-muted"> – {t.snippet}</span>}
        </span>
      </div>

      {t.hasAttachments && <Paperclip className="ml-2 size-4 shrink-0 text-muted" />}

      <div className={cx('row-date ml-3 w-20 shrink-0 text-right text-xs whitespace-nowrap', t.unread ? 'font-bold text-fg' : 'text-muted')}>
        {view === 'snoozed' && t.snoozedUntil ? (
          <span className="text-warn">{relativeTime(t.snoozedUntil)}</span>
        ) : scheduled ? (
          <span className="text-accent-ink">{shortDate(t.sendAt!)}</span>
        ) : (
          shortDate(t.date)
        )}
      </div>
      <div className="row-actions ml-3 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        {view === 'trash' ? (
          <IconButton size="sm" label="Restore" onClick={() => onAction({ type: 'untrash' })}>
            <ArchiveRestore className="size-4" />
          </IconButton>
        ) : (
          <>
            {view === 'inbox' && (
              <IconButton size="sm" label="Archive" onClick={() => onAction({ type: 'archive' })}>
                <Archive className="size-4" />
              </IconButton>
            )}
            <IconButton size="sm" label="Delete" onClick={() => onAction({ type: 'trash' })}>
              <Trash2 className="size-4" />
            </IconButton>
            <IconButton size="sm" label={t.unread ? 'Mark as read' : 'Mark as unread'} onClick={() => onAction({ type: t.unread ? 'read' : 'unread' })}>
              {t.unread ? <MailOpen className="size-4" /> : <Mail className="size-4" />}
            </IconButton>
            {view === 'inbox' && (
              <IconButton size="sm" label="Snooze until tomorrow" onClick={() => onAction({ type: 'snooze', until: snoozeOptions().find((o) => o.label === 'Tomorrow')!.at })}>
                <Clock className="size-4" />
              </IconButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function InboxTabs({ current, onPick }: { current: Category; onPick: (c: Category) => void }) {
  const counters = useCounters();
  const unread = counters.data?.categories;
  return (
    <div role="tablist" aria-label="Inbox tabs" className="flex shrink-0 overflow-x-auto border-b border-line">
      {TABS.map((t) => {
        const active = t.id === current;
        const n = unread?.[t.id] ?? 0;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(t.id)}
            className={cx(
              'relative flex h-12 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-sm transition-colors sm:w-60 sm:flex-none sm:justify-start sm:gap-3 sm:px-4',
              active ? 'font-medium text-accent-ink' : 'text-muted hover:bg-hover',
            )}
          >
            <span className={cx('max-sm:hidden', active && 'text-accent-ink')}>{t.icon}</span>
            <span className="truncate">{t.label}</span>
            {t.id !== 'primary' && n > 0 && (
              <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-medium text-white" aria-label={`${n} unread`}>
                {n > 99 ? '99+' : n}
                <span className="max-sm:hidden"> new</span>
              </span>
            )}
            {active && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t bg-accent" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pull down at the top of the list to refresh (phones; an installed app on
 * iOS has no browser pull-to-refresh of its own).
 */
function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<unknown>) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const TRIGGER = 64;
  // The latest callback, without re-attaching the touch listeners mid-gesture.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || !node) return;
    let start: { y: number; x: number } | null = null;
    let dist = 0;
    let busy = false;
    const down = (e: TouchEvent) => {
      if (busy || node.scrollTop > 0 || e.touches.length !== 1) return;
      start = { y: e.touches[0].clientY, x: e.touches[0].clientX };
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      const dy = e.touches[0].clientY - start.y;
      const dx = Math.abs(e.touches[0].clientX - start.x);
      // Only a downward pull from the very top; sideways swipes belong to the rows.
      if (dy <= 0 || node.scrollTop > 0 || dx > dy) {
        if (dist) setOffset(0);
        start = dist ? start : null;
        return;
      }
      dist = Math.min(110, dy * 0.5);
      setDragging(true);
      setOffset(dist);
      if (e.cancelable) e.preventDefault();
    };
    const up = async () => {
      if (!start) return;
      start = null;
      setDragging(false);
      if (dist < TRIGGER) {
        setOffset(0);
        return;
      }
      busy = true;
      setRefreshing(true);
      setOffset(48);
      navigator.vibrate?.(8);
      try {
        await refreshRef.current();
      } finally {
        busy = false;
        setRefreshing(false);
        setOffset(0);
      }
    };
    node.addEventListener('touchstart', down, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', up);
    node.addEventListener('touchcancel', up);
    return () => {
      node.removeEventListener('touchstart', down);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', up);
      node.removeEventListener('touchcancel', up);
    };
  }, [enabled, node]);

  return { ref: setNode, offset, dragging, refreshing };
}

function PullIndicator({ offset, refreshing }: { offset: number; refreshing: boolean }) {
  if (!offset && !refreshing) return null;
  const ready = offset >= 64;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center" style={{ transform: `translateY(${Math.max(4, offset - 40)}px)` }} role="status" aria-live="polite">
      <span className="flex size-9 items-center justify-center rounded-full bg-panel shadow-float">
        <RefreshCw className={cx('size-[18px] text-accent-ink', refreshing && 'animate-spin')} style={refreshing ? undefined : { transform: `rotate(${offset * 3}deg)`, opacity: ready ? 1 : 0.6 }} aria-hidden />
        <span className="sr-only">{refreshing ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
      </span>
    </div>
  );
}
