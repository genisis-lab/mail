# Wren — Plan

> **Wren** (short, memorable, and a nod to carrier birds) is a self-hosted,
> Gmail-style webmail for your own custom domains. You can send through the
> email provider you already use, receive through your own SMTP server or your
> provider's inbound webhooks, and manage it all from an admin panel.
>
> Other names considered: *Lark*, *Kite*, *Postie*. The name lives in one
> constant (`APP_NAME` in `src/shared/brand.ts`), so it's easy to rename.

## Goal

One Cloudflare Worker, with no server and no Docker, that a person or a small
organization can deploy to:

1. **Host mail on any number of custom domains**: users, aliases, catch-alls,
   groups, and forwarding.
2. **Send** with Cloudflare Email Service through the Worker's own `send_email`
   binding (no API key), or with Resend, Amazon SES, Postmark, SendGrid, Mailgun,
   SMTP relays and more. You can set a provider per domain and add a fallback.
3. **Receive mail** with Cloudflare Email Routing (straight into the Worker's
   `email()` handler), or through inbound webhooks from the providers that offer
   them (Resend Inbound, Postmark, SendGrid Inbound Parse, Mailgun Routes, SES via
   SNS, SparkPost relay, Postal, ForwardEmail, CloudMailin, Brevo, Mailjet Parse,
   plus raw MIME and generic JSON).
4. **Feel like Gmail**: threaded conversations, labels, stars, snooze,
   search operators, keyboard shortcuts, a floating compose window, undo send,
   scheduled send, and dark mode.
5. **Give admins full control**: domains with DNS checks, users, quotas,
   aliases and groups, providers with test sends, a delivery log with retry,
   policies, audit log, and backups.

## Architecture

