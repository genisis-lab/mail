/** Emails carrying one-time links: password reset, account setup, recovery verification, invites, welcome. */
import { get, now, run } from '../db/index.js';
import { escapeHtml } from '../mail/compose.js';
import { storeMessage } from '../mail/store.js';
import { getSettings } from '../settings.js';
import { appUrl, sendSystemEmail, systemSender, systemTemplate } from './system-mail.js';
import { issueToken } from './tokens.js';
import type { UserRow } from './users.js';

const instance = () => escapeHtml(getSettings()['instance.name']);

export async function sendPasswordReset(user: Pick<UserRow, 'id' | 'email' | 'name'>, to: string) {
  const token = issueToken(user.id, 'reset');
  const url = appUrl(`/reset?token=${token}`);
  await sendSystemEmail({
    to: [to],
    userId: user.id,
    subject: `Reset your ${getSettings()['instance.name']} password`,
    html: systemTemplate({
      title: 'Reset your password',
      paragraphs: [
        `Someone asked to reset the password for <b>${escapeHtml(user.email)}</b>.`,
        'The link works once and expires in 1 hour. If you didn’t ask for this, you can ignore this email; your password won’t change.',
      ],
      button: { label: 'Choose a new password', url },
    }),
  });
  return url;
}

/** For accounts created by an admin without a password: the person picks one. */
export async function sendSetupLink(user: Pick<UserRow, 'id' | 'email' | 'name'>, to: string | null) {
  const token = issueToken(user.id, 'setup', { email: to });
  const url = appUrl(`/reset?token=${token}&setup=1`);
  if (to) {
    await sendSystemEmail({
      to: [to],
      userId: user.id,
      subject: `Your new ${getSettings()['instance.name']} mailbox`,
      html: systemTemplate({
        title: `Welcome, ${user.name.split(' ')[0] || user.name}`,
        paragraphs: [
          `A mailbox has been created for you: <b>${escapeHtml(user.email)}</b>.`,
          'Choose a password to start using it. The link expires in 7 days.',
        ],
        button: { label: 'Set up my mailbox', url },
      }),
    });
  }
  return url;
}

export async function sendRecoveryVerification(user: Pick<UserRow, 'id' | 'email'>, email: string) {
  const token = issueToken(user.id, 'verify_recovery', { email });
  const url = appUrl(`/verify-recovery?token=${token}`);
  await sendSystemEmail({
    to: [email],
    userId: user.id,
    subject: `Confirm your recovery email for ${getSettings()['instance.name']}`,
    html: systemTemplate({
      title: 'Confirm your recovery email',
      paragraphs: [
        `<b>${escapeHtml(user.email)}</b> wants to use this address to reset its password if it’s ever forgotten.`,
        'If that wasn’t you, ignore this email.',
      ],
      button: { label: 'Confirm this address', url },
    }),
  });
  return url;
}

export async function sendInviteEmail(opts: { to: string; url: string; invitedBy: string; mailbox: string | null; days: number }) {
  return sendSystemEmail({
    to: [opts.to],
    // A personal, plain-ASCII subject: an encoded one (curly quotes) is a small spam signal.
    subject: `${opts.invitedBy} invited you to ${getSettings()['instance.name']}`,
    html: systemTemplate({
      title: 'You have been invited',
      paragraphs: [
        `${escapeHtml(opts.invitedBy)} invited you to create ${opts.mailbox ? `the mailbox <b>${escapeHtml(opts.mailbox)}</b>` : 'a mailbox'} on ${instance()}.`,
        `The invitation expires in ${opts.days} day${opts.days === 1 ? '' : 's'}.`,
      ],
      button: { label: 'Accept the invitation', url: opts.url },
      footer: `You got this email because ${escapeHtml(opts.invitedBy)} entered your address. If you weren’t expecting it, you can ignore it.`,
    }),
  });
}

/** A welcome note in a brand-new mailbox (stored directly; no provider involved). */
export async function welcomeUser(userId: number) {
  if (!getSettings()['users.welcomeMessage']) return;
  const user = get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', [userId]);
  if (!user) return;
  const name = instance();
  const html = systemTemplate({
    title: `Welcome to ${getSettings()['instance.name']}`,
    paragraphs: [
      `Hi ${escapeHtml(user.name.split(' ')[0] || user.name)}, your address is <b>${escapeHtml(user.email)}</b>.`,
      'A few things to set up in <b>Settings</b>:',
      '• <b>Recovery email</b> (Security), so you can reset your password yourself.<br>• <b>Two-step verification</b> (Security).<br>• <b>Signature</b> and <b>notifications</b> (General).',
      'Moving from Gmail or another provider? <b>Settings → Import</b> brings your old mail with you.',
      'On your phone, open this site and choose <b>Add to Home Screen</b> to install it like an app.',
    ],
    footer: `This message was sent by ${name}.`,
  });
  const domain = user.email.split('@')[1];
  await storeMessage({
    userId,
    folder: 'inbox',
    direction: 'in',
    messageId: `welcome.${userId}.${now()}@${domain}`,
    inReplyTo: null,
    references: [],
    from: systemSender(domain) ?? { address: `contact@${domain}`, name: getSettings()['instance.name'] },
    to: [{ address: user.email, name: user.name }],
    cc: [],
    replyTo: null,
    subject: `Welcome to ${getSettings()['instance.name']}`,
    text: null,
    html,
    date: now(),
    size: html.length,
    rawBlob: null,
    attachments: [],
    source: 'system',
  });
}

/** Mark a recovery email as verified (called when a link sent to it is used). */
export function markRecoveryVerified(userId: number, email: string) {
  run('UPDATE users SET recovery_email = ?, recovery_verified_at = ? WHERE id = ?', [email.toLowerCase(), now(), userId]);
}
