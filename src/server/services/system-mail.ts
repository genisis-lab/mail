/**
 * Mail that Wren itself sends: invites, password links, alerts, welcome
 * messages. It goes through the normal outbox, so hosted recipients get it
 * by local delivery and external ones through the domain's provider.
 */
import { get, now } from '../db/index.js';
import { domainOf } from '../lib/addr.js';
import { config } from '../config.js';
import { platform } from '../platform.js';
import { getSettings } from '../settings.js';
import { putBlob } from '../mail/blobs.js';
import { buildMime, escapeHtml } from '../mail/compose.js';
import { enqueue } from '../mail/outbound.js';

const hosted = (domain: string) => !!get('SELECT 1 FROM domains WHERE name = ? AND enabled = 1', [domain.toLowerCase()]);

/**
 * The From address for everything Wren sends itself (invites, setup and
 * password links, welcome messages, alerts): the one chosen in Settings &
 * policies, or contact@ a hosted domain (the recipient's, if hosted). A chosen address
 * whose domain is no longer hosted falls back to the automatic one, since the
 * provider couldn't send it.
 */
export function systemSender(domainHint?: string): { address: string; name: string } | null {
  const s = getSettings();
  const name = s['mail.systemName'].trim() || s['instance.name'];
  const chosen = s['mail.systemFrom'].trim().toLowerCase();
  if (chosen && hosted(domainOf(chosen))) return { address: chosen, name };
  const hinted = domainHint ? get<{ name: string }>('SELECT name FROM domains WHERE name = ? AND enabled = 1', [domainHint.toLowerCase()]) : undefined;
  const d =
    hinted ??
    get<{ name: string }>('SELECT name FROM domains WHERE enabled = 1 ORDER BY verified_at IS NULL, id LIMIT 1');
  if (!d) return null;
  return { address: `contact@${d.name}`, name };
}

/** Minimal, mail-client-safe HTML layout with an optional call-to-action button. */
export function systemTemplate(opts: { title: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }): string {
  const accent = getSettings()['instance.accent'] || '#2563eb';
  const name = escapeHtml(getSettings()['instance.name']);
  const p = opts.paragraphs.map((t) => `<p style="margin:0 0 14px;line-height:1.55">${t}</p>`).join('');
  const button = opts.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(opts.button.url)}" style="background:${accent};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(opts.button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:#555">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(opts.button.url)}</span></p>`
    : '';
  // No header line above the title: inbox previews would start with the instance name.
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1f2328;max-width:560px">
<h2 style="margin:0 0 14px;font-size:20px">${escapeHtml(opts.title)}</h2>${p}${button}
<p style="margin:24px 0 0;font-size:12px;color:#777">${opts.footer ?? `Sent by ${name}.`}</p></div>`;
}

export interface SystemEmail {
  to: string[];
  subject: string;
  html: string;
  /** Owner of the outbox job (shows in delivery logs). */
  userId?: number | null;
  replyTo?: string | null;
  headers?: Record<string, string>;
}

/** Queue a system message. Returns the outbox id, or null when no domain is hosted yet. */
export async function sendSystemEmail(mail: SystemEmail): Promise<number | null> {
  const from = systemSender(domainOf(mail.to[0] ?? ''));
  if (!from || !mail.to.length) return null;
  const { raw } = await buildMime({
    from,
    to: mail.to.map((address) => ({ address })),
    subject: mail.subject,
    html: mail.html,
    replyTo: mail.replyTo ?? (getSettings()['mail.systemReplyTo'].trim() || null),
    headers: { 'Auto-Submitted': 'auto-generated', ...(mail.headers ?? {}) },
  });
  const id = enqueue({ kind: 'notice', userId: mail.userId ?? null, mailFrom: from.address, recipients: mail.to, rawBlob: await putBlob(raw), subject: mail.subject });
  platform().wake?.(now());
  return id;
}

/** Absolute link into the web app. */
export function appUrl(path: string): string {
  return `${config.publicUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
