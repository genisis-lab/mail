import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Clock,
  File,
  Flag,
  HelpCircle,
  Inbox,
  LogOut,
  Mails,
  Menu as MenuIcon,
  MoreVertical,
  OctagonAlert,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { Label, View } from '../../shared/types';
import { api } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { useCounters, useLabels, useSession } from '../lib/session';
import { Avatar } from '../components/Avatar';
import { useCompose } from '../components/Compose';
import { LogoMark } from '../components/Logo';
import { useToast } from '../components/toast';
import { Button, Checkbox, cx, Field, IconButton, Input, Kbd, Menu, Modal, Select } from '../components/ui';
import { ThreadList } from './mail/ThreadList';
import { ThreadView } from './mail/ThreadView';
import { SettingsPage } from './settings/SettingsPage';
import { ContactsPage } from './ContactsPage';

const NAV: { view: View; label: string; icon: ReactNode; count?: 'inbox' | 'drafts' | 'spam' | 'scheduled' | 'snoozed' | 'starred'; countStyle?: 'bold' | 'muted' }[] = [
  { view: 'inbox', label: 'Inbox', icon: <Inbox className="size-[18px]" />, count: 'inbox', countStyle: 'bold' },
  { view: 'starred', label: 'Starred', icon: <Star className="size-[18px]" /> },
  { view: 'snoozed', label: 'Snoozed', icon: <Clock className="size-[18px]" />, count: 'snoozed', countStyle: 'muted' },
  { view: 'important', label: 'Important', icon: <Flag className="size-[18px]" /> },
  { view: 'sent', label: 'Sent', icon: <Send className="size-[18px]" /> },
  { view: 'scheduled', label: 'Scheduled', icon: <CalendarClock className="size-[18px]" />, count: 'scheduled', countStyle: 'muted' },
  { view: 'drafts', label: 'Drafts', icon: <File className="size-[18px]" />, count: 'drafts', countStyle: 'muted' },
  { view: 'all', label: 'All Mail', icon: <Mails className="size-[18px]" /> },
  { view: 'spam', label: 'Spam', icon: <OctagonAlert className="size-[18px]" />, count: 'spam', countStyle: 'muted' },
  { view: 'trash', label: 'Trash', icon: <Trash2 className="size-[18px]" /> },
];

export const LABEL_COLORS = ['#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'];

