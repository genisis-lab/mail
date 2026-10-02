<p align="center">
  <img src="src/web/public/favicon.svg" width="64" height="64" alt="Wren logo">
</p>

<h1 align="center">Wren</h1>
<p align="center"><b>Your mail, on your domains.</b><br>
A clean, Gmail-style webmail that runs entirely on <b>Cloudflare Workers</b>, with no servers and no Docker.<br>
Send with Cloudflare Email Service (no API key) or Resend, and receive with Email Routing.</p>

<p align="center"><a href="https://deploy.workers.cloudflare.com/?url=https://github.com/genisis-lab/mail"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a></p>

<p align="center"><img src="docs/screenshots/inbox.png" alt="Wren inbox" width="900"></p>

## Why Wren

- **Custom domains, any number.** Mailboxes, aliases, distribution groups, catch-alls,
  plus-addressing (`you+tag@`), and external forwarding.
- **Built around Cloudflare.** One Worker plus a SQLite Durable Object, R2, Email Routing
  (incoming mail) and Email Service (outgoing mail through the Worker's own binding, with no API key).
  There's no VM, no open ports, no TLS certificates and no secrets to set up.
- **Or bring your provider.** Resend, Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Mailjet,
  SparkPost, MailerSend, MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway,
  Postal, SMTP relays (Gmail, Microsoft 365, Fastmail…) and more, with a fallback provider per
  domain. See [docs/providers.md](docs/providers.md).
- **Feels like Gmail.** Conversations, labels, stars, snooze, undo send, scheduled send,
  search operators, keyboard shortcuts, a floating compose window, inline replies, and dark mode.
- **A real admin panel.** Users, quotas, domains with DNS health checks, providers with
  test sends, the mail queue, delivery logs, policies, invites, audit log, and backups.

| Conversation | Compose |
|---|---|
| ![Conversation](docs/screenshots/conversation.png) | ![Compose](docs/screenshots/compose.png) |
| **Admin overview** | **20+ providers** |
| ![Admin](docs/screenshots/admin.png) | ![Providers](docs/screenshots/providers.png) |

## Quick start

Click **Deploy to Cloudflare** above, or from a terminal:

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install
npm run setup        # signs in to Cloudflare, creates the R2 bucket, deploys
```

Then:

1. Open the printed URL and finish the setup wizard. Choose **Cloudflare Email Service** (no
   API key) or **Resend** (paste your key).
2. In the Cloudflare dashboard, open your domain → **Email → Email Routing**, enable it, and
   set the catch-all rule to **Send to a Worker → wren**. That's how mail comes in.
3. Using Cloudflare Email Service? Open **Email Service → Email Sending** and onboard your
   domain so Wren can send from it.

Full guide: **[docs/cloudflare.md](docs/cloudflare.md)**.

### How mail flows

| | Cloudflare Email Service | Resend |
|---|---|---|
| **Sending** | The Worker's `send_email` binding, no API key | Resend API key |
| **Receiving** | Email Routing → the Worker's `email()` handler | Email Routing, or Resend's inbound webhook |
| **Setup** | Onboard the domain in Email Sending | Verify the domain in Resend |

Everything runs inside the Worker: the web app, the API, the send queue (Durable Object
alarms), search, and storage (SQLite in a Durable Object, files in R2).

### Optional: self-hosting

You don't need Docker. If you'd rather run Wren on your own server, the same Worker runs
locally on workerd, Cloudflare's open-source Workers runtime: `npm run serve`, or
`docker compose up -d`. Send and receive through a provider such as Resend, because Email
Routing and Email Service need a Cloudflare deployment. See
[docs/self-hosting.md](docs/self-hosting.md).

## Features

**Mail.** Threaded conversations. Inbox, Starred, Snoozed, Important, Sent, Scheduled,
Drafts, All Mail, Spam and Trash. Coloured labels, bulk actions ("select all 2,341"),
archive, snooze, undo send (0–30 s), scheduled send, draft autosave,
attachments and inline images, rich-text editing, signatures, reply/reply-all/forward
inline or popped out, contact autocomplete, a sandboxed HTML renderer with remote-image
blocking, and view original / download `.eml`. Saved replies, saved searches in the
sidebar, a signature per address, and shared mailboxes (support@, sales@) that a team
reads together, with "sent by" on each reply.

**On your phone.** Installable as an app (PWA) with its own icon and an offline app
shell. New-mail notifications through Web Push. Pushes carry no data: the app asks Wren
what's new, so nothing about your mail passes through the push service. Gmail-style
rows with swipe actions, a floating Compose button, and the unread count in the tab
title and app badge.

**Moving in and out.** Import from Gmail (a Google Takeout `.mbox` keeps labels, stars
and read state), from any IMAP account (Gmail, iCloud, Yahoo, Fastmail, Zoho…; copied in
the background, password forgotten when done), or any `.mbox` file. Messages already
there are skipped. Export everything as one `.mbox` that imports back as it was.
Contacts import from Google/Outlook CSV or vCard and export to both.

**Search.** Full text (SQLite FTS5) plus `from:` `to:` `cc:` `subject:` `label:`
`has:attachment` `filename:` `is:unread|starred|important|snoozed`
`in:inbox|sent|spam|trash|anywhere` `before:` `after:` `older_than:` `newer_than:`
`larger:` `smaller:`, "exact phrases" and `-negation`. Includes an advanced search form
and "create filter from search".

**Settings.** Theme, density, page size, default From, signatures, vacation responder
(dates, contacts only, one reply per sender per 4 days), forwarding, filters (label,
archive, star, forward, delete, never/always spam), blocked senders, labels, swipe
actions, notifications, self-service aliases (if the admin allows), password, a
recovery email for "Forgot password?", TOTP 2FA with recovery codes, active sessions,
and API keys.

**Admin.**
- Dashboard with volume chart, provider health, and a "Get Wren ready" checklist built
  from real state, including a round-trip test that sends a message out through your
  provider and waits for it to come back.
- Alerts when a provider keeps failing, the send queue backs up, a mailbox is nearly
  full, or DNS changes for the worse (checked daily). They go to admins' inboxes, push
  for critical ones, and optionally an outside address.
- Users: roles, suspend, quotas, daily send limits, 2FA reset, sign out everywhere;
  bulk actions; CSV import with a dry-run check; a detail page with storage, addresses,
  devices and sign-in history. New people get an emailed link to choose their own
  password, and an optional welcome message.
- Domains: DNS records that match the sending provider, a DNS checker with health
  badges, provider and fallback, catch-all, DKIM selectors, and one-click Cloudflare
  setup (Email Routing and Email Sending). It won't move a domain's mail away from its
  current MX without asking.
- Aliases, groups and shared mailboxes.
- Providers: verify credentials, send test email, rotate inbound URLs.
- Mail queue with retry and cancel; delivery logs with search, filters, a timeline and
  retry. Logs show headers only; admins never see message bodies.
- Invites, emailed for you; registration policy (closed, invite, open).
- Security policies: required 2FA, password length, session length, lockout.
- Limits; spam settings (built-in scoring or rspamd) and a server-wide blocklist; retention.
- Branding; announcement emails; audit log.
- Backups: portable export and restore, plus point-in-time recovery on Cloudflare.

**Security.**
- Passwords hashed with scrypt; TOTP 2FA.
- Provider secrets encrypted with AES-256-GCM.
- HttpOnly SameSite cookies plus a CSRF header.
- Login rate limiting and an audit trail.
- CSP, and sandboxed message rendering with no scripts.

**Developer API.** `POST /api/v1/send` with `Authorization: Bearer wren_…`.

**Accessibility.** Labelled controls, dialogs that keep and return focus, menus with
arrow keys, announced notifications, and colours that meet WCAG AA contrast.

**Desktop mail apps.** Wren is a web app, installable on phones and desktops. Workers
can't accept incoming SMTP or IMAP connections, so Outlook and Apple Mail can't connect
to it directly.

## Architecture

```
src/
  web/        React 19 + Vite + Tailwind single-page app (Workers static assets)
  server/     Hono API, mail engine and provider adapters
    platform.ts   storage, DNS, sockets and scheduling interfaces
  worker/     Worker entry: Durable Object (SQLite), R2, Email Routing, Email Service,
              alarms, cron, TCP sockets
scripts/      setup.mjs (terminal setup), serve.mjs (optional self-hosting on workerd)
```

The design notes are in [docs/PLAN.md](docs/PLAN.md).

## Development

```bash
npm install
npm run dev         # the Worker on the real Workers runtime (workerd) at http://localhost:8787
npm run dev:web     # optional: hot-reloading UI at http://localhost:5173 (API proxied to 8787)
npm test            # vitest: MIME, SMTP client, providers, mail flow, backups, HTTP API
npm run typecheck
```

In `npm run dev`, Cloudflare Email Service sends are simulated (written to `.wrangler/tmp`),
and you can deliver a test message to the `email()` handler:

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@example.org&to=you@example.com' \
  --data-binary @message.eml
```

## License

MIT
