import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Plus, Send, Ticket } from 'lucide-react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Field, Input, Menu, Modal, Select, Spinner } from '../../components/ui';
import { CopyField, PageHeader, Table } from './common';
import { useDomains } from './Users';

interface Invite {
  id: number;
  email: string | null;
  role: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
  sent_to: string | null;
  emailed_at: number | null;
  domain: string | null;
  used_by_email: string | null;
}

export function InvitesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api.get<{ invites: Invite[] }>('/api/admin/invites').then((r) => r.invites) });
  const empty = { email: '', domainId: '', role: 'user', days: '7', sendTo: '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; emailed: string | null } | null>(null);
  const [resending, setResending] = useState<Invite | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
  const close = () => {
    setOpen(false);
    setCreated(null);
    setForm(empty);
  };

  return (
    <div>
      <PageHeader
        title="Invites"
        description="Invitation links let people create their own mailbox, even when registration is closed. Wren can email the link for you."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Invite someone
          </Button>
        }
      />
      {invites.isLoading ? (
        <Spinner />
      ) : !invites.data?.length ? (
        <Card>
          <Empty icon={<Ticket className="size-7" />} title="No invites yet">
            Invite someone by email, or create a link to share yourself.
          </Empty>
        </Card>
      ) : (
        <Table head={['For', 'Role', 'Status', 'Sent', '']}>
          {invites.data.map((i) => {
            const expired = i.expires_at < Date.now();
            return (
              <tr key={i.id}>
                <td>
                  <p className="font-medium">{i.email ?? (i.domain ? `Any address @${i.domain}` : 'Any address')}</p>
                  {i.sent_to && <p className="text-xs text-muted">Invitation to {i.sent_to}</p>}
                </td>
                <td>
                  <Badge>{i.role}</Badge>
                </td>
                <td>
                  {i.used_at ? (
                    <Badge tone="ok">used by {i.used_by_email}</Badge>
                  ) : expired ? (
                    <Badge tone="warn">expired</Badge>
                  ) : (
                    <span className="text-xs text-muted">expires {relativeTime(i.expires_at)}</span>
                  )}
                </td>
                <td className="text-xs text-muted">{i.emailed_at ? `Emailed ${relativeTime(i.emailed_at)}` : `Link created ${relativeTime(i.created_at)}`}</td>
                <td className="text-right">
                  <Menu
                    align="right"
                    trigger={({ onClick }) => (
                      <button onClick={onClick} aria-label="Invite actions" className="rounded-full p-2 text-muted hover:bg-hover hover:text-fg">
                        <MoreVertical className="size-4" />
                      </button>
                    )}
                    items={[
                      ...(i.used_at ? [] : [{ label: i.sent_to ? 'Send again…' : 'Email the invitation…', icon: <Send className="size-4" />, onClick: () => setResending(i) }]),
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: async () => {
                          await api.del(`/api/admin/invites/${i.id}`);
                          refresh();
                          toast('Invite deleted');
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <Modal
        open={open}
        onClose={close}
        title={created ? (created.emailed ? 'Invitation sent' : 'Invite link ready') : 'Invite someone'}
        footer={
          created ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy}
                icon={form.sendTo.trim() ? <Send className="size-4" /> : undefined}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const sendTo = form.sendTo.trim();
                    const r = await api.post<{ url: string; emailed: boolean }>('/api/admin/invites', {
                      email: form.email || undefined,
                      domainId: form.domainId ? Number(form.domainId) : null,
                      role: form.role,
                      days: Number(form.days),
                      sendTo: sendTo || undefined,
                    });
                    setCreated({ url: r.url, emailed: r.emailed ? sendTo : null });
                    refresh();
                  } catch (err) {
                    toast({ message: (err as Error).message, tone: 'error' });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {form.sendTo.trim() ? 'Send invitation' : 'Create link'}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3 pb-2 text-sm">
            <p>{created.emailed ? <>We emailed the invitation to <b>{created.emailed}</b>. You can also share the link yourself:</> : 'Share this link privately. It works once.'}</p>
            <CopyField value={created.url} label="invite link" onCopy={() => toast('Link copied')} />
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="Send the invitation to" help="Their current email address. Leave blank to just create a link to share.">
              <Input type="email" value={form.sendTo} onChange={(e) => setForm({ ...form, sendTo: e.target.value })} placeholder="name@gmail.com" autoFocus />
            </Field>
            <Field label="Their new address (optional)" help="Leave blank to let them choose.">
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="newperson@yourdomain.com" />
            </Field>
            <Field label="Domain">
              <Select value={form.domainId} onChange={(e) => setForm({ ...form, domainId: e.target.value })}>
                <option value="">Any hosted domain</option>
                {(domains.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Role">
                <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="user">User</option>
                  <option value="admin">Administrator</option>
                </Select>
              </Field>
              <Field label="Expires after">
                <Select value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
                  {[1, 3, 7, 14, 30].map((d) => (
                    <option key={d} value={d}>
                      {d} day{d > 1 ? 's' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        )}
      </Modal>
      <ResendModal invite={resending} onClose={() => setResending(null)} onSent={refresh} />
    </div>
  );
}

function ResendModal({ invite, onClose, onSent }: { invite: Invite | null; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  if (invite && invite.id !== lastId) {
    setLastId(invite.id);
    setTo(invite.sent_to ?? '');
  }
  return (
    <Modal
      open={!!invite}
      onClose={onClose}
      title="Email the invitation"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!to.trim()}
            icon={<Send className="size-4" />}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ sentTo: string }>(`/api/admin/invites/${invite!.id}/resend`, { sendTo: to.trim() });
                toast(`Invitation sent to ${r.sentTo}`);
                onSent();
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Send
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-muted">A fresh link is sent and the old one stops working.</p>
      <Field label="Send to">
        <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
