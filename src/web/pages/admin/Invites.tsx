import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Ticket, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Select, Spinner } from '../../components/ui';
import { CopyField, PageHeader, Table } from './common';
import { useDomains } from './Users';

export function InvitesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api.get<{ invites: any[] }>('/api/admin/invites').then((r) => r.invites) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', domainId: '', role: 'user', days: '7' });
  const [link, setLink] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title="Invites"
        description="Invitation links let people create their own mailbox, even when registration is closed."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => (setLink(null), setOpen(true))}>
            Create invite
          </Button>
        }
      />
      {invites.isLoading ? (
        <Spinner />
      ) : !invites.data?.length ? (
        <Card>
          <Empty icon={<Ticket className="size-7" />} title="No invites yet" />
        </Card>
      ) : (
        <Table head={['For', 'Role', 'Status', 'Created', '']}>
          {invites.data.map((i) => {
            const expired = i.expires_at < Date.now();
            return (
              <tr key={i.id}>
                <td>{i.email ?? (i.domain ? `anyone @${i.domain}` : 'anyone')}</td>
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
                <td className="text-xs text-muted">{relativeTime(i.created_at)}</td>
                <td className="text-right">
                  <IconButton
                    size="sm"
                    label="Delete"
                    onClick={async () => {
                      await api.del(`/api/admin/invites/${i.id}`);
                      qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create invite"
        footer={
          link ? (
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    const r = await api.post<{ url: string }>('/api/admin/invites', {
                      email: form.email || undefined,
                      domainId: form.domainId ? Number(form.domainId) : null,
                      role: form.role,
                      days: Number(form.days),
                    });
                    setLink(r.url);
                    qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
                  } catch (err) {
                    toast({ message: (err as Error).message, tone: 'error' });
                  }
                }}
              >
                Create link
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="space-y-2 pb-2">
            <p className="text-sm">Share this link. It can be used once.</p>
            <CopyField value={link} onCopy={() => toast('Link copied')} />
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="Exact address (optional)" help="Leave blank to let them choose their address.">
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
    </div>
  );
}
