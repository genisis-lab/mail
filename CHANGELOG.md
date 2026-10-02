# Changelog

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
checks, users with quotas and bulk actions, invites, delivery logs, delivery status and
a suppression list from every provider (webhooks or bounce emails), alerts, daily
backups to R2, point-in-time recovery, audit log.

**Security.** scrypt passwords, passkeys, TOTP 2-step verification, new-device sign-in
alerts, encrypted provider secrets, CSP and sandboxed message rendering.
