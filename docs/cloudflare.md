# Deploy Wren on Cloudflare Workers

Wren is built for Cloudflare Workers, and it needs no Docker or server. One Worker
serves the web app and API. It receives mail through **Email Routing** and sends it
through **Email Service** using the Worker's own binding, so there's no API key.
Resend or any other provider works too. There are no servers, ports or TLS certificates
to manage.

```
Browser ─► Worker ─► Static assets (the Gmail-style app)
              └────► /api/* ─► WrenDurableObject ─► SQLite (users, mail index, search)
                                      │           └► R2 (raw messages, attachments)
                                      └► alarms ─► send queue, snoozes, retention
Email Routing ─► Worker email() handler ─► WrenDurableObject.receiveEmail()
send queue ─► send_email binding (Email Service) · Resend / other provider APIs
```

## What you need

- A Cloudflare account with your domain on Cloudflare DNS (required for Email Routing).
- **Workers Paid** ($5/month). Password hashing needs more than the free plan's 10 ms of
  CPU per request, and Durable Object alarms do the background sending.
- R2 enabled on the account. The free tier covers 10 GB.
- Node.js 22+ on your computer (only to run `npm run setup` or `npm run deploy`).

## 1. Deploy

**One click:** use the *Deploy to Cloudflare* button in the README. Cloudflare copies the
repository to your GitHub account, creates the R2 bucket and Durable Object, and deploys.
It also connects the copy with Workers Builds, so a push to your main branch redeploys.
If you work in other branches, turn off **Builds for Preview branches** (Workers & Pages →
wren → Settings → Builds → Previews Base): Worker Previews need a `[previews]` setup with
their own storage, which Wren doesn't include, so those builds would fail.

**From a terminal:**

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install
npm run setup      # signs in, creates the R2 bucket, builds and deploys
```

`npm run setup` runs these steps for you, so you can also do them by hand:

```bash
npx wrangler login
npx wrangler r2 bucket create wren-mail           # message bodies & attachments
npm run deploy                                     # builds the web app and deploys
```

Open the `*.workers.dev` URL that wrangler prints. The **setup wizard** asks for an
instance name, your first domain, how to send mail (**Cloudflare Email Service**,
**Resend**, or later) and the owner account.

### Encryption key (optional)

Provider credentials and two-factor secrets are encrypted at rest. On first start Wren
generates the key and stores it inside the Durable Object, so there's nothing to set up.

If you'd rather keep the key separate from the data, set it as a Worker secret **before
the first start**:

```bash
openssl rand -base64 32 | npx wrangler secret put WREN_SECRET
```

Changing the key later makes existing credentials unreadable. Wren then shows a warning
in the admin panel, and you re-enter the provider settings.

### Custom hostname

The repository's `wrangler.toml` has no hostname in it, so it deploys to any account.
Add yours one of two ways:

- **In the dashboard** (nothing to commit): **Workers & Pages → wren → Settings →
  Domains & Routes → Add → Custom domain**, for example `mail.example.com`. To pin the
  address Wren uses in links, webhook URLs and passkeys, add a variable `PUBLIC_URL =
  https://mail.example.com` under **Settings → Variables and Secrets**.
  `keep_vars = true` in `wrangler.toml` keeps it across deploys.
- **In your own config file**: copy `wrangler.toml` to e.g. `wrangler.mydomain.toml`,
  add `routes = [{ pattern = "mail.example.com", custom_domain = true }]` and
  `[vars] PUBLIC_URL = "https://mail.example.com"`, and deploy with
  `npx wrangler deploy -c wrangler.mydomain.toml` (with Workers Builds, set that as the
  **Deploy command** under Settings → Build). `wrangler.builtwai.toml` is an example.

Without `PUBLIC_URL`, Wren uses the hostname each request arrives on. Passkeys belong to
one hostname, so use the same one every time.

## 2. Receive mail (Email Routing)

1. Dashboard → your domain → **Email → Email Routing → Enable**. Cloudflare adds the
   MX and SPF records for you.
2. **Routing rules → Catch-all address → Edit → Action: Send to a Worker → `wren`**.
   You can also route only specific addresses.
3. Send a message to `you@example.com`. It shows up in Wren within seconds.

Unknown addresses are rejected during the SMTP conversation (`550 5.1.1`), unless
you set a catch-all mailbox for the domain under **Admin → Domains**.
**Admin → Delivery logs → Inbound** shows every delivery and rejection.

## 3. Send mail

If you picked a provider in the setup wizard, it's already the default. You can add
others (or a fallback) in **Admin → Providers → Add provider**.

**Cloudflare Email Service (recommended).** `wrangler.toml` already declares the
`send_email` binding named `EMAIL`, so nothing needs a key. Open **Email Service → Email
Sending** in the dashboard and onboard your domain; Cloudflare adds the SPF and DKIM
records. Then use **Send test email** in Admin → Providers.

