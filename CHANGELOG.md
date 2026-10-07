# Changelog

## Unreleased

**Sign-in codes.** Emails carrying a one-time code ("980708 is your sign-in code") show
the code as a one-tap Copy button on the inbox row and at the top of the message, and
the notification leads with it. These emails go to Primary rather than Updates, unless
you've moved that sender to another tab.

**Remind me if no reply.** In a conversation you've sent in, ⋮ → "Remind me if no reply
tomorrow / in 3 days / in a week / by…". If nobody but you has written by then, your
message comes back to the top of the inbox, unread, marked "No reply · sent 3 days ago",
with Follow up (reply to all) and Done. A reply cancels the reminder.

**Mute and merge.** Mute a conversation (⋮ in the conversation or on a selection) and new
replies are archived instead of reaching the inbox, with no notification; unmute any
time. Select two or more conversations → ⋮ → Merge conversations to show them as one.

**Contact groups.** Contacts → Groups: name a group and add people. Type its name in To,
Cc or Bcc and it expands into everyone in it.

**Phishing.** ⋮ on a message → Report phishing moves that sender's mail in the
conversation to Spam and alerts admins. Mail that says it's from your own domain, didn't
come through Wren, and failed SPF, DKIM and DMARC shows a red warning.

**Phone.** Pull down on a mail list to refresh. Press and hold a row to select it.

**Offline.** Your inbox and recently opened conversations (up to 150) stay readable with
no connection, with a bar saying you're offline. Sending while offline queues the message
on the device; it goes out when you're back online, or is saved to Drafts if the server
refuses it. Signing out clears what was saved.

**Fixes.**
- Installed on an iPhone, the app's top row no longer sits flush under the status bar,
  where iOS blurred the logo and avatar into it.
- An open conversation now clears "Sending…" by itself once the message has gone out,
  instead of until you reload.

**Upgrading.** Redeploy; the database update (migration 10, additive) runs by itself on
the first request.

## v0.2.2

**Fix: replies to a new email now land in its conversation.** When you started a new
email, its conversation kept the subject from the first autosave (often blank or
half-typed). Replies to mail sent through Resend (or SES) refer to a Message-ID Wren never
saw, so Wren matches them by subject and people instead, and the stale subject made the
first reply start a separate conversation without your original email. Wren now matches
on the messages' own subjects and keeps a new conversation's subject current. Existing
conversations are repaired on upgrade, though replies already split off stay where they are.

**Upgrading.** Redeploy; the repair runs by itself on the first request.

## v0.2.1

README and screenshots for v0.2.0's features (a user's admin page, dark-mode email), and
a shorter "Require a new password" menu label that no longer gets cut off. No upgrade
steps.

## v0.2.0 — admin controls, plainer system mail, dark-mode email

**Admin.** Change a user's address (their sign-in name), optionally keeping the old one
as an alias; they get a note in their inbox. Unlock an account locked by wrong
passwords. Set an out-of-office reply and forwarding for someone who's away or has
left. Export a user's mail as `.mbox`. When deleting a user, hand their addresses and
catch-alls to another account so nothing bounces. Export the user list as CSV, with
locked-out accounts flagged. Only the owner can sign out or manage the owner account.
Require a new password at next sign-in (with a temporary password, for one person, or
in bulk); it's met by any password change, including a reset link.

**Mail.** "Did you mean to attach files?" before sending a message that says "see
attached" without any files. In dark mode, ordinary emails use dark colours (with
readable text whatever colours the sender set); designed emails such as newsletters
keep a white background, and each message can be flipped. Replying to your own message
goes to its recipients, never to an empty To.

**System mail and domains.** System emails are plain, with the link written out, so
they're less likely to land in spam; invites reply to the admin who sent them. A
sending-only subdomain (say contact.example.com) doesn't need MX, its DMARC comes from
the parent domain, and the domain page shows whether your provider has it verified.

**Upgrading from v0.1.0.** Redeploy; the database update runs by itself on the first
request (it only adds a column). No settings, secrets or DNS changes are needed.

## v0.1.0 — first public release

Wren is a Gmail-style webmail for your own domains that runs entirely on Cloudflare
Workers: one Worker, a SQLite Durable Object and R2. Send with Cloudflare Email Service
(no API key), Resend or 20+ other providers; receive with Email Routing or a provider's
inbound webhook.

**Mail.** Conversations, labels, stars, snooze, undo send, scheduled send, search
operators, keyboard shortcuts, dark mode. Primary / Updates / Promotions tabs, one-click
unsubscribe, meeting invitations with Yes / Maybe / No, attachment previews, saved
replies and searches, signatures per address, shared mailboxes.

**Addresses.** Mailboxes, aliases, groups, catch-alls and plus-addressing on any number
of domains; a "via" chip for mail that came through an alias; aliases you can turn off;
throwaway sign-up addresses; catch-all activity with block or make-an-alias.

**Phones.** Installable app (PWA) with Web Push notifications and swipe actions.

**Moving in and out.** Import from Gmail (Takeout), any IMAP account or `.mbox`; export
everything as `.mbox`; contacts from CSV or vCard.

**Admin.** Setup checklist with a round-trip test, one-click Cloudflare setup, DNS
checks, system mail from any hosted address (including a sending-only subdomain, with
its provider verification shown), users with quotas and bulk actions, invites, delivery logs, delivery status and
a suppression list from every provider (webhooks or bounce emails), alerts, daily
backups to R2, point-in-time recovery, audit log.

**Security.** scrypt passwords, passkeys, TOTP 2-step verification, new-device sign-in
alerts, encrypted provider secrets, CSP and sandboxed message rendering.