Wren is one Cloudflare Worker. The same Worker can optionally run self-hosted on
workerd (Cloudflare's open-source runtime) with `npm run serve` or Docker.

```
              ┌──────────── Browser (React SPA) ────────────┐
              │  Mail UI  ·  Settings  ·  Admin panel       │
              └──────────────────┬──────────────────────────┘
                                 │ Workers static assets + JSON API (cookie session)
┌────────────────────────────────▼─────────────────────────────────┐
│ Worker  →  WrenDurableObject (Hono app + mail engine)            │
│  Auth/2FA · Mail API · Admin API · Inbound webhooks /api/inbound │
│  Outbound queue (retry/backoff) · Ingest pipeline (route → spam  │
│  → filters → store → auto-reply/forward) · 20+ provider adapters │
├──────────────────────────────────────────────────────────────────┤
│ SQLite (Durable Object) · R2 (raw mail, attachments, big bodies) │
│ Email Routing → email() · Email Service → send_email binding     │
│ DO alarms + cron · DNS over HTTPS · TCP sockets (SMTP relays)    │
└──────────────────────────────────────────────────────────────────┘
```

* **Why a Durable Object rather than D1.** Its SQLite API is synchronous and
  transactional, it supports FTS5, it sits next to the code, and its alarms drive the
  send queue. The whole database lives in one object (up to 10 GB); raw messages and
  attachments live in R2.
* **Small mail stack:** a dependency-free MIME builder (`mail/mime.ts`), an SMTP
  client on `cloudflare:sockets`, and `postal-mime` for parsing. The Worker's only
  runtime dependencies are `hono`, `postal-mime` and `zod`.
* **Web:** React 19, Vite, Tailwind CSS v4, TanStack Query, React Router, and lucide
  icons. Message HTML renders in a sandboxed iframe with DOMPurify, and remote images
  are blocked by default.
* **Secrets:** provider credentials are encrypted at rest with AES-256-GCM, using a key
  derived from `WREN_SECRET`, which is generated on first start if you don't set it.

## Feature scope (v1)

### Mail UI
- Sidebar: Compose, Inbox, Starred, Snoozed, Important, Sent, Scheduled,
  Drafts, All Mail, Spam, Trash, and coloured user labels with unread counts.
- Thread list: bulk select, star, important, archive, delete, mark
  read/unread, move, label, snooze, and pagination.
- Conversation view: collapsible messages, inline reply, reply-all and
  forward, attachments, "show images", print, view original (raw MIME).
- Compose: floating, minimisable windows; rich text; To/Cc/Bcc with contact
  autocomplete; From picker (aliases and send-as); attachments; signature;
  draft autosave; schedule send; undo send.
- Search: `from:` `to:` `subject:` `has:attachment` `is:unread|read|starred`
  `in:` `label:` `before:` `after:` `larger:` plus full-text search.
- Keyboard shortcuts in the Gmail style (`c`, `j/k`, `o`, `e`, `#`, `r`,
  `a`, `f`, `s`, `/`, `g i`, `?`).
- Light and dark themes, and comfortable or compact density.

### User settings
Profile, signature, vacation auto-responder, filters (conditions → actions),
labels, send-as identities, forwarding, contacts, password, TOTP 2FA, active
sessions, appearance, and personal API keys.

### Admin panel
- **Dashboard:** users, domains, mail volume chart, storage, queue health,
  and provider status.
- **Domains:** add a domain and get the DNS records it needs (MX, SPF,
  DKIM/provider records, DMARC, verification TXT). Includes a live DNS
  checker, outbound provider and fallback, catch-all, inbound mode, and an
  enable/disable switch.
- **Users:** create, invite, edit, suspend, delete; reset password; set
  role, quota and per-user send limits; view usage; reset 2FA.
- **Aliases and groups:** aliases, distribution groups, and external forwards.
- **Providers:** 21 outbound adapters, each with test send, defaults, and
  health. Inbound endpoints come with signed URLs and per-provider setup steps.
- **Delivery log:** outbound status with retry and cancel; inbound log with
  rejections and spam.
- **Policies:** registration (open, invite, closed), password rules, 2FA
  enforcement, rate limits, attachment size, retention, and spam settings
  (built-in heuristics, optional rspamd).
- **Branding:** instance name, accent colour, and login message.
- **Audit log, backups** (portable export and restore, point-in-time recovery on
  Cloudflare), and system info.

### Providers
| Provider | Outbound | Inbound |
|---|---|---|
| SMTP (any: Gmail/Workspace, M365, Fastmail, Zoho, Postfix…) | ✅ | built-in SMTP server |
| Cloudflare Email Service | ✅ (REST, raw MIME) | ✅ Email Routing Worker |
| Resend | ✅ | ✅ `email.received` webhook |
| Amazon SES (v2) | ✅ (SigV4, raw) | ✅ SNS notification |
| Postmark | ✅ | ✅ inbound webhook |
| SendGrid | ✅ | ✅ Inbound Parse |
| Mailgun (US/EU) | ✅ (raw MIME) | ✅ Routes (`/mime`) |
| SparkPost (US/EU) | ✅ (raw) | ✅ relay webhooks |
| Brevo | ✅ | ✅ inbound parsing |
| Mailjet | ✅ | ✅ Parse API |
| MailerSend | ✅ | — |
| MailChannels | ✅ | — |
| SMTP2GO | ✅ (raw) | — |
| ZeptoMail (Zoho) | ✅ | — |
| Elastic Email | ✅ | — |
| Mailtrap | ✅ | — |
| Scaleway TEM | ✅ | — |
| Postal (self-hosted) | ✅ (raw) | ✅ HTTP endpoint |
| ForwardEmail / CloudMailin | — | ✅ |
| Custom HTTP webhook | ✅ (signed JSON) | ✅ raw MIME / generic JSON |
| Local delivery | between hosted domains, always internal | |

## Milestones

1. ✅ **Foundation:** repo scaffold, config, DB and migrations, crypto, auth
   (sessions, scrypt, TOTP), first-run setup wizard.
2. ✅ **Mail core:** MIME build and parse, threading, blob storage, ingest pipeline,
   outbound queue with retries, local delivery, FTS search.
3. ✅ **Providers:** outbound and inbound adapters, built-in SMTP server, Cloudflare
   Email Routing worker.
4. ✅ **Mail UI:** layout, list, conversation, compose, search, shortcuts, and themes.
5. ✅ **Settings and admin:** user settings, then every admin section.
6. ✅ **Cloudflare Workers:** runtime abstraction, Durable Object SQLite, R2,
   Email Routing handler, alarms and cron, wrangler config.
7. ✅ **Ops:** Dockerfile, compose, docs (Cloudflare, self-hosting, providers), tests,
   and a smoke test in a real browser on both runtimes.
8. ✅ **Workers parity:** SMTP client on `cloudflare:sockets`, large bodies moved to
   R2, a single JSON parameter per IN-list (Durable Object limit of 100), a generated
   encryption key, streamed export and restore, point-in-time recovery, and a 30-day
   grace period for deleted files.
9. ✅ **Workers only:** removed the separate Node.js server and built-in SMTP server.
   Cloudflare Email Service (`send_email` binding) and Resend are first-class in the
   setup wizard, `npm run setup` deploys from the terminal, and optional self-hosting
   runs the same Worker on workerd (`npm run serve` / Docker).

## Later (post-v1)
JMAP over HTTP for desktop and mobile clients (Workers can't accept IMAP connections),
calendar and contacts sync over HTTP (CalDAV/CardDAV), delivery/bounce webhooks per
provider, multi-tenant billing, and mobile PWA push notifications.
