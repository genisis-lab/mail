import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Button, Card, Checkbox, Field, IconButton, Input, Select, Spinner, Switch, Tabs, Textarea } from '../../components/ui';
import { PageHeader } from './common';
import { useDomains } from './Users';
import { SenderStatus } from './Domains';

type S = Record<string, any>;
type Tab = 'general' | 'registration' | 'security' | 'limits' | 'spam' | 'alerts' | 'retention';

export function AdminSettingsPage() {
  const { tab = 'general' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<{ settings: S }>('/api/admin/settings').then((r) => r.settings) });
  const [draft, setDraft] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  if (!draft || !q.data) return <Spinner />;
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d!, [k]: v }));
  const dirtyKeys = Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(q.data![k]));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/admin/settings', Object.fromEntries(dirtyKeys.map((k) => [k, draft[k]])));
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast('Settings saved');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value));

  return (
    <div>
      <PageHeader title="Settings & policies" description="Instance-wide configuration. Changes apply immediately." />
      <div className="mb-6">
        <Tabs<Tab>
          value={tab as Tab}
          onChange={(t) => navigate(`/admin/settings/${t}`)}
          tabs={[
            { value: 'general', label: 'General' },
            { value: 'registration', label: 'Registration' },
            { value: 'security', label: 'Security' },
            { value: 'limits', label: 'Limits' },
            { value: 'spam', label: 'Spam & blocking' },
            { value: 'alerts', label: 'Alerts' },
            { value: 'retention', label: 'Retention' },
          ]}
        />
      </div>

      {tab === 'general' && (
        <div className="space-y-6">
        <Card title="Branding">
          <div className="grid max-w-xl gap-4">
            <Field label="Instance name">
              <Input value={draft['instance.name']} onChange={(e) => set('instance.name', e.target.value)} />
            </Field>
            <Field label="Accent colour">
              <div className="flex flex-wrap items-center gap-3">
                <input type="color" value={draft['instance.accent']} onChange={(e) => set('instance.accent', e.target.value)} className="h-10 w-14 cursor-pointer rounded-lg border border-line-strong bg-panel p-1" />
                <Input value={draft['instance.accent']} onChange={(e) => set('instance.accent', e.target.value)} className="w-32 font-mono" />
                <div className="flex gap-1.5">
                  {['#2563eb', '#0f766e', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0f172a'].map((c) => (
                    <button key={c} aria-label={c} onClick={() => set('instance.accent', c)} className="size-6 rounded-full" style={{ background: c }} />
                  ))}
                </div>
              </div>
            </Field>
            <Field label="Sign-in page message" help="Shown above the sign-in form, e.g. a support contact.">
              <Textarea value={draft['instance.loginMessage']} onChange={(e) => set('instance.loginMessage', e.target.value)} rows={3} />
            </Field>
          </div>
        </Card>
        <SystemMailCard draft={draft} set={set} />
        </div>
      )}

      {tab === 'registration' && <RegistrationTab draft={draft} set={set} />}

      {tab === 'security' && (
        <Card title="Security policies">
          <div className="grid max-w-xl gap-5">
            <Field label="Require 2-step verification for">
              <Select value={draft['security.require2fa']} onChange={(e) => set('security.require2fa', e.target.value)}>
                <option value="none">Nobody (optional)</option>
                <option value="admins">Administrators</option>
                <option value="all">Everyone</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum password length">
                <Input type="number" min={8} value={draft['security.passwordMinLength']} onChange={num('security.passwordMinLength')} />
              </Field>
              <Field label="Session length (days)">
                <Input type="number" min={1} value={draft['security.sessionDays']} onChange={num('security.sessionDays')} />
              </Field>
            </div>
            <Field label="Failed sign-ins before lockout (15 min)">
              <Input type="number" min={3} value={draft['security.maxLoginAttempts']} onChange={num('security.maxLoginAttempts')} />
            </Field>
            <Switch
              checked={draft['mail.allowExternalForwarding']}
              onChange={(v) => set('mail.allowExternalForwarding', v)}
              label="Allow users to auto-forward mail outside this server"
              description="Turn off to prevent data leaving via forwarding rules."
            />
          </div>
        </Card>
      )}

      {tab === 'limits' && (
        <Card title="Default limits" description="Applied to users without a custom value.">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Field label="Mailbox quota (MB)">
              <Input type="number" min={1} value={draft['limits.defaultQuotaMb']} onChange={num('limits.defaultQuotaMb')} />
            </Field>
            <Field label="Messages sent per day">
              <Input type="number" min={0} value={draft['limits.defaultSendPerDay']} onChange={num('limits.defaultSendPerDay')} />
            </Field>
            <Field label="Max attachment size (MB)">
              <Input type="number" min={1} value={draft['limits.maxAttachmentMb']} onChange={num('limits.maxAttachmentMb')} />
            </Field>
            <Field label="Max recipients per message">
              <Input type="number" min={1} value={draft['limits.maxRecipients']} onChange={num('limits.maxRecipients')} />
            </Field>
            <Field label="Delivery retries" help="Temporary failures are retried with backoff (30s → 4h).">
              <Input type="number" min={1} max={20} value={draft['mail.maxRetries']} onChange={num('mail.maxRetries')} />
            </Field>
          </div>
          <div className="mt-5">
            <Switch
              checked={draft['mail.localDelivery']}
              onChange={(v) => set('mail.localDelivery', v)}
              label="Deliver mail between hosted domains internally"
              description="Faster and free — messages to other users on this server never leave it."
            />
          </div>
        </Card>
      )}

      {tab === 'spam' && <SpamTab draft={draft} set={set} />}

      {tab === 'alerts' && (
        <Card title="Alerts" description="Wren watches for a failing provider, a stuck send queue, full mailboxes and DNS changes, and tells admins.">
          <div className="grid max-w-xl gap-5">
            <Switch
              checked={draft['alerts.email']}
              onChange={(v) => set('alerts.email', v)}
              label="Tell admins about new alerts"
              description="A message in each admin’s inbox, plus a push notification for critical alerts. Alerts always show on the Overview page."
            />
            <Field label="Also email alerts to" help="An address outside this server, so you hear about problems even when Wren’s own mail is down. Leave blank for none.">
              <Input type="email" value={draft['alerts.externalTo']} onChange={(e) => set('alerts.externalTo', e.target.value)} placeholder="you@gmail.com" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Queue backlog alert at" help="Messages waiting to go out.">
                <Input type="number" min={1} value={draft['alerts.queueThreshold']} onChange={num('alerts.queueThreshold')} />
              </Field>
              <Field label="Mailbox full alert at (%)" help="Of a user’s quota.">
                <Input type="number" min={50} max={100} value={draft['alerts.quotaPercent']} onChange={num('alerts.quotaPercent')} />
              </Field>
            </div>
          </div>
        </Card>
      )}

      {tab === 'retention' && (
        <Card title="Automatic clean-up">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Field label="Empty Trash after (days)">
              <Input type="number" min={1} value={draft['retention.trashDays']} onChange={num('retention.trashDays')} />
            </Field>
            <Field label="Delete Spam after (days)">
              <Input type="number" min={1} value={draft['retention.spamDays']} onChange={num('retention.spamDays')} />
            </Field>
          </div>
          <p className="mt-4 text-xs text-muted">Logs are kept for 90 days. Unreferenced files in the message store are garbage-collected daily.</p>
        </Card>
      )}

      {dirtyKeys.length > 0 && (
        <div className="animate-slide-up sticky bottom-0 mt-6 flex items-center justify-end gap-2 rounded-2xl border border-line bg-panel px-4 py-3 shadow-float">
          <span className="mr-auto text-sm text-muted">
            {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}
          </span>
          <Button variant="ghost" onClick={() => setDraft(q.data!)}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

/** Who everything Wren sends itself comes from: invites, password links, welcome messages, alerts, announcements. */
function SystemMailCard({ draft, set }: { draft: S; set: (k: string, v: unknown) => void }) {
  const domains = useDomains();
  // Existing addresses to pick from (any address on a hosted domain works).
  const addresses = useQuery({ queryKey: ['admin', 'addresses', 'all'], queryFn: () => api.get<{ addresses: { address: string }[] }>('/api/admin/addresses').then((r) => r.addresses.map((a) => a.address)) });
  const sender = useQuery({ queryKey: ['admin', 'settings', 'sender'], queryFn: () => api.get<{ systemSender: { address: string; name: string } | null }>('/api/admin/settings').then((r) => r.systemSender) });
  const enabled = (domains.data ?? []).filter((d) => d.enabled).map((d) => d.name);
  const firstDomain = enabled[0] ?? 'yourdomain.com';
  // Suggestions: the usual sender names on every hosted domain (sending subdomains such as contact.example.com included), then existing aliases.
  const suggestions = [...new Set([...enabled.flatMap((d) => [`contact@${d}`, `no-reply@${d}`]), ...(addresses.data ?? [])])];
  const typed = String(draft['mail.systemFrom'] ?? '').trim().toLowerCase();
  const senderDomain = (/^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/.exec(typed)?.[1] ?? sender.data?.address.split('@')[1]) || null;
  return (
    <Card
      title="System emails"
      description="Everything Wren sends by itself: invites, setup and password links, welcome messages, recovery-email confirmations, sign-in alerts, admin alerts and announcements."
    >
      <div className="grid max-w-xl gap-4">
        {sender.data && (
          <p className="rounded-xl bg-panel2 px-3 py-2 text-[13px]">
            Sent as <b>{sender.data.name}</b> &lt;{sender.data.address}&gt;
          </p>
        )}
        <Field
          label="Send from"
          help={`An address on a domain hosted here, so your provider can send it. To send from a subdomain such as contact.${firstDomain}, add it under Domains and verify it with its TXT record first. Blank: contact@${firstDomain}.`}
        >
          <Input type="email" list="system-from-addresses" value={draft['mail.systemFrom']} onChange={(e) => set('mail.systemFrom', e.target.value)} placeholder={`contact@${firstDomain}`} />
          <datalist id="system-from-addresses">
            {suggestions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          {senderDomain && (
            <div className="mt-2">
              <SenderStatus domain={senderDomain} />
            </div>
          )}
        </Field>
        <Field label="Sender name" help={`Blank: the instance name (${draft['instance.name']}).`}>
          <Input value={draft['mail.systemName']} onChange={(e) => set('mail.systemName', e.target.value)} placeholder={draft['instance.name']} />
        </Field>
        <Field label="Replies go to" help="Optional. When someone replies to a system email, it goes here (for example support@). Blank: replies go to the Send from address.">
          <Input type="email" value={draft['mail.systemReplyTo']} onChange={(e) => set('mail.systemReplyTo', e.target.value)} placeholder="No Reply-To" />
        </Field>
      </div>
    </Card>
  );
}

function RegistrationTab({ draft, set }: { draft: S; set: (k: string, v: unknown) => void }) {
  const domains = useDomains();
  const selected: number[] = draft['registration.domains'] ?? [];
  return (
    <div className="space-y-6">
    <Card title="New accounts">
      <div className="grid max-w-xl gap-5">
        <Switch
          checked={draft['users.welcomeMessage']}
          onChange={(v) => set('users.welcomeMessage', v)}
          label="Send a welcome message"
          description="New mailboxes start with a short message: their address, what to set up first (recovery email, 2-step verification), importing old mail and installing the app."
        />
        <Switch
          checked={draft['aliases.selfService']}
          onChange={(v) => set('aliases.selfService', v)}
          label="Let people create their own aliases"
          description="In Settings → Accounts, on their own domain. Reserved names like postmaster@ and admin@ stay off limits."
        />
        {draft['aliases.selfService'] && (
          <Field label="Aliases per person" className="max-w-48">
            <Input type="number" min={1} max={100} value={draft['aliases.maxPerUser']} onChange={(e) => set('aliases.maxPerUser', Number(e.target.value))} />
          </Field>
        )}
        <Switch
          checked={draft['aliases.throwaway']}
          onChange={(v) => set('aliases.throwaway', v)}
          label="Let people make throwaway sign-up addresses"
          description="Like shoe-shop.k3x9@ their domain, one per site, which they can turn off when it starts getting spam. Administrators can always make them."
        />
        {draft['aliases.throwaway'] && (
          <Field label="Sign-up addresses per person" className="max-w-48">
            <Input type="number" min={1} max={500} value={draft['aliases.maxThrowaway']} onChange={(e) => set('aliases.maxThrowaway', Number(e.target.value))} />
          </Field>
        )}
      </div>
    </Card>
    <Card title="Who can create accounts?">
      <div className="max-w-xl space-y-3">
        {(
          [
            ['closed', 'Closed', 'Only administrators create accounts.'],
            ['invite', 'Invite only', 'People with an invitation link can sign up.'],
            ['open', 'Open', 'Anyone can sign up on the domains you choose. Consider requiring 2FA and lowering send limits.'],
          ] as const
        ).map(([v, label, desc]) => (
          <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${draft['registration.mode'] === v ? 'border-accent bg-accent-softer' : 'border-line hover:bg-hover'}`}>
            <input type="radio" checked={draft['registration.mode'] === v} onChange={() => set('registration.mode', v)} className="mt-1 accent-[var(--accent)]" />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="text-xs text-muted">{desc}</span>
            </span>
          </label>
        ))}
        {draft['registration.mode'] === 'open' && (
          <div className="pt-2">
            <p className="mb-2 text-sm font-medium">Domains open for sign-up</p>
            {(domains.data ?? []).map((d) => (
              <div key={d.id} className="flex items-center gap-1 text-sm">
                <Checkbox
                  checked={selected.includes(d.id)}
                  onChange={(v) => set('registration.domains', v ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
                  label={d.name}
                />
                {d.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}

function SpamTab({ draft, set }: { draft: S; set: (k: string, v: unknown) => void }) {
  const qc = useQueryClient();
  const [pattern, setPattern] = useState('');
  const blocklist = useQuery({ queryKey: ['admin', 'blocklist'], queryFn: () => api.get<{ items: any[] }>('/api/admin/blocklist').then((r) => r.items) });
  return (
    <div className="space-y-6">
      <Card title="Spam filtering" description="Built-in scoring uses SPF/DKIM/DMARC results, provider verdicts and content heuristics. Connect rspamd for stronger filtering.">
        <div className="grid max-w-xl gap-4">
          <Switch checked={draft['spam.enabled']} onChange={(v) => set('spam.enabled', v)} label="Spam filtering enabled" />
          <Field label="Spam threshold" help="Messages scoring at or above this go to Spam. Lower is stricter (default 6).">
            <Input type="number" step="0.5" value={draft['spam.threshold']} onChange={(e) => set('spam.threshold', Number(e.target.value))} className="w-32" />
          </Field>
          <Field label="rspamd URL (optional)" help="e.g. http://rspamd:11333 — when set, rspamd’s score replaces the built-in score.">
            <Input value={draft['spam.rspamdUrl']} onChange={(e) => set('spam.rspamdUrl', e.target.value)} placeholder="http://localhost:11333" />
          </Field>
          <Field label="rspamd password">
            <Input type="password" value={draft['spam.rspamdPassword']} onChange={(e) => set('spam.rspamdPassword', e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card title="Server-wide blocklist" description="Mail from these senders or domains is rejected for everyone.">
        <form
          className="mb-4 flex max-w-xl gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pattern.trim()) return;
            await api.post('/api/admin/blocklist', { pattern });
            setPattern('');
            qc.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
          }}
        >
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="bad@example.com or example.com" />
          <Button type="submit">Block</Button>
        </form>
        {(blocklist.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">Nothing blocked.</p>
        ) : (
          <ul className="-my-2 max-w-xl divide-y divide-line">
            {blocklist.data!.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">{b.pattern}</span>
                <span className="text-xs text-faint">{relativeTime(b.createdAt)}</span>
                <IconButton
                  size="sm"
                  label="Remove"
                  onClick={async () => {
                    await api.del(`/api/admin/blocklist/${b.id}`);
                    qc.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
