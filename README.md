<p align="center">
  <img src="src/web/public/favicon.svg" width="64" height="64" alt="Wren logo">
</p>

<h1 align="center">Wren</h1>
<p align="center"><b>Your mail, on your domains.</b><br>
A clean, Gmail-style webmail you host yourself, on <b>Cloudflare Workers</b> or anywhere Docker runs.<br>
It sends and receives through the email provider you already use.</p>

<p align="center"><img src="docs/screenshots/inbox.png" alt="Wren inbox" width="900"></p>

## Why Wren

- **Custom domains, any number.** Mailboxes, aliases, distribution groups, catch-alls,
  plus-addressing (`you+tag@`), and external forwarding.
- **Bring your own provider.** Send and receive through Cloudflare Email Service, Resend,
  Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Mailjet, SparkPost, MailerSend,
  MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway, Postal, plain SMTP
  and more, with a fallback provider per domain. See [docs/providers.md](docs/providers.md).
- **Serverless first.** On Cloudflare, one Worker plus a SQLite Durable Object, R2 and
  Email Routing. No VM, no open ports, no TLS certificates.
- **Feels like Gmail.** Conversations, labels, stars, snooze, undo send, scheduled send,
  search operators, keyboard shortcuts, a floating compose window, inline replies, and dark mode.
- **A real admin panel.** Users, quotas, domains with DNS health checks, providers with
  test sends, the mail queue, delivery logs, policies, invites, audit log, and backups.

| Conversation | Compose |
|---|---|
| ![Conversation](docs/screenshots/conversation.png) | ![Compose](docs/screenshots/compose.png) |
| **Admin overview** | **20+ providers** |
| ![Admin](docs/screenshots/admin.png) | ![Providers](docs/screenshots/providers.png) |

## Quick start: Cloudflare Workers (recommended)

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install && npx wrangler login
npx wrangler r2 bucket create wren-mail
openssl rand -base64 32 | npx wrangler secret put WREN_SECRET
npm run cf:deploy
```

Open the printed URL and finish the setup wizard. Next, set Email Routing's catch-all to
*Send to Worker → wren* and add a sending provider in **Admin → Providers**.
Full guide: **[docs/cloudflare.md](docs/cloudflare.md)**.

## Alternative: Docker / Node.js

```bash
cp .env.example .env && docker compose up -d --build
```

This build adds a built-in SMTP server (MX → Wren) and SMTP relay providers.
See [docs/self-hosting.md](docs/self-hosting.md).

## Features

**Mail.** Threaded conversations. Inbox, Starred, Snoozed, Important, Sent, Scheduled,
Drafts, All Mail, Spam and Trash. Coloured labels, bulk actions ("select all 2,341"),
archive, snooze, undo send (0–30 s), scheduled send, draft autosave,
attachments and inline images, rich-text editing, signatures, reply/reply-all/forward
inline or popped out, contact autocomplete, a sandboxed HTML renderer with remote-image
blocking, and view original / download `.eml`.

**Search.** Full text (SQLite FTS5) plus `from:` `to:` `cc:` `subject:` `label:`
`has:attachment` `filename:` `is:unread|starred|important|snoozed`
`in:inbox|sent|spam|trash|anywhere` `before:` `after:` `older_than:` `newer_than:`
`larger:` `smaller:`, "exact phrases" and `-negation`. Includes an advanced search form
and "create filter from search".

**Settings.** Theme, density, page size, default From, signature, vacation responder
(dates, contacts only, one reply per sender per 4 days), forwarding, filters (label,
archive, star, forward, delete, never/always spam), blocked senders, labels, password,
TOTP 2FA with recovery codes, active sessions, and API keys.

**Admin.**
- Dashboard with volume chart and provider health.
- Users: roles, suspend, quotas, daily send limits, password and 2FA reset, sign out everywhere.
- Domains: DNS checklist and checker, provider and fallback, catch-all, DKIM selectors.
- Aliases and groups.
- Providers: verify credentials, send test email, rotate inbound URLs.
- Mail queue with retry and cancel; inbound and outbound delivery logs.
- Invites; registration policy (closed, invite, open).
- Security policies: required 2FA, password length, session length, lockout.
- Limits; spam settings (built-in scoring or rspamd) and a server-wide blocklist; retention.
- Branding; announcement emails; audit log; backups.

**Security.**
- Passwords hashed with scrypt; TOTP 2FA.
- Provider secrets encrypted with AES-256-GCM.
- HttpOnly SameSite cookies plus a CSRF header.
- Login rate limiting and an audit trail.
- CSP, and sandboxed message rendering with no scripts.

**Developer API.** `POST /api/v1/send` with `Authorization: Bearer wren_…`.

## Architecture

```
src/
  web/        React 19 + Vite + Tailwind SPA (shared by both runtimes)
  server/     Hono API, mail engine, providers — runtime-agnostic
    platform.ts   SQL, blob storage, DNS and scheduling interfaces
    index.ts      Node.js entry (better-sqlite3, filesystem, SMTP server)
  worker/     Cloudflare entry (Durable Object SQLite, R2, Email Routing, alarms)
integrations/ Cloudflare Email Routing worker for the Node build
```

The design notes are in [docs/PLAN.md](docs/PLAN.md).

## Development

```bash
npm install
npm run cf:dev      # Workers runtime locally (workerd) at http://localhost:8787
npm run dev         # or: Node API + Vite dev server at http://localhost:5173
npm test            # vitest (61 tests: MIME, providers, mail flow, HTTP API)
npm run typecheck
```

## License

MIT