export function MailLayout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('wren.sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const compose = useCompose();
  const navigate = useNavigate();
  const location = useLocation();
  const { prefs } = useSession();
  const gPrefix = useRef(0);

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => localStorage.setItem('wren.sidebar', collapsed ? 'collapsed' : 'open'), [collapsed]);

  useHotkeys((key) => {
    if (!prefs.keyboardShortcuts) return;
    if (Date.now() - gPrefix.current < 1200) {
      gPrefix.current = 0;
      const go: Record<string, string> = { i: '/inbox', s: '/starred', t: '/sent', d: '/drafts', a: '/all', b: '/snoozed', c: '/contacts', '!': '/spam' };
      if (go[key]) {
        navigate(go[key]);
        return true;
      }
    }
    if (key === 'g') {
      gPrefix.current = Date.now();
      return true;
    }
    if (key === 'c') {
      compose.open();
      return true;
    }
    if (key === '/') {
      document.getElementById('wren-search')?.focus();
      return true;
    }
    if (key === '?') {
      setShortcutsOpen(true);
      return true;
    }
  });

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar onMenu={() => (window.innerWidth < 768 ? setMobileOpen((o) => !o) : setCollapsed((c) => !c))} onHelp={() => setShortcutsOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
        <main className="min-w-0 flex-1 pr-4 pb-4 max-md:px-2 max-md:pb-2">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-panel shadow-[0_0_0_1px_var(--line)]">
            <Routes>
              <Route index element={<Navigate to="/inbox" replace />} />
              <Route path="settings/:tab?" element={<SettingsPage />} />
              <Route path="contacts" element={<ContactsPage />} />
              <Route path="label/:labelId" element={<ThreadList />} />
              <Route path="label/:labelId/:threadId" element={<ThreadView />} />
              <Route path="search/:q" element={<ThreadList />} />
              <Route path="search/:q/:threadId" element={<ThreadView />} />
              <Route path=":view" element={<ViewGuard element={<ThreadList />} />} />
              <Route path=":view/:threadId" element={<ViewGuard element={<ThreadView />} />} />
            </Routes>
          </div>
        </main>
      </div>
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function ViewGuard({ element }: { element: ReactNode }) {
  const { view } = useParams();
  if (!NAV.some((n) => n.view === view)) return <Navigate to="/inbox" replace />;
  return <>{element}</>;
}

// ── Top bar ─────────────────────────────────────────────────────────────────

function TopBar({ onMenu, onHelp }: { onMenu: () => void; onHelp: () => void }) {
  const { user, instance, isAdmin } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-3 max-md:h-14">
      <IconButton label="Main menu" onClick={onMenu} size="lg">
        <MenuIcon className="size-5" />
      </IconButton>
      <button onClick={() => navigate('/inbox')} className="mr-4 flex items-center gap-2.5 max-md:mr-1 md:w-[184px]">
        <LogoMark className="size-9" />
        <span className="truncate text-[20px] font-medium tracking-tight text-fg max-sm:hidden">{instance.name}</span>
      </button>
      <SearchBar />
      <div className="ml-auto flex items-center gap-1 pl-2">
        <IconButton label="Keyboard shortcuts" onClick={onHelp} className="max-sm:hidden">
          <HelpCircle className="size-5" />
        </IconButton>
        <IconButton label="Settings" onClick={() => navigate('/settings')}>
          <Settings className="size-5" />
        </IconButton>
        {isAdmin && (
          <IconButton label="Admin panel" onClick={() => navigate('/admin')} className="max-sm:hidden">
            <Shield className="size-5" />
          </IconButton>
        )}
        <Menu
          align="right"
          width="w-80"
          trigger={({ onClick }) => (
            <button onClick={onClick} aria-label="Account" className="ml-1 rounded-full p-1 hover:bg-hover">
              <Avatar name={user.name} address={user.email} size={34} />
            </button>
          )}
        >
          {(close) => (
            <div className="px-2 py-2">
              <div className="flex flex-col items-center px-4 pt-3 pb-4 text-center">
                <Avatar name={user.name} address={user.email} size={64} />
                <p className="mt-3 text-base font-medium">Hi, {user.name.split(' ')[0] || user.email}!</p>
                <p className="text-sm text-muted">{user.email}</p>
                {user.identities.length > 1 && <p className="mt-1 text-xs text-faint">+{user.identities.length - 1} more address(es)</p>}
              </div>
              <div className="flex flex-col gap-0.5">
                <MenuRow icon={<Settings className="size-4" />} onClick={() => (close(), navigate('/settings'))}>
                  Settings
                </MenuRow>
                <MenuRow icon={<Users className="size-4" />} onClick={() => (close(), navigate('/contacts'))}>
                  Contacts
                </MenuRow>
                {isAdmin && (
                  <MenuRow icon={<Shield className="size-4" />} onClick={() => (close(), navigate('/admin'))}>
                    Admin panel
                  </MenuRow>
                )}
                <MenuRow
                  icon={<LogOut className="size-4" />}
                  onClick={async () => {
                    close();
                    await api.post('/api/auth/logout');
                    qc.clear();
                    window.location.href = '/login';
                  }}
                >
                  Sign out
                </MenuRow>
              </div>
            </div>
          )}
        </Menu>
      </div>
    </header>
  );
}

function MenuRow({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-hover">
      <span className="text-muted">{icon}</span>
      {children}
    </button>
  );
}

