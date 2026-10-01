import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Mail, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { useCompose } from '../components/Compose';
import { useToast } from '../components/toast';
import { Button, Empty, Field, IconButton, Input, Modal, Spinner, Tabs, Textarea } from '../components/ui';

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
  const [tab, setTab] = useState<'saved' | 'frequent'>('saved');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);
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
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ email: '', name: '', phone: '', company: '', notes: '' })}>
            Create contact
          </Button>
        </div>
      </div>
      <div className="px-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'saved', label: 'Contacts' },
            { value: 'frequent', label: 'Frequently contacted' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {contacts.isLoading ? (
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
    </div>
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
        <div className="grid grid-cols-2 gap-3">
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
