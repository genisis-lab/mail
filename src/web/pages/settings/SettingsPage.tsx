import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bell, Copy, Download, KeyRound, Laptop, LifeBuoy, Pencil, Plus, ShieldCheck, Tag, Trash2 } from 'lucide-react';
import type { FilterActions, FilterCriteria, Label, SwipeAction, UserPrefs } from '../../../shared/types';
import { api } from '../../lib/api';
import { longDate, relativeTime } from '../../lib/format';
import { useLabels, useSession } from '../../lib/session';
import { RichEditor } from '../../components/RichEditor';
import { TwoFactorSetup } from '../../components/TwoFactorSetup';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Checkbox, cx, Empty, Field, IconButton, Input, Modal, Select, Spinner, Switch, Tabs } from '../../components/ui';
import { LabelDialog } from '../MailLayout';
import { currentPushSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported, useInstallPrompt } from '../../lib/pwa';
import { ImportExportTab } from './ImportExport';
import { SavedRepliesTab } from './SavedReplies';

type Tab = 'general' | 'labels' | 'filters' | 'accounts' | 'replies' | 'import' | 'security';

export function SettingsPage() {
  const { tab = 'general' } = useParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <IconButton label="Back to inbox" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        <h1 className="text-[22px] font-normal">Settings</h1>
      </div>
      <div className="px-4">
        <Tabs<Tab>
          value={tab as Tab}
          onChange={(t) => navigate(`/settings/${t}`)}
          tabs={[
            { value: 'general', label: 'General' },
            { value: 'labels', label: 'Labels' },
            { value: 'filters', label: 'Filters and blocked' },
            { value: 'accounts', label: 'Accounts & forwarding' },
            { value: 'replies', label: 'Saved replies' },
            { value: 'import', label: 'Import & export' },
            { value: 'security', label: 'Security' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 max-sm:px-3">
          {tab === 'general' && <GeneralTab />}
          {tab === 'labels' && <LabelsTab />}
          {tab === 'filters' && <FiltersTab />}
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'replies' && <SavedRepliesTab />}
          {tab === 'import' && <ImportExportTab />}
          {tab === 'security' && <SecurityTab />}
        </div>
      </div>
    </div>
  );
}

function usePrefsForm() {
  const { prefs, refresh } = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<UserPrefs>(prefs);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(prefs), [prefs]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(prefs);
  const save = async (patch?: Partial<UserPrefs>) => {
    setBusy(true);
    try {
      await api.put('/api/account/prefs', patch ?? draft);
      await refresh();
      toast('Settings saved');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return { draft, setDraft, dirty, save, busy, reset: () => setDraft(prefs) };
}

function Row({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="grid gap-3 border-b border-line py-5 sm:grid-cols-[220px_1fr]">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {help && <p className="mt-1 text-xs leading-relaxed text-muted">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="animate-slide-up sticky bottom-0 z-10 mt-6 flex items-center justify-end gap-2 rounded-2xl border border-line bg-panel px-4 py-3 shadow-float">
      <span className="mr-auto text-sm text-muted">You have unsaved changes</span>
      <Button variant="ghost" onClick={onReset}>
        Cancel
      </Button>
      <Button variant="primary" loading={busy} onClick={onSave}>
        Save changes
      </Button>
    </div>
  );
}

function GeneralTab() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const { draft, setDraft, dirty, save, busy, reset } = usePrefsForm();
  const [name, setName] = useState(user.name);
  const sigKey = useRef(0);
  const set = <K extends keyof UserPrefs>(k: K, v: UserPrefs[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const vac = draft.vacation;
  const toDate = (ts: number | null) => (ts ? new Date(ts - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');

  return (
    <div>
      <Row title="Name" help="Shown to people you email.">
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <Button
            disabled={name.trim() === user.name || !name.trim()}
            onClick={async () => {
              await api.put('/api/account/profile', { name });
              await refresh();
              toast('Name updated');
            }}
          >
            Save
          </Button>
        </div>
      </Row>
      <Row title="Theme">
        <div className="flex flex-wrap gap-2">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                set('theme', t);
                void save({ theme: t });
              }}
              className={cx('rounded-xl border px-4 py-2 text-sm capitalize', draft.theme === t ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line-strong hover:bg-hover')}
            >
              {t === 'system' ? 'Match system' : t}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Density">
        <div className="flex gap-2">
          {(['comfortable', 'compact'] as const).map((t) => (
            <button
              key={t}
              onClick={() => set('density', t)}
              className={cx('rounded-xl border px-4 py-2 text-sm capitalize', draft.density === t ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line-strong hover:bg-hover')}
            >
              {t}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Inbox tabs" help="Receipts, alerts and newsletters wait in their own tabs. Mail from people stays in Primary.">
        <Switch checked={draft.inboxTabs} onChange={(v) => set('inboxTabs', v)} label="Split the inbox into Primary, Updates and Promotions" />
      </Row>
      {user.identities.length > 1 && (
        <Row title="Default “From” address">
          <Select value={draft.defaultFrom} onChange={(e) => set('defaultFrom', e.target.value)} aria-label="Default From address">
            <option value="">{user.email} (primary)</option>
            {user.identities.map((i) => (
              <option key={i.address} value={i.address}>
                {i.address}
              </option>
            ))}
          </Select>
        </Row>
      )}
      <Row title="Undo send" help="How long you have to take back a message after pressing Send.">
        <Select value={String(draft.undoSendSeconds)} onChange={(e) => set('undoSendSeconds', Number(e.target.value))} className="w-48" aria-label="Undo send">
          {[0, 5, 10, 20, 30].map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Off' : `${s} seconds`}
            </option>
          ))}
        </Select>
      </Row>
      <Row title="Maximum page size">
        <Select value={String(draft.pageSize)} onChange={(e) => set('pageSize', Number(e.target.value))} className="w-48" aria-label="Maximum page size">
          {[25, 50, 100].map((s) => (
            <option key={s} value={s}>
              {s} conversations
            </option>
          ))}
        </Select>
      </Row>
      <Row title="Images" help="Remote images can reveal when you open a message.">
        <div className="space-y-2">
          {(['ask', 'always'] as const).map((v) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" checked={draft.showImages === v} onChange={() => set('showImages', v)} className="accent-[var(--accent)]" />
              {v === 'ask' ? 'Ask before displaying external images' : 'Always display external images'}
            </label>
          ))}
        </div>
      </Row>
      <Row title="Keyboard shortcuts" help="Press ? anywhere to see them.">
        <Switch checked={draft.keyboardShortcuts} onChange={(v) => set('keyboardShortcuts', v)} label={draft.keyboardShortcuts ? 'On' : 'Off'} />
      </Row>
      <NotificationsRow />
      <InstallRow />
      <Row title="Swipe actions" help="On a phone, swipe a conversation in the list.">
        <div className="grid max-w-md gap-3 sm:grid-cols-2">
          <Field label="Swipe right">
            <Select value={draft.swipeRight} onChange={(e) => set('swipeRight', e.target.value as SwipeAction)}>
              <SwipeOptions />
            </Select>
          </Field>
          <Field label="Swipe left">
            <Select value={draft.swipeLeft} onChange={(e) => set('swipeLeft', e.target.value as SwipeAction)}>
              <SwipeOptions />
            </Select>
          </Field>
        </div>
      </Row>
      <Row title="Signature" help="Appended to new messages. Addresses can have their own (Accounts & forwarding).">
        <div className="rounded-xl border border-line-strong px-3 py-1">
          <RichEditor key={sigKey.current} initialHtml={draft.signature} onChange={(h) => set('signature', h === '<br>' ? '' : h)} placeholder="No signature" className="min-h-0 [&_.wren-editor]:min-h-24" />
        </div>
        <div className="mt-3">
          <Switch checked={draft.signatureOnReplies} onChange={(v) => set('signatureOnReplies', v)} label="Insert signature in replies and forwards" />
        </div>
      </Row>
      <Row title="Vacation responder" help="Sends an automated reply to incoming messages. Each sender gets at most one reply every 4 days.">
        <div className="space-y-4">
          <Switch checked={vac.enabled} onChange={(v) => set('vacation', { ...vac, enabled: v })} label={vac.enabled ? 'Vacation responder on' : 'Vacation responder off'} />
          <fieldset disabled={!vac.enabled} className={cx('space-y-4', !vac.enabled && 'opacity-60')}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First day">
                <Input type="date" value={toDate(vac.startAt)} onChange={(e) => set('vacation', { ...vac, startAt: e.target.value ? new Date(`${e.target.value}T00:00`).getTime() : null })} />
              </Field>
              <Field label="Last day (optional)">
                <Input type="date" value={toDate(vac.endAt)} onChange={(e) => set('vacation', { ...vac, endAt: e.target.value ? new Date(`${e.target.value}T23:59:59`).getTime() : null })} />
              </Field>
            </div>
            <Field label="Subject">
              <Input value={vac.subject} placeholder="Out of office" onChange={(e) => set('vacation', { ...vac, subject: e.target.value })} />
            </Field>
            <Field label="Message">
              <textarea
                value={vac.message}
                onChange={(e) => set('vacation', { ...vac, message: e.target.value })}
                rows={5}
                className="w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm focus:border-accent focus:outline-none"
                placeholder="I’m away until Monday and will reply when I’m back."
              />
            </Field>
            <Checkbox checked={vac.contactsOnly} onChange={(v) => set('vacation', { ...vac, contactsOnly: v })} label="Only send a response to people in my Contacts" />
            <span className="ml-1 text-sm">Only send a response to people in my Contacts</span>
          </fieldset>
        </div>
      </Row>
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onReset={() => ((sigKey.current += 1), reset())} />
    </div>
  );
}

function SwipeOptions() {
  return (
    <>
      <option value="archive">Archive</option>
      <option value="trash">Delete</option>
      <option value="read">Mark as read / unread</option>
      <option value="none">Nothing</option>
    </>
  );
}

/** New-mail notifications: Web Push on this device, or alerts while a tab is open. */
function NotificationsRow() {
  const { prefs, refresh } = useSession();
  const toast = useToast();
  const [push, setPush] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  useEffect(() => {
    void currentPushSubscription().then((s) => setPush(!!s));
  }, []);
  const savePref = async (v: boolean) => {
    await api.put('/api/account/prefs', { notifications: v });
    await refresh();
  };
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  return (
    <Row
      title="Notifications"
      help={supported ? 'Get told about new mail on this device, even when Wren is closed. Notifications show the sender and subject.' : 'This browser can’t show notifications.'}
    >
      {supported ? (
        <div className="space-y-3">
          <Switch
            checked={!!push}
            disabled={busy || push === null}
            onChange={async (v) => {
              setBusy(true);
              try {
                if (v) {
                  await enablePush();
                  await savePref(true);
                  toast('Notifications are on for this device');
                } else {
                  await disablePush();
                  toast('Notifications are off for this device');
                }
                setPush(v);
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error', duration: 8000 });
              } finally {
                setBusy(false);
              }
            }}
            label="Notify me about new mail on this device"
            description={blocked ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then turn this on.' : isIos() && !isStandalone() ? 'On iPhone and iPad, add Wren to your Home Screen first (Share → Add to Home Screen), then turn this on from the app.' : undefined}
          />
          {push && (
            <Button
              size="sm"
              icon={<Bell className="size-4" />}
              onClick={async () => {
                const r = await api.post<{ delivered: number }>('/api/me/push/test');
                toast(r.delivered ? 'Test sent. It shows your newest unread mail.' : 'No device took the test. Try turning notifications off and on again.');
              }}
            >
              Send a test
            </Button>
          )}
          {!push && (
            <Switch
              checked={prefs.notifications}
              onChange={async (v) => {
                if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
                await savePref(v);
              }}
              label="Only while Wren is open in a tab"
              description="Shows a notification when mail arrives and Wren is in the background."
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Try Chrome, Edge, Firefox or Safari 16.4 or later.</p>
      )}
    </Row>
  );
}

function InstallRow() {
  const { available, install } = useInstallPrompt();
  if (isStandalone()) return null;
  return (
    <Row title="App" help="Install Wren to open it like an app, with its own window and icon.">
      {available ? (
        <Button icon={<Download className="size-4" />} onClick={() => void install()}>
          Install Wren on this device
        </Button>
      ) : isIos() ? (
        <p className="text-sm text-muted">
          In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.
        </p>
      ) : (
        <p className="text-sm text-muted">Use your browser’s “Install app” or “Add to Home Screen” menu item.</p>
      )}
    </Row>
  );
}

function LabelsTab() {
  const labels = useLabels();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Partial<Label> | null>(null);
  return (
    <Card
      title="Labels"
      description="Organise conversations. A conversation can have several labels."
      actions={
        <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ name: '' })}>
          New label
        </Button>
      }
    >
      {labels.isLoading ? (
        <Spinner />
      ) : !labels.data?.length ? (
        <Empty icon={<Tag className="size-7" />} title="No labels yet" />
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {labels.data.map((l) => (
            <li key={l.id} className="flex items-center gap-3 py-2.5">
              <Tag className="size-4" style={{ color: l.color, fill: `${l.color}33` }} />
              <span className="flex-1 text-sm">{l.name}</span>
              <IconButton size="sm" label="Edit" onClick={() => setDialog(l)}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton
                size="sm"
                label="Delete"
                onClick={async () => {
                  if (!window.confirm(`Delete label “${l.name}”?`)) return;
                  await api.del(`/api/labels/${l.id}`);
                  qc.invalidateQueries({ queryKey: ['labels'] });
                  toast('Label deleted');
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <LabelDialog label={dialog} onClose={() => setDialog(null)} />
    </Card>
  );
}

interface FilterRow {
  id: number;
  name: string;
  enabled: boolean;
  criteria: FilterCriteria;
  actions: FilterActions;
}

function describeFilter(f: FilterRow, labels: Label[]): { when: string; then: string } {
  const c = f.criteria;
  const when = [
    c.from && `from: ${c.from}`,
    c.to && `to: ${c.to}`,
    c.subject && `subject: ${c.subject}`,
    c.hasWords && `has: ${c.hasWords}`,
    c.doesNotHave && `-${c.doesNotHave}`,
    c.hasAttachment && 'has attachment',
  ]
    .filter(Boolean)
    .join(' · ');
  const a = f.actions;
  const then = [
    a.skipInbox && 'Skip Inbox',
    a.markRead && 'Mark as read',
    a.star && 'Star it',
    a.important && 'Mark as important',
    a.labelId && `Apply label “${labels.find((l) => l.id === a.labelId)?.name ?? '?'}”`,
    a.forwardTo && `Forward to ${a.forwardTo}`,
    a.trash && 'Delete it',
    a.neverSpam && 'Never send to Spam',
    a.alwaysSpam && 'Send to Spam',
  ]
    .filter(Boolean)
    .join(', ');
  return { when, then };
}

function FiltersTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const labels = useLabels();
  const filters = useQuery({ queryKey: ['filters'], queryFn: () => api.get<{ filters: FilterRow[] }>('/api/filters').then((r) => r.filters) });
  const blocked = useQuery({ queryKey: ['blocked'], queryFn: () => api.get<{ blocked: { id: number; pattern: string; createdAt: number }[] }>('/api/blocked').then((r) => r.blocked) });
  const [editing, setEditing] = useState<Partial<FilterRow> | null>(null);
  const [blockInput, setBlockInput] = useState('');

  useEffect(() => {
    const nf = (location.state as any)?.newFilter;
    if (nf) {
      setEditing({ name: '', enabled: true, criteria: nf, actions: {} });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  return (
    <div className="space-y-6">
      <Card
        title="Filters"
        description="Automatically label, archive, star, forward or delete incoming mail."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', enabled: true, criteria: {}, actions: {} })}>
            Create a new filter
          </Button>
        }
      >
        {filters.isLoading ? (
          <Spinner />
        ) : !filters.data?.length ? (
          <p className="text-sm text-muted">No filters yet. Tip: use the search options in the top bar, then choose “Create filter”.</p>
        ) : (
          <ul className="-my-2 divide-y divide-line">
            {filters.data.map((f) => {
              const d = describeFilter(f, labels.data ?? []);
              return (
                <li key={f.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="text-muted">Matches:</span> {d.when}
                    </p>
                    <p className="truncate text-sm">
                      <span className="text-muted">Do this:</span> {d.then || '—'}
                    </p>
                  </div>
                  {!f.enabled && <Badge>Paused</Badge>}
                  <IconButton size="sm" label="Edit" onClick={() => setEditing(f)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label="Delete"
                    onClick={async () => {
                      await api.del(`/api/filters/${f.id}`);
                      qc.invalidateQueries({ queryKey: ['filters'] });
                      toast('Filter deleted');
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Blocked addresses" description="Messages from these addresses or domains go straight to Spam.">
        <form
          className="mb-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!blockInput.trim()) return;
            await api.post('/api/blocked', { pattern: blockInput });
            setBlockInput('');
            qc.invalidateQueries({ queryKey: ['blocked'] });
          }}
        >
          <Input value={blockInput} onChange={(e) => setBlockInput(e.target.value)} placeholder="spammer@example.com or @example.com" />
          <Button type="submit">Block</Button>
        </form>
        {!blocked.data?.length ? (
          <p className="text-sm text-muted">You haven’t blocked anyone.</p>
        ) : (
          <ul className="-my-2 divide-y divide-line">
            {blocked.data.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2">
                <span className="flex-1 text-sm">{b.pattern}</span>
                <span className="text-xs text-faint">{relativeTime(b.createdAt)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`/api/blocked/${b.id}`);
                    qc.invalidateQueries({ queryKey: ['blocked'] });
                  }}
                >
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <FilterDialog filter={editing} labels={labels.data ?? []} onClose={() => setEditing(null)} />
    </div>
  );
}

function FilterDialog({ filter, labels, onClose }: { filter: Partial<FilterRow> | null; labels: Label[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [c, setC] = useState<FilterCriteria>({});
  const [a, setA] = useState<FilterActions>({});
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (filter) {
      setC(filter.criteria ?? {});
      setA(filter.actions ?? {});
      setEnabled(filter.enabled ?? true);
    }
  }, [filter]);
  const toggle = (k: keyof FilterActions) => (v: boolean) => setA((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: '', enabled, criteria: c, actions: a };
      if (filter?.id) await api.put(`/api/filters/${filter.id}`, body);
      else await api.post('/api/filters', body);
      qc.invalidateQueries({ queryKey: ['filters'] });
      toast(filter?.id ? 'Filter updated' : 'Filter created');
      onClose();
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const check = (label: string, k: keyof FilterActions) => (
    <label className="flex items-center gap-1 text-sm">
      <Checkbox checked={!!a[k]} onChange={toggle(k)} label={label} />
      {label}
    </label>
  );
  return (
    <Modal
      open={!!filter}
      onClose={onClose}
      title={filter?.id ? 'Edit filter' : 'Create filter'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {filter?.id ? 'Update filter' : 'Create filter'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">When a message arrives that matches</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From">
          <Input value={c.from ?? ''} onChange={(e) => setC({ ...c, from: e.target.value })} placeholder="boss@company.com" />
        </Field>
        <Field label="To">
          <Input value={c.to ?? ''} onChange={(e) => setC({ ...c, to: e.target.value })} placeholder="team@" />
        </Field>
        <Field label="Subject">
          <Input value={c.subject ?? ''} onChange={(e) => setC({ ...c, subject: e.target.value })} />
        </Field>
        <Field label="Has the words" help="Separate alternatives with OR.">
          <Input value={c.hasWords ?? ''} onChange={(e) => setC({ ...c, hasWords: e.target.value })} />
        </Field>
        <Field label="Doesn’t have">
          <Input value={c.doesNotHave ?? ''} onChange={(e) => setC({ ...c, doesNotHave: e.target.value })} />
        </Field>
        <label className="flex items-center gap-1 self-end pb-2 text-sm">
          <Checkbox checked={!!c.hasAttachment} onChange={(v) => setC({ ...c, hasAttachment: v })} label="Has attachment" />
          Has attachment
        </label>
      </div>
      <p className="mt-6 mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Do this</p>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {check('Skip the Inbox (Archive it)', 'skipInbox')}
        {check('Mark as read', 'markRead')}
        {check('Star it', 'star')}
        {check('Always mark it as important', 'important')}
        {check('Delete it', 'trash')}
        {check('Never send it to Spam', 'neverSpam')}
        {check('Always send it to Spam', 'alwaysSpam')}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Apply the label">
          <Select value={a.labelId ? String(a.labelId) : ''} onChange={(e) => setA({ ...a, labelId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Choose label…</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Forward it to">
          <Input value={a.forwardTo ?? ''} onChange={(e) => setA({ ...a, forwardTo: e.target.value })} placeholder="someone@example.com" />
        </Field>
      </div>
      <div className="mt-4">
        <Switch checked={enabled} onChange={setEnabled} label="Filter enabled" />
      </div>
    </Modal>
  );
}

interface AliasEntry {
  id: number;
  address: string;
  name: string;
  kind: 'mailbox' | 'alias';
  own: boolean;
  enabled: boolean;
  throwaway: boolean;
  description: string;
  received: number;
  lastReceivedAt: number | null;
}

interface AliasInfo {
  policy: { enabled: boolean; limit: number; used: number; domain: string; throwaway: { enabled: boolean; limit: number; used: number } };
  aliases: AliasEntry[];
}

function AccountsTab() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const { draft, setDraft, dirty, save, busy, reset } = usePrefsForm();
  const [newAlias, setNewAlias] = useState('');
  const [aliasBusy, setAliasBusy] = useState(false);
  const [throwawayOpen, setThrowawayOpen] = useState(false);
  const navigate = useNavigate();
  const [sigFor, setSigFor] = useState<string | null>(null);
  const aliases = useQuery({ queryKey: ['me', 'aliases'], queryFn: () => api.get<AliasInfo>('/api/me/aliases') });
  const fwd = draft.forwarding;
  const policy = aliases.data?.policy;
  const list = aliases.data?.aliases ?? [];
  const byAddress = new Map(list.map((a) => [a.address.toLowerCase(), a]));
  // Sendable addresses (incl. groups), plus aliases that are turned off (not sendable, but still yours).
  const rows = [
    ...user.identities.map((i) => ({ address: i.address, name: i.name, kind: i.kind as string, entry: byAddress.get(i.address.toLowerCase()) })),
    ...list.filter((a) => !a.throwaway && !user.identities.some((i) => i.address.toLowerCase() === a.address.toLowerCase())).map((a) => ({ address: a.address, name: a.name, kind: a.kind as string, entry: a })),
  ].filter((r) => !r.entry?.throwaway);
  const throwaways = list.filter((a) => a.throwaway);
  const changed = async (message: string) => {
    qc.invalidateQueries({ queryKey: ['me', 'aliases'] });
    await refresh();
    toast(message);
  };
  const toggle = async (a: AliasEntry, enabled: boolean) => {
    try {
      await api.put(`/api/me/aliases/${a.id}`, { enabled });
      await changed(enabled ? `${a.address} is on again` : `${a.address} is off. Mail sent to it will bounce.`);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const remove = async (a: AliasEntry) => {
    if (!window.confirm(`Remove ${a.address}? Mail sent to it will bounce.`)) return;
    try {
      await api.del(`/api/me/aliases/${a.id}`);
      await changed(`${a.address} removed`);
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    }
  };
  const received = (a?: AliasEntry) => (a && a.kind === 'alias' ? (a.received ? `${a.received.toLocaleString()} received · last ${relativeTime(a.lastReceivedAt!)}` : 'nothing received yet') : '');
  return (
    <div className="space-y-6">
      <Card
        title="Your addresses"
        description={policy?.enabled ? `Addresses you receive mail at and can send from. You can add up to ${policy.limit} of your own aliases.` : 'Addresses you receive mail at and can send from. Administrators manage aliases and groups.'}
      >
        <ul className="-my-2 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.address} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <span className={cx('min-w-0 flex-1 text-sm', r.entry && !r.entry.enabled && 'text-muted')}>
                <span className="font-medium">{r.name || user.name}</span> <span className="break-all text-muted">&lt;{r.address}&gt;</span>
                {draft.signatures?.[r.address] && <span className="ml-2 text-xs text-faint">own signature</span>}
                {r.entry?.kind === 'alias' && <span className="block text-xs text-muted">{r.entry.enabled ? received(r.entry) : 'Off: mail sent here bounces'}</span>}
              </span>
              <Badge tone={r.kind === 'mailbox' ? 'accent' : 'neutral'}>{r.kind === 'mailbox' ? 'primary' : r.kind}</Badge>
              {r.entry?.kind === 'alias' && r.entry.received > 0 && (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/search/${encodeURIComponent(`deliveredto:${r.address}`)}`)}>
                  View mail
                </Button>
              )}
              {(!r.entry || r.entry.enabled) && (
                <Button size="sm" variant="ghost" onClick={() => setSigFor(r.address)}>
                  Signature
                </Button>
              )}
              {r.entry?.kind === 'alias' && <Switch checked={r.entry.enabled} onChange={(v) => void toggle(r.entry!, v)} ariaLabel={`Receive mail at ${r.address}`} />}
              {r.entry?.own && (
                <IconButton size="sm" label={`Remove ${r.address}`} onClick={() => void remove(r.entry!)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        {policy?.enabled && (
          <form
            className="mt-4 flex flex-wrap items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setAliasBusy(true);
              try {
                const r = await api.post<{ alias: { address: string } }>('/api/me/aliases', { localPart: newAlias });
                setNewAlias('');
                await changed(`${r.alias.address} is ready. Mail to it arrives in your inbox.`);
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setAliasBusy(false);
              }
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Input value={newAlias} onChange={(e) => setNewAlias(e.target.value.toLowerCase())} placeholder="newsletters" aria-label="New alias, before the @" className="min-w-0" disabled={policy.used >= policy.limit} />
              <span className="shrink-0 text-sm text-muted">@{policy.domain}</span>
            </div>
            <Button type="submit" icon={<Plus className="size-4" />} loading={aliasBusy} disabled={!newAlias.trim() || policy.used >= policy.limit}>
              Add alias
            </Button>
            <span className="w-full text-xs text-muted">
              {policy.used} of {policy.limit} used
            </span>
          </form>
        )}
        <p className="mt-4 text-xs text-muted">
          Tip: plus-addressing works out of the box — mail to <code className="rounded bg-panel2 px-1">{user.email.replace('@', '+anything@')}</code> lands in your inbox.
        </p>
      </Card>
      {policy?.throwaway.enabled && (
        <Card
          title="Sign-up addresses"
          description="A separate throwaway address for each site you sign up to. If one starts getting spam, you know who leaked it: turn it off and mail sent there bounces."
          actions={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setThrowawayOpen(true)} disabled={policy.throwaway.used >= policy.throwaway.limit}>
              New address
            </Button>
          }
        >
          {throwaways.length === 0 ? (
            <p className="text-sm text-muted">None yet. Make one the next time a site asks for your email.</p>
          ) : (
            <ul className="-my-2 divide-y divide-line">
              {throwaways.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <span className={cx('min-w-0 flex-1 text-sm', !a.enabled && 'text-muted')}>
                    <span className="font-medium break-all">{a.address}</span>
                    <span className="block text-xs text-muted">
                      {[a.description, a.enabled ? received(a) : 'Off: mail sent here bounces'].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <CopyButton value={a.address} />
                  {a.received > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/search/${encodeURIComponent(`deliveredto:${a.address}`)}`)}>
                      View mail
                    </Button>
                  )}
                  <Switch checked={a.enabled} onChange={(v) => void toggle(a, v)} ariaLabel={`Receive mail at ${a.address}`} />
                  <IconButton size="sm" label={`Remove ${a.address}`} onClick={() => void remove(a)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            {policy.throwaway.used} of {policy.throwaway.limit} used
          </p>
        </Card>
      )}
      <ThrowawayDialog
        open={throwawayOpen}
        onClose={() => setThrowawayOpen(false)}
        onCreated={(address) => {
          setThrowawayOpen(false);
          void changed(`${address} is ready and copied`);
        }}
      />
      <Card title="Forwarding" description="Automatically forward a copy of incoming mail to another address.">
        <div className="space-y-4">
          <Switch checked={fwd.enabled} onChange={(v) => setDraft({ ...draft, forwarding: { ...fwd, enabled: v } })} label="Forward incoming mail" />
          <fieldset disabled={!fwd.enabled} className={cx('grid gap-3 sm:grid-cols-2', !fwd.enabled && 'opacity-60')}>
            <Field label="Forward to">
              <Input type="email" value={fwd.to} onChange={(e) => setDraft({ ...draft, forwarding: { ...fwd, to: e.target.value } })} placeholder="me@elsewhere.com" />
            </Field>
            <Field label="Then">
              <Select value={fwd.keep} onChange={(e) => setDraft({ ...draft, forwarding: { ...fwd, keep: e.target.value as typeof fwd.keep } })}>
                <option value="inbox">Keep the copy in the Inbox</option>
                <option value="read">Mark the copy as read</option>
                <option value="archive">Archive the copy</option>
                <option value="trash">Delete the copy</option>
              </Select>
            </Field>
          </fieldset>
        </div>
      </Card>
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save({ forwarding: draft.forwarding, signatures: draft.signatures })} onReset={reset} />
      <SignatureDialog
        address={sigFor}
        value={sigFor ? draft.signatures?.[sigFor] ?? '' : ''}
        fallback={draft.signature}
        onClose={() => setSigFor(null)}
        onSave={async (html) => {
          const next = { ...(draft.signatures ?? {}) };
          if (html.trim()) next[sigFor!] = html;
          else delete next[sigFor!];
          setSigFor(null);
          setDraft({ ...draft, signatures: next });
          await save({ signatures: next });
        }}
      />
    </div>
  );
}

function SignatureDialog({ address, value, fallback, onClose, onSave }: { address: string | null; value: string; fallback: string; onClose: () => void; onSave: (html: string) => Promise<void> }) {
  const [html, setHtml] = useState(value);
  const [key, setKey] = useState<string | null>(null);
  if (address !== key) {
    setKey(address);
    setHtml(value);
  }
  return (
    <Modal
      open={!!address}
      onClose={onClose}
      title={`Signature for ${address ?? ''}`}
      width="max-w-xl"
      footer={
        <>
          {value && (
            <Button variant="ghost" className="mr-auto" onClick={() => void onSave('')}>
              Use the default
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSave(html === '<br>' ? '' : html)}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{fallback ? 'Leave it empty to use your default signature with this address.' : 'Used when you write from this address.'}</p>
      <div className="rounded-xl border border-line-strong px-3 py-1">
        <RichEditor key={key ?? ''} initialHtml={value} onChange={setHtml} placeholder={fallback ? 'Default signature' : 'No signature'} className="min-h-0 [&_.wren-editor]:min-h-24" />
      </div>
    </Modal>
  );
}

function SecurityTab() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [setup2fa, setSetup2fa] = useState(false);
  const [disable2fa, setDisable2fa] = useState(false);
  const [disablePw, setDisablePw] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: any[] }>('/api/account/sessions').then((r) => r.sessions) });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<{ keys: any[] }>('/api/account/api-keys').then((r) => r.keys) });

  return (
    <div className="space-y-6">
      <Card title="Password">
        <form
          className="grid max-w-md gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.next !== pw.confirm) return toast({ message: 'Passwords don’t match', tone: 'error' });
            setPwBusy(true);
            try {
              await api.post('/api/account/password', { current: pw.current, next: pw.next });
              setPw({ current: '', next: '', confirm: '' });
              toast('Password changed. Other sessions were signed out.');
              qc.invalidateQueries({ queryKey: ['sessions'] });
            } catch (err) {
              toast({ message: (err as Error).message, tone: 'error' });
            } finally {
              setPwBusy(false);
            }
          }}
        >
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          </Field>
          <Field label="New password">
            <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={pwBusy}>
              Change password
            </Button>
          </div>
        </form>
      </Card>

      <RecoveryCard />

      <Card
        title="2-step verification"
        description="Require a code from an authenticator app when signing in."
        actions={
          user.totpEnabled ? (
            <Button variant="ghost" onClick={() => setDisable2fa(true)}>
              Turn off
            </Button>
          ) : (
            <Button variant="primary" icon={<ShieldCheck className="size-4" />} onClick={() => setSetup2fa(true)}>
              Turn on
            </Button>
          )
        }
      >
        <p className="flex items-center gap-2 text-sm">
          {user.totpEnabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
          <span className="text-muted">{user.totpEnabled ? 'Your account is protected with an authenticator app.' : 'Add an extra layer of security to your account.'}</span>
        </p>
      </Card>

      <Card
        title="Where you’re signed in"
        actions={
          <Button
            variant="ghost"
            onClick={async () => {
              const r = await api.post<{ revoked: number }>('/api/account/sessions/revoke-others');
              qc.invalidateQueries({ queryKey: ['sessions'] });
              toast(`Signed out of ${r.revoked} other session(s)`);
            }}
          >
            Sign out everywhere else
          </Button>
        }
      >
        <ul className="-my-2 divide-y divide-line">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <Laptop className="size-5 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{browserName(s.userAgent)}</p>
                <p className="text-xs text-muted">
                  {s.ip || 'unknown IP'} · last active {relativeTime(s.lastSeenAt)} · signed in {longDate(s.createdAt)}
                </p>
              </div>
              {s.current ? (
                <Badge tone="accent">This device</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`/api/account/sessions/${s.id}`);
                    qc.invalidateQueries({ queryKey: ['sessions'] });
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="API keys"
        description="Use a key to send mail from scripts and apps over the HTTP API."
      >
        <form
          className="mb-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!keyName.trim()) return;
            const r = await api.post<{ key: string }>('/api/account/api-keys', { name: keyName });
            setNewKey(r.key);
            setKeyName('');
            qc.invalidateQueries({ queryKey: ['api-keys'] });
          }}
        >
          <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Key name, e.g. “Thunderbird” or “Website contact form”" />
          <Button type="submit" icon={<KeyRound className="size-4" />}>
            Create
          </Button>
        </form>
        {newKey && (
          <div className="mb-4 rounded-xl border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] p-4">
            <p className="mb-2 text-sm font-medium">Copy your new key now — you won’t see it again.</p>
            <div className="flex gap-2">
              <code className="flex-1 rounded-lg bg-panel px-3 py-2 font-mono text-[13px] break-all">{newKey}</code>
              <IconButton
                label="Copy"
                onClick={() => {
                  void navigator.clipboard.writeText(newKey);
                  toast('Copied');
                }}
              >
                <Copy className="size-4" />
              </IconButton>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-panel p-3 text-xs text-muted">{`curl -X POST ${location.origin}/api/v1/send \\
  -H "Authorization: Bearer ${newKey.slice(0, 12)}…" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"friend@example.com","subject":"Hi","text":"Hello!"}'`}</pre>
          </div>
        )}
        {!keys.data?.length ? (
          <p className="text-sm text-muted">No keys yet.</p>
        ) : (
          <ul className="-my-2 divide-y divide-line">
            {keys.data.map((k) => (
              <li key={k.id} className="flex items-center gap-3 py-2.5">
                <KeyRound className="size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-muted">
                    {k.prefix}… · created {relativeTime(k.createdAt)} · {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!window.confirm(`Revoke “${k.name}”? Apps using it will stop working.`)) return;
                    await api.del(`/api/account/api-keys/${k.id}`);
                    qc.invalidateQueries({ queryKey: ['api-keys'] });
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={setup2fa} onClose={() => setSetup2fa(false)} title="Turn on 2-step verification" width="max-w-xl">
        <div className="pb-4">
          <TwoFactorSetup
            onDone={async () => {
              setSetup2fa(false);
              await refresh();
            }}
          />
        </div>
      </Modal>
      <Modal
        open={disable2fa}
        onClose={() => setDisable2fa(false)}
        title="Turn off 2-step verification?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisable2fa(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api.post('/api/account/2fa/disable', { password: disablePw });
                  setDisable2fa(false);
                  setDisablePw('');
                  await refresh();
                  toast('2-step verification turned off');
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                }
              }}
            >
              Turn off
            </Button>
          </>
        }
      >
        <Field label="Confirm your password">
          <Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

/** A personal address outside this mailbox, for "Forgot password?". */
function RecoveryCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['account', 'recovery'], queryFn: () => api.get<{ email: string | null; verified: boolean }>('/api/account/recovery') });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const r = q.data;
  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: ['account', 'recovery'] });
    setEditing(false);
    setRemoving(false);
    setPassword('');
    toast(msg);
  };
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-muted" aria-hidden /> Recovery email
        </span>
      }
      description="If you forget your password, a reset link goes here. Use an address outside this mailbox."
      actions={
        r?.email ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => (setEmail(r.email ?? ''), setEditing(true))}>
              Change
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" onClick={() => (setEmail(''), setEditing(true))}>
            Add
          </Button>
        )
      }
    >
      {!r ? (
        <Spinner />
      ) : r.email ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="break-all">{r.email}</span>
          {r.verified ? (
            <Badge tone="ok">confirmed</Badge>
          ) : (
            <>
              <Badge tone="warn">waiting for confirmation</Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.post('/api/account/recovery/resend');
                    toast(`Confirmation sent to ${r.email}`);
                  } catch (err) {
                    toast({ message: (err as Error).message, tone: 'error' });
                  }
                }}
              >
                Send again
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Not set. Without one, only an administrator can help you back in if you forget your password.</p>
      )}
      <Modal
        open={editing || removing}
        onClose={() => (setEditing(false), setRemoving(false))}
        title={removing ? 'Remove recovery email?' : r?.email ? 'Change recovery email' : 'Add a recovery email'}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => (setEditing(false), setRemoving(false))}>
              Cancel
            </Button>
            <Button
              variant={removing ? 'danger' : 'primary'}
              loading={busy}
              disabled={!password || (!removing && !email.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  if (removing) {
                    await api.del('/api/account/recovery', { password });
                    done('Recovery email removed');
                  } else {
                    await api.put('/api/account/recovery', { email: email.trim(), password });
                    done(`Check ${email.trim()} for a confirmation link`);
                  }
                } catch (err) {
                  toast({ message: (err as Error).message, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {removing ? 'Remove' : 'Send confirmation'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!removing && (
            <Field label="Recovery email" help="We send a link there to confirm it’s yours.">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" autoFocus />
            </Field>
          )}
          <Field label="Your password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={removing} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

export function browserName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function CopyButton({ value }: { value: string }) {
  const toast = useToast();
  return (
    <IconButton
      size="sm"
      label={`Copy ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast('Copied');
        } catch {
          toast({ message: 'Couldn’t copy; select the address instead', tone: 'error' });
        }
      }}
    >
      <Copy className="size-4" />
    </IconButton>
  );
}

function ThrowawayDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (address: string) => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setLabel('');
      setNote('');
    }
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New sign-up address"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="throwaway-form" loading={busy}>
            Create and copy
          </Button>
        </>
      }
    >
      <form
        id="throwaway-form"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.post<{ alias: { address: string } }>('/api/me/aliases/throwaway', { label, description: note });
            await navigator.clipboard?.writeText(r.alias.address).catch(() => {});
            onCreated(r.alias.address);
          } catch (err) {
            toast({ message: (err as Error).message, tone: 'error' });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Where is it for?" help="Becomes the start of the address, followed by four random characters.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="shoe-shop" autoFocus maxLength={40} />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Signed up for the newsletter" maxLength={200} />
        </Field>
      </form>
    </Modal>
  );
}
