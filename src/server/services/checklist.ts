/**
 * "Get Wren ready" checklist for the admin overview. Every item is computed
 * from real state (DNS reports, delivery logs, a round-trip test), not from
 * which buttons were clicked.
 */
import { get, now, run } from '../db/index.js';
import { randomToken } from '../lib/crypto.js';
import { putBlob } from '../mail/blobs.js';
import { buildMime } from '../mail/compose.js';
import { enqueue, providersForDomain } from '../mail/outbound.js';
import { platform } from '../platform.js';
import { getProviderDef } from '../providers/registry.js';
import { getSettings } from '../settings.js';
import type { DnsReport } from './dns.js';
import { sendingProviderType } from './dns.js';

export type ItemStatus = 'done' | 'todo' | 'warn' | 'pending';

export interface ChecklistItem {
  id: string;
  title: string;
  status: ItemStatus;
  detail: string;
  /** Link inside the admin panel, or an API action the UI can call. */
  action?: { label: string; href?: string; api?: string };
  optional?: boolean;
}

const DAY = 86_400_000;

function ago(ts: number): string {
  const m = Math.round((now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function checklist(adminId: number): { items: ChecklistItem[]; complete: boolean } {
  const items: ChecklistItem[] = [];
  const domain = get<{ id: number; name: string; provider_id: number | null; verified_at: number | null; dns_report: string | null; dns_checked_at: number | null }>(
    'SELECT id, name, provider_id, verified_at, dns_report, dns_checked_at FROM domains WHERE enabled = 1 ORDER BY id LIMIT 1',
  );

  items.push(
    domain
      ? { id: 'domain', title: 'Add your domain', status: 'done', detail: `${domain.name}${domain.verified_at ? ' · verified' : ''}` }
      : { id: 'domain', title: 'Add your domain', status: 'todo', detail: 'The domain your addresses live on.', action: { label: 'Add domain', href: '/admin/domains' } },
  );

  // Sending provider
  const primary = domain ? providersForDomain(domain.name).primary : null;
  const pType = domain ? sendingProviderType(domain) : null;
  const pName = pType ? getProviderDef(pType)?.name ?? pType : null;
  items.push(
    primary
      ? { id: 'provider', title: 'Choose how mail is sent', status: 'done', detail: `Sending with ${pName}.` }
      : {
          id: 'provider',
          title: 'Choose how mail is sent',
          status: 'todo',
          detail: 'Cloudflare Email Service needs no API key; Resend needs one.',
          action: { label: 'Add provider', href: '/admin/providers' },
        },
  );

  // Sender authentication (SPF/DKIM) from the latest DNS check
  if (domain) {
    const report = domain.dns_report ? (JSON.parse(domain.dns_report) as DnsReport) : null;
    const dkimOk = !!report?.dkim.some((k) => k.found);
    const spfOk = !!report?.spf.ok && report.spf.includesProvider !== false;
    const cloudflare = pType === 'cloudflare-binding' || pType === 'cloudflare';
    if (!report) {
      items.push({ id: 'auth', title: 'Authenticate your domain', status: 'todo', detail: 'Run a DNS check to see SPF and DKIM status.', action: { label: 'Check DNS', href: `/admin/domains/${domain.id}` } });
    } else if (dkimOk && spfOk) {
      items.push({ id: 'auth', title: 'Authenticate your domain', status: 'done', detail: `SPF and DKIM found (checked ${ago(domain.dns_checked_at ?? now())}).` });
    } else {
      items.push({
        id: 'auth',
        title: 'Authenticate your domain',
        status: 'warn',
        detail: cloudflare
          ? `${!dkimOk ? 'No DKIM key found. ' : ''}${!spfOk ? 'SPF is missing. ' : ''}Onboard ${domain.name} in Email Service → Email Sending, or use one-click Cloudflare setup.`
          : `${!dkimOk ? 'No DKIM key found. ' : ''}${!spfOk ? 'SPF is missing or lacks your provider. ' : ''}Add the records your provider gives you, or mail may land in spam.`,
        action: { label: 'Open domain', href: `/admin/domains/${domain.id}` },
      });
    }

    // Receiving
    const lastIn = get<{ t: number | null }>(
      `SELECT MAX(created_at) AS t FROM inbound_log WHERE status IN ('accepted','spam') AND source NOT IN ('local','system') AND rcpt_to LIKE ?`,
      [`%@${domain.name}`],
    )?.t;
    const mxCf = !!report?.mx.records.some((m) => /\.mx\.cloudflare\.net\.?$/i.test(m.exchange));
    if (lastIn) {
      items.push({ id: 'receive', title: 'Receive mail', status: 'done', detail: `Last message arrived ${ago(lastIn)}.` });
    } else if (report && !report.mx.records.length) {
      items.push({
        id: 'receive',
        title: 'Receive mail',
        status: 'todo',
        detail: `${domain.name} has no MX records. Enable Cloudflare Email Routing and send the catch-all to this Worker.`,
        action: { label: 'Open domain', href: `/admin/domains/${domain.id}` },
      });
    } else {
      items.push({
        id: 'receive',
        title: 'Receive mail',
        status: 'pending',
        detail: mxCf ? 'MX points to Cloudflare Email Routing. No mail has arrived yet; send the round-trip test below.' : 'No mail has arrived yet.',
      });
    }
  }

  // Round-trip test
  items.push(roundtripItem(!!domain && !!primary));

  // Optional good practice
  const people = get<{ c: number }>(`SELECT COUNT(*) AS c FROM users WHERE kind = 'person'`)?.c ?? 0;
  items.push({
    id: 'team',
    title: 'Add your team',
    status: people > 1 ? 'done' : 'todo',
    detail: people > 1 ? `${people} people have mailboxes.` : 'Invite people by email, or import them from a CSV file.',
    action: people > 1 ? undefined : { label: 'Add users', href: '/admin/users' },
    optional: true,
  });
  const me = get<{ totp_enabled: number; recovery_verified_at: number | null }>('SELECT totp_enabled, recovery_verified_at FROM users WHERE id = ?', [adminId]);
  items.push({
    id: 'security',
    title: 'Secure your admin account',
    status: me?.totp_enabled && me.recovery_verified_at ? 'done' : 'todo',
    detail: [me?.totp_enabled ? null : 'Turn on two-step verification', me?.recovery_verified_at ? null : 'add a recovery email'].filter(Boolean).join(' and ') || 'Two-step verification and a recovery email are set.',
    action: me?.totp_enabled && me.recovery_verified_at ? undefined : { label: 'Open security settings', href: '/settings/security' },
    optional: true,
  });

  const complete = items.filter((i) => !i.optional).every((i) => i.status === 'done');
  return { items, complete };
}

/** Send a message out through the provider to the admin's own address and wait for it to come back in. */
/** In the body too, for providers that drop custom headers. */
const CODE_RE = /Delivery test code:\s*([A-Za-z0-9_-]{16,64})/;

export function roundtripSubject(): string {
  return `${getSettings()['instance.name']} delivery test`;
}

/** The test token in an incoming message: the X-Wren-Roundtrip header, else the code in the body. */
export function roundtripToken(p: { subject: string; text: string | null; html: string | null }, header: string | undefined): string | null {
  if (header?.trim()) return header.trim();
  if (!/delivery test/i.test(p.subject)) return null;
  return CODE_RE.exec(p.text ?? '')?.[1] ?? CODE_RE.exec((p.html ?? '').replace(/<[^>]+>/g, ' '))?.[1] ?? null;
}

export async function startRoundtrip(user: { id: number; email: string; name: string }) {
  const token = randomToken(16);
  const subject = roundtripSubject();
  const { raw } = await buildMime({
    from: { address: user.email, name: user.name },
    to: [{ address: user.email, name: user.name }],
    subject,
    html: `<p>This is an automatic delivery test. It went out through your sending provider and came back in through your receiving setup.</p><p>You can delete it.</p><p style="color:#888;font-size:12px">Delivery test code: ${token}</p>`,
    headers: { 'X-Wren-Roundtrip': token },
  });
  const outboxId = enqueue({ kind: 'test', userId: user.id, mailFrom: user.email, recipients: [user.email], rawBlob: await putBlob(raw), subject });
  run('INSERT INTO roundtrip_tests (token, user_id, address, outbox_id, sent_at) VALUES (?, ?, ?, ?, ?)', [token, user.id, user.email, outboxId, now()]);
  platform().wake?.(now());
  return { token, outboxId };
}

const WAIT_MS = 5 * 60_000;

/** The latest round-trip test, told from what actually happened: sent? failed? anything arrived? */
function roundtripItem(canTest: boolean): ChecklistItem {
  const base = { id: 'roundtrip', title: 'Send a test to yourself' };
  const again = canTest ? { label: 'Try again', api: '/api/admin/checklist/roundtrip' } : undefined;
  let rt = get<{ token: string; user_id: number; sent_at: number; received_at: number | null; address: string; outbox_id: number | null }>(
    'SELECT token, user_id, sent_at, received_at, address, outbox_id FROM roundtrip_tests ORDER BY sent_at DESC, rowid DESC LIMIT 1',
  );
  if (!rt) {
    return { ...base, status: 'todo', detail: 'Sends a message out through your provider to your own address and waits for it to arrive.', action: canTest ? { label: 'Send test', api: '/api/admin/checklist/roundtrip' } : undefined };
  }
  if (!rt.received_at) {
    // A provider that drops custom headers and body codes still delivers the message itself.
    const back = get<{ created_at: number }>(
      `SELECT created_at FROM messages WHERE user_id = ? AND direction = 'in' AND from_addr = ? COLLATE NOCASE AND subject = ? AND created_at >= ? ORDER BY id LIMIT 1`,
      [rt.user_id, rt.address, roundtripSubject(), rt.sent_at],
    );
    if (back) {
      run('UPDATE roundtrip_tests SET received_at = ? WHERE token = ?', [back.created_at, rt.token]);
      rt = { ...rt, received_at: back.created_at };
    }
  }
  if (rt.received_at) {
    return {
      ...base,
      status: 'done',
      detail: `Out and back in ${Math.max(1, Math.round((rt.received_at - rt.sent_at) / 1000))} s (${ago(rt.received_at)}).`,
      action: canTest ? { label: 'Run again', api: '/api/admin/checklist/roundtrip' } : undefined,
    };
  }
  const job = rt.outbox_id
    ? get<{ status: string; attempts: number; last_error: string | null; provider_name: string | null; updated_at: number }>(
        'SELECT o.status, o.attempts, o.last_error, o.updated_at, p.name AS provider_name FROM outbox o LEFT JOIN providers p ON p.id = o.provider_id WHERE o.id = ?',
        [rt.outbox_id],
      )
    : undefined;
  const via = job?.provider_name ? ` through ${job.provider_name}` : '';
  if (job?.status === 'failed' || job?.status === 'cancelled') {
    return { ...base, status: 'warn', detail: `The test couldn’t be sent${via}: ${job.last_error ?? job.status}. Check the provider on the Providers page.`, action: again };
  }
  if (job && (job.status === 'queued' || job.status === 'sending')) {
    const retrying = job.attempts > 0 && job.last_error;
    return {
      ...base,
      status: now() - rt.sent_at > WAIT_MS ? 'warn' : 'pending',
      detail: retrying ? `Sending is being retried: ${job.last_error}` : `Sending to ${rt.address}…`,
      action: now() - rt.sent_at > WAIT_MS ? again : undefined,
    };
  }
  const sentAt = job?.updated_at ?? rt.sent_at;
  if (now() - rt.sent_at < WAIT_MS) {
    return { ...base, status: 'pending', detail: `Sent${via} ${ago(sentAt)}. Waiting for it to arrive at ${rt.address}…` };
  }
  // Not back in time: say what did and didn't arrive.
  const arrived = get<{ c: number }>(`SELECT COUNT(*) AS c FROM inbound_log WHERE rcpt_to = ? COLLATE NOCASE AND created_at >= ? AND source NOT IN ('local','system')`, [rt.address, rt.sent_at])?.c ?? 0;
  return {
    ...base,
    status: 'warn',
    detail: arrived
      ? `It left${via} ${ago(sentAt)}, and other mail for ${rt.address} has arrived since, but not the test. Your provider may be filtering it; look in the delivery log.`
      : `It left${via} ${ago(sentAt)}, but nothing has arrived for ${rt.address} since. Check that the domain’s MX records and your provider’s inbound webhook point at Wren.`,
    action: again,
  };
}

export function markRoundtripReceived(token: string) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token.trim())) return;
  run('UPDATE roundtrip_tests SET received_at = ? WHERE token = ? AND received_at IS NULL AND sent_at > ?', [now(), token.trim(), now() - DAY]);
}