function SearchBar() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const current = location.pathname.startsWith('/search/') ? decodeURIComponent(location.pathname.split('/')[2] ?? '') : '';
  const [q, setQ] = useState(current);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => setQ(current), [current, params]);

  const go = (query: string) => {
    const t = query.trim();
    if (t) navigate(`/search/${encodeURIComponent(t)}`);
  };

  return (
    <div className="relative max-w-[720px] min-w-0 flex-1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
          (document.activeElement as HTMLElement | null)?.blur();
        }}
        className="flex h-12 items-center rounded-full bg-panel2 transition-colors focus-within:bg-panel focus-within:shadow-panel max-md:h-11"
      >
        <IconButton label="Search" type="submit" className="ml-1">
          <Search className="size-5" />
        </IconButton>
        <input
          id="wren-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLInputElement).blur()}
          placeholder="Search mail"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
        />
        {q && (
          <IconButton
            label="Clear search"
            type="button"
            onClick={() => {
              setQ('');
              if (current) navigate('/inbox');
            }}
          >
            <X className="size-5" />
          </IconButton>
        )}
        <IconButton label="Show search options" type="button" className="mr-1" onClick={() => setAdvanced((a) => !a)}>
          <SlidersHorizontal className="size-5" />
        </IconButton>
      </form>
      {advanced && <AdvancedSearch initial={q} onClose={() => setAdvanced(false)} onSearch={(query) => (setAdvanced(false), setQ(query), go(query))} />}
    </div>
  );
}

