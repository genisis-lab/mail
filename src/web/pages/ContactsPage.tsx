import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Mail, MoreVertical, Pencil, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import { api } from '../lib/api';
import { contactsFromFile } from '../lib/contacts-import';
import { relativeTime } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { useCompose } from '../components/Compose';
import { useToast } from '../components/toast';
import { Button, Empty, Field, IconButton, Input, Menu, Modal, Spinner, Tabs, Textarea } from '../components/ui';
import { RecipientInput } from '../components/RecipientInput';
import type { Addr } from '../../shared/types';

interface Group {
  id: number;
  name: string;
  members: { address: string; name: string }[];
}

interface Contact {
  id: number;
  email: string;
  name: string;
  phone: string;
  company: string;
  notes: string;
  saved: boolean;
  timesContacted: number;
  lastContactedAt: number | null;
}

export function ContactsPage() {
  const navigate = useNavigate();
  const compose = useCompose();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'saved' | 'frequent' | 'groups'>('saved');
  const [editingGroup, setEditingGroup] = useState<Partial<Group> | null>(null);
  const groups = useQuery({ queryKey: ['contact-groups'], queryFn: () => api.get<{ groups: Group[] }>('/api/contacts/groups').then((r) => r.groups) });
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const contacts = useQuery({ queryKey: ['contacts'], queryFn: () => api.get<{ contacts: Contact[] }>('/api/contacts').then((r) => r.contacts) });

  const list = useMemo(() => {
    const all = contacts.data ?? [];
    const f = filter.toLowerCase();
    const base = tab === 'saved' ? all.filter((c) => c.saved) : [...all].filter((c) => c.timesContacted > 0).sort((a, b) => b.timesContacted - a.timesContacted);
    return f ? base.filter((c) => c.email.includes(f) || c.name.toLowerCase().includes(f) || c.company.toLowerCase().includes(f)) : base;
  }, [contacts.data, tab, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <IconButton label="Back to inbox" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-[18px]" />
        </IconButton>
        <h1 className="text-[22px] font-normal">Contacts</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative max-sm:hidden">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input className="w-64 pl-9" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search contacts" />
          </div>
          {tab === 'groups' ? (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditingGroup({ name: '', members: [] })}>
              <span className="max-sm:sr-only">Create group</span>
            </Button>
          ) : (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ email: '', name: '', phone: '', company: '', notes: '' })}>
              <span className="max-sm:sr-only">Create contact</span>
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.vcf,.vcard,text/csv,text/vcard"
            className="sr-only"
            aria-label="Import contacts file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setImporting(true);
              try {
                const list = contactsFromFile(f.name, await f.text());
                if (!list.length) {
                  toast({ message: 'No contacts with an email address found. Use a CSV (Google, Outlook) or vCard (.vcf) file.', tone: 'error', duration: 8000 });
                  return;
                }
                const sum = { added: 0, updated: 0, skipped: 0 };
                for (let i = 0; i < list.length; i += 1000) {
                  const r = await api.post<typeof sum>('/api/contacts/import', { contacts: list.slice(i, i + 1000) });
                  sum.added += r.added;
                  sum.updated += r.updated;
                  sum.skipped += r.skipped;
                }
                qc.invalidateQueries({ queryKey: ['contacts'] });
                toast(`${sum.added} added, ${sum.updated} updated${sum.skipped ? `, ${sum.skipped} skipped` : ''}`);
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setImporting(false);
              }
            }}
          />
          <Menu
            align="right"
            width="w-64"
            trigger={({ onClick }) => (
              <IconButton label="Import or export contacts" onClick={onClick} disabled={importing}>
                {importing ? <Spinner className="size-4" /> : <MoreVertical className="size-[18px]" />}
              </IconButton>
            )}
            items={[
              { label: 'Import from CSV or vCard…', icon: <Upload className="size-4" />, onClick: () => fileInput.current?.click() },
              { divider: true },
              { label: 'Export as vCard (.vcf)', icon: <Download className="size-4" />, onClick: () => (window.location.href = '/api/contacts/export?format=vcf') },
              { label: 'Export as CSV', icon: <Download className="size-4" />, onClick: () => (window.location.href = '/api/contacts/export?format=csv') },
            ]}
          />
        </div>
      </div>
      <div className="px-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'saved', label: 'Contacts' },
            { value: 'frequent', label: 'Frequently contacted' },
            { value: 'groups', label: 'Groups' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'groups' ? (
          groups.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : !groups.data?.length ? (
            <Empty icon={<Users className="size-7" />} title="No groups yet">
              Make a group like “Design team” or “Family”, then type its name in To, Cc or Bcc to add everyone in it.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {groups.data.map((g) => (
                <li key={g.id} className="group flex items-center gap-3 px-6 py-3 hover:bg-hover max-sm:px-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                    <Users className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{g.name}</p>
                    <p className="truncate text-xs text-muted">
                      {g.members.length === 1 ? '1 person' : `${g.members.length} people`} · {g.members.map((m) => m.name || m.address).join(', ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <IconButton size="sm" label={`Email ${g.name}`} onClick={() => compose.open({ to: g.members.map((m) => ({ address: m.address, name: m.name })) })}>
                      <Mail className="size-4" />
                    </IconButton>
                    <IconButton size="sm" label={`Edit ${g.name}`} onClick={() => setEditingGroup(g)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Delete ${g.name}`}
                      onClick={async () => {
                        if (!window.confirm(`Delete the group “${g.name}”? The contacts in it stay.`)) return;
                        await api.del(`/api/contacts/groups/${g.id}`);
                        qc.invalidateQueries({ queryKey: ['contact-groups'] });
                        toast('Group deleted');
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : contacts.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !list.length ? (
          <Empty icon={<Users className="size-7" />} title={tab === 'saved' ? 'No contacts yet' : 'No one contacted yet'}>
            {tab === 'saved' ? 'People you add here are trusted by the spam filter and can be used for vacation replies.' : 'People you email appear here automatically.'}
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2.5 pl-6 font-medium">Name</th>
                <th className="py-2.5 font-medium">Email</th>
                <th className="py-2.5 font-medium max-md:hidden">{tab === 'saved' ? 'Company' : 'Emails'}</th>
                <th className="py-2.5 font-medium max-md:hidden">Last contacted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="group border-b border-line hover:bg-hover">
                  <td className="py-2 pl-6">
                    <div className="flex items-center gap-3">
                      <Avatar name={c.name} address={c.email} size={32} />
                      <span className="font-medium">{c.name || '—'}</span>
                    </div>
                  </td>
                  <td className="py-2 text-muted">{c.email}</td>
                  <td className="py-2 text-muted max-md:hidden">{tab === 'saved' ? c.company : c.timesContacted}</td>
                  <td className="py-2 text-muted max-md:hidden">{c.lastContactedAt ? relativeTime(c.lastContactedAt) : '—'}</td>
                  <td className="py-2 pr-4">
                    <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
                      <IconButton size="sm" label="Send email" onClick={() => compose.open({ to: [{ address: c.email, name: c.name }] })}>
                        <Mail className="size-4" />
                      </IconButton>
                      <IconButton size="sm" label="Edit" onClick={() => setEditing(c)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label="Delete"
                        onClick={async () => {
                          await api.del(`/api/contacts/${c.id}`);
                          qc.invalidateQueries({ queryKey: ['contacts'] });
                          toast('Contact deleted');
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ContactDialog contact={editing} onClose={() => setEditing(null)} />
      <GroupDialog group={editingGroup} onClose={() => setEditingGroup(null)} />
    </div>
  );
}

/** Create or edit a contact group: a name, and the people in it. */
function GroupDialog({ group, onClose }: { group: Partial<Group> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Addr[]>([]);
  const [busy, setBusy] = useState(false);
  const key = group ? group.id ?? 'new' : null;
  const [lastKey, setLastKey] = useState<unknown>(null);
  if (key !== lastKey) {
    setLastKey(key);
    setName(group?.name ?? '');
    setMembers((group?.members ?? []).map((m) => ({ address: m.address, name: m.name })));
  }
  return (
    <Modal
      open={!!group}
      onClose={onClose}
      title={group?.id ? 'Edit group' : 'New group'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !members.length}
            onClick={async () => {
              setBusy(true);
              try {
                const body = { name: name.trim(), members: members.map((m) => ({ address: m.address, name: m.name ?? '' })) };
                if (group?.id) await api.put(`/api/contacts/groups/${group.id}`, body);
                else await api.post('/api/contacts/groups', body);
                qc.invalidateQueries({ queryKey: ['contact-groups'] });
                toast(group?.id ? 'Group saved' : `Group “${body.name}” created. Type its name in To to add everyone.`);
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Group name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Design team" autoFocus maxLength={80} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">People</p>
          <div className="rounded-xl border border-line px-2">
            <RecipientInput label="" value={members} onChange={setMembers} placeholder="Type names or addresses" />
          </div>
          <p className="mt-1.5 text-xs text-muted">Separate addresses with commas, or pick from your contacts as you type.</p>
        </div>
      </div>
    </Modal>
  );
}

function ContactDialog({ contact, onClose }: { contact: Partial<Contact> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Partial<Contact>>({});
  const [busy, setBusy] = useState(false);
  const key = contact ? contact.id ?? 'new' : null;
  const [lastKey, setLastKey] = useState<unknown>(null);
  if (key !== lastKey) {
    setLastKey(key);
    setForm(contact ?? {});
  }
  const set = (k: keyof Contact, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open={!!contact}
      onClose={onClose}
      title={contact?.id ? 'Edit contact' : 'New contact'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const body = { email: form.email, name: form.name ?? '', phone: form.phone ?? '', company: form.company ?? '', notes: form.notes ?? '' };
                if (contact?.id) await api.put(`/api/contacts/${contact.id}`, body);
                else await api.post('/api/contacts', body);
                qc.invalidateQueries({ queryKey: ['contacts'] });
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">
          <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Company">
            <Input value={form.company ?? ''} onChange={(e) => set('company', e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