**Resend.** Verify your domain in Resend, create an API key, and paste it into the wizard
(or Admin → Providers). Incoming mail can still arrive through Email Routing. If your
domain's MX points at Resend instead, add the inbound webhook URL from Admin → Providers →
Resend in the Resend dashboard (`email.received` event).

Other options:

| Option | Setup |
|---|---|
| **Cloudflare Email Service (API token)** | For sending through another account's Email Service. Create an API token with *Email Sending: Send* permission and enter the account ID and token. |
| Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Mailjet, SparkPost, MailerSend, MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway, Postal, custom webhook | HTTP APIs. Follow the setup notes shown in Wren for each one. |
| **SMTP relay** (Gmail / Google Workspace, Microsoft 365, Fastmail, Zoho, iCloud, SES/SendGrid/Mailgun SMTP…) | Uses Workers TCP sockets. Choose port **587** (STARTTLS) or **465** (TLS); Cloudflare blocks outbound port 25. Certificates are always verified. |

Mail between users on your own domains never leaves the Durable Object, so it's
instant and free.

### One-click setup

With a Cloudflare API token (Admin → Domains → a domain → **Set up with Cloudflare**),
Wren can do steps 2 and 3 for you: turn on Email Routing, point the catch-all at this
Worker, onboard the domain in Email Sending and create the DNS records it needs. The
token needs Zone: Read, DNS: Edit, Email Routing Rules: Edit, Zone Settings: Edit and
Email Sending: Edit, and is stored encrypted.

If the domain's MX records point at another service today (for example Resend
inbound), nothing is changed until you confirm that its mail should move to Cloudflare.

## 4. Recommended DNS

**Admin → Domains → your domain** lists every record and has a **Check DNS** button
(it queries over DNS-over-HTTPS):

- `_wren.example.com TXT wren-verify=…`: proves ownership.
- SPF and DKIM: added by Cloudflare when you onboard Email Sending (selector `cf2024-1`).
- DMARC: `_dmarc.example.com TXT "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"`.

## Local development

```bash
npm run dev                      # http://localhost:8787 on the real Workers runtime (workerd)

# Deliver a test message through the email() handler:
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@example.org&to=you@example.com' \
  --data-binary @message.eml
```

Durable Object, R2 and alarm state persist locally under `.wrangler/`. Email Service
sends are simulated (each message is written to `.wrangler/tmp/email/`), and point-in-time
recovery only works once deployed.

## Backups

**Admin → System & backup** has these tools:

- **Automatic backups.** Every day (03:00 UTC by default) a copy of the database is
  written to the R2 bucket, and the last 7 are kept (choose 3–60). An admin alert goes
  out if one fails, and it's retried an hour later. Back up now, download any backup,
  and (owner only) restore one from the same page.

- **Point-in-time recovery.** Roll the whole database back to any moment in the last 30
  days, for example after an accidental bulk delete. Message files that were deleted in
  that window are kept for 30 days, so restored messages still open.
- **Download export.** A portable, streamed copy of the database (newline-delimited
  JSON). You can restore it here, on another deployment, or on a self-hosted install.
- **Restore from export.** Replaces all data with an export, then signs everyone out.
  If the restore fails part-way, the database is rolled back automatically.

Message files stay in R2 in every case.

## What needs a Cloudflare deployment

Everything runs in the Worker. Two features are part of Cloudflare's network, so a
self-hosted copy ([self-hosting.md](self-hosting.md)) uses a provider such as Resend
instead:

- **Email Routing** (incoming mail to the `email()` handler) and **Email Service**
  (the `send_email` binding).
- **Point-in-time recovery** of the Durable Object.

Desktop mail apps (Outlook, Apple Mail) can't connect: Workers can't accept incoming SMTP
or IMAP connections. Use the web app, which works on phones too.

## How it works / limits

- **One Durable Object, one database.** Every request goes to a single SQLite-backed
  Durable Object named `wren`. That gives strong consistency, real transactions and
  FTS5 full-text search. It handles thousands of mailboxes comfortably; a Durable
  Object can store up to 10 GB of SQLite data. Message bodies and attachments live
  in R2, which has no practical limit.
- **No R2?** Remove the `[[r2_buckets]]` block and Wren stores files inside the
  Durable Object instead. That's fine for small mailboxes.
- **Background work** (undo/scheduled send, retries with backoff, snooze wake-ups,
  retention) runs on Durable Object alarms. A 5-minute cron trigger acts as a safety net.
- **Durable Object limits are handled for you.** Very large message bodies (over 256 KB)
  go to R2 instead of the 2 MB SQLite row, and queries never exceed the 100-parameter
  limit, so bulk actions on thousands of conversations work.
- **Inbound limit:** Email Routing accepts messages up to 25 MiB.