function parseQuery(q: string) {
  const get = (key: string) => {
    const m = new RegExp(`(?:^|\\s)${key}:(?:"([^"]*)"|(\\S+))`, 'i').exec(q);
    return m ? (m[1] ?? m[2]) : '';
  };
  const words = q
    .replace(/(?:^|\s)-?[a-z_]+:(?:"[^"]*"|\S+)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { from: get('from'), to: get('to'), subject: get('subject'), in: get('in'), hasAttachment: /has:attachment/i.test(q), words };
}

function AdvancedSearch({ initial, onClose, onSearch }: { initial: string; onClose: () => void; onSearch: (q: string) => void }) {
  const init = parseQuery(initial);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [subject, setSubject] = useState(init.subject);
  const [words, setWords] = useState(init.words);
  const [without, setWithout] = useState('');
  const [hasAttachment, setHasAttachment] = useState(init.hasAttachment);
  const [within, setWithin] = useState('');
  const [folder, setFolder] = useState(init.in || '');
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    setTimeout(() => document.addEventListener('mousedown', fn), 0);
    return () => document.removeEventListener('mousedown', fn);
  }, [onClose]);

  const q = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  const build = () =>
    [
      from && `from:${q(from)}`,
      to && `to:${q(to)}`,
      subject && `subject:${q(subject)}`,
      words,
      ...without
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `-${w}`),
      hasAttachment && 'has:attachment',
      within && `newer_than:${within}`,
      folder && `in:${folder}`,
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div ref={ref} className="animate-pop absolute top-full right-0 left-0 z-40 mt-1 rounded-2xl border border-line bg-panel p-6 shadow-float">
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3 text-sm max-sm:grid-cols-1">
        <span className="text-muted">From</span>
        <Input value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted">To</span>
        <Input value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="text-muted">Subject</span>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        <span className="text-muted">Has the words</span>
        <Input value={words} onChange={(e) => setWords(e.target.value)} />
        <span className="text-muted">Doesn't have</span>
        <Input value={without} onChange={(e) => setWithout(e.target.value)} />
        <span className="text-muted">Date within</span>
        <Select value={within} onChange={(e) => setWithin(e.target.value)}>
          <option value="">Any time</option>
          <option value="1d">1 day</option>
          <option value="7d">1 week</option>
          <option value="1m">1 month</option>
          <option value="6m">6 months</option>
          <option value="1y">1 year</option>
        </Select>
        <span className="text-muted">Search</span>
        <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">All Mail</option>
          <option value="inbox">Inbox</option>
          <option value="sent">Sent</option>
          <option value="drafts">Drafts</option>
          <option value="archive">Archived</option>
          <option value="spam">Spam</option>
          <option value="trash">Trash</option>
          <option value="anywhere">Mail & Spam & Trash</option>
        </Select>
      </div>
      <div className="mt-3 flex items-center gap-1">
        <Checkbox checked={hasAttachment} onChange={setHasAttachment} label="Has attachment" />
        <span className="text-sm">Has attachment</span>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            navigate('/settings/filters', { state: { newFilter: { from, to, subject, hasWords: words, doesNotHave: without, hasAttachment } } });
          }}
        >
          Create filter
        </Button>
        <Button variant="primary" onClick={() => onSearch(build())}>
          Search
        </Button>
      </div>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({ collapsed, mobileOpen, onCloseMobile }: { collapsed: boolean; mobileOpen: boolean; onCloseMobile: () => void }) {
  const compose = useCompose();
  const counters = useCounters();
  const labels = useLabels();
  const [labelDialog, setLabelDialog] = useState<Partial<Label> | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const c = counters.data;
  const wide = !collapsed || mobileOpen;

  const fmtCount = (n: number | undefined) => (n ? (n > 9999 ? '9,999+' : n.toLocaleString()) : '');

  const content = (
    <nav className={cx('flex h-full flex-col overflow-y-auto pb-6', wide ? 'w-64 pr-3' : 'w-[72px] items-center')}>
      <div className={cx('pt-2 pb-4', wide ? 'pl-2' : '')}>
        <button
          onClick={() => compose.open()}
          className={cx(
            'flex h-14 items-center gap-3 rounded-2xl bg-accent-soft text-[15px] font-medium text-fg shadow-sm transition-shadow hover:shadow-panel dark:text-accent',
            wide ? 'pr-6 pl-5' : 'w-14 justify-center',
          )}
          title="Compose"
        >
          <Pencil className="size-5" />
          {wide && 'Compose'}
        </button>
      </div>
      {NAV.map((n) => {
        const count = n.count && c ? c[n.count] : 0;
        return (
          <NavLink
            key={n.view}
            to={`/${n.view}`}
            title={n.label}
            className={({ isActive }) =>
              cx(
                'group flex shrink-0 items-center gap-4 text-sm transition-colors',
                wide ? 'h-8 rounded-r-full pr-3 pl-6' : 'mb-1 size-8 justify-center rounded-full',
                isActive ? 'bg-sel font-semibold text-fg' : 'text-fg hover:bg-hover',
              )
            }
          >
            <span className="relative">
              {n.icon}
              {!wide && count > 0 && n.countStyle === 'bold' && <span className="absolute -top-1 -right-1.5 size-2 rounded-full bg-danger" />}
            </span>
            {wide && <span className="flex-1 truncate">{n.label}</span>}
            {wide && count > 0 && <span className={cx('text-xs', n.countStyle === 'bold' ? 'font-bold' : 'text-muted')}>{fmtCount(count)}</span>}
          </NavLink>
        );
      })}

      <div className={cx('mt-5 flex items-center', wide ? 'justify-between pr-1 pl-6' : 'justify-center')}>
        {wide && <span className="text-[15px] font-medium">Labels</span>}
        <IconButton label="Create new label" size="sm" onClick={() => setLabelDialog({ name: '', color: LABEL_COLORS[6] })}>
          <Plus className="size-4" />
        </IconButton>
      </div>
      {(labels.data ?? []).map((l) => {
        const unread = c?.labels.find((x) => x.id === l.id)?.unread ?? 0;
        return (
          <NavLink
            key={l.id}
            to={`/label/${l.id}`}
            title={l.name}
            className={({ isActive }) =>
              cx(
                'group flex shrink-0 items-center gap-4 text-sm',
                wide ? 'h-8 rounded-r-full pr-1 pl-6' : 'mb-1 size-8 justify-center rounded-full',
                isActive ? 'bg-sel font-semibold' : 'hover:bg-hover',
              )
            }
          >
            <Tag className="size-[18px] shrink-0" style={{ color: l.color, fill: `${l.color}33` }} />
            {wide && <span className={cx('flex-1 truncate', unread > 0 && 'font-semibold')}>{l.name}</span>}
            {wide && unread > 0 && <span className="text-xs font-semibold group-hover:hidden">{unread}</span>}
            {wide && (
              <span className="hidden group-hover:inline-flex" onClick={(e) => e.preventDefault()}>
                <Menu
                  align="right"
                  trigger={({ onClick }) => (
                    <IconButton label="Label options" size="sm" onClick={onClick} className="size-7">
                      <MoreVertical className="size-4" />
                    </IconButton>
                  )}
                  items={[
                    { label: 'Edit', onClick: () => setLabelDialog(l) },
                    {
                      label: 'Remove label',
                      danger: true,
                      onClick: async () => {
                        if (!window.confirm(`Delete the label “${l.name}”? Conversations keep their other labels.`)) return;
                        await api.del(`/api/labels/${l.id}`);
                        qc.invalidateQueries({ queryKey: ['labels'] });
                        toast(`Label “${l.name}” deleted`);
                        navigate('/inbox');
                      },
                    },
                  ]}
                />
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );

  return (
    <>
      <aside className="shrink-0 max-md:hidden">{content}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={onCloseMobile}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="animate-slide-up absolute top-0 bottom-0 left-0 bg-bg pt-3 shadow-float" onClick={(e) => e.stopPropagation()}>
            {content}
          </div>
        </div>
      )}
      <LabelDialog label={labelDialog} onClose={() => setLabelDialog(null)} />
    </>
  );
}

export function LabelDialog({ label, onClose, onCreated }: { label: Partial<Label> | null; onClose: () => void; onCreated?: (l: Label) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[6]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (label) {
      setName(label.name ?? '');
      setColor(label.color ?? LABEL_COLORS[6]);
    }
  }, [label]);
  const save = async () => {
    setBusy(true);
    try {
      if (label?.id) await api.put(`/api/labels/${label.id}`, { name, color });
      else {
        const created = await api.post<Label>('/api/labels', { name, color });
        onCreated?.(created);
      }
      qc.invalidateQueries({ queryKey: ['labels'] });
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!label}
      onClose={onClose}
      title={label?.id ? 'Edit label' : 'New label'}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {label?.id ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <Field label="Label name">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} />
      </Field>
      <div className="mt-4">
        <span className="mb-2 block text-[13px] font-medium">Colour</span>
        <div className="flex flex-wrap gap-2">
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cx('size-7 rounded-full ring-offset-2 ring-offset-panel', color === c && 'ring-2 ring-fg')}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups: [string, [string, string][]][] = [
    [
      'Navigation',
      [
        ['g then i', 'Go to Inbox'],
        ['g then s', 'Go to Starred'],
        ['g then t', 'Go to Sent'],
        ['g then d', 'Go to Drafts'],
        ['g then a', 'Go to All Mail'],
        ['g then c', 'Go to Contacts'],
        ['/', 'Search'],
        ['j / k', 'Older / newer conversation'],
        ['o or Enter', 'Open conversation'],
        ['u', 'Back to list'],
      ],
    ],
    [
      'Actions',
      [
        ['c', 'Compose'],
        ['r', 'Reply'],
        ['a', 'Reply all'],
        ['f', 'Forward'],
        ['e', 'Archive'],
        ['#', 'Delete'],
        ['!', 'Report spam'],
        ['s', 'Star / unstar'],
        ['x', 'Select conversation'],
        ['Shift + i', 'Mark as read'],
        ['Shift + u', 'Mark as unread'],
        ['⌘/Ctrl + Enter', 'Send message'],
        ['?', 'Show shortcuts'],
      ],
    ],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width="max-w-2xl">
      <div className="grid gap-8 pb-3 sm:grid-cols-2">
        {groups.map(([title, items]) => (
          <div key={title}>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{title}</h3>
            <dl className="space-y-1.5">
              {items.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4 text-sm">
                  <dt>{d}</dt>
                  <dd className="flex gap-1">
                    {k.split(' ').map((part, i) =>
                      ['then', 'or', '/', '+'].includes(part) ? (
                        <span key={i} className="text-xs text-faint">
                          {part}
                        </span>
                      ) : (
                        <Kbd key={i}>{part}</Kbd>
                      ),
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Modal>
  );
}
