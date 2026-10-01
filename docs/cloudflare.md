# Deploy Wren on Cloudflare Workers

This is the recommended way to run Wren, and it needs no Docker or server. One Worker
serves the web app and API. It receives mail through **Email Routing** and sends it
through **Email Service**, any other API provider, or an SMTP relay. There are no
servers, ports or TLS certificates to manage.

```
Browser ─► Worker ─► Static assets (the Gmail-style app)
              └────► /api/* ─► WrenDurableObject ─► SQLite (users, mail index, search)
                                      │           └► R2 (raw messages, attachments)
                                      └► alarms ─► send queue, snoozes, retention
Email Routing ─► Worker email() handler ─► WrenDurableObject.receiveEmail()
```

## What you need

- A Cloudflare account with your domain on Cloudflare DNS (required for Email Routing).
- **Workers Paid** ($5/month). Password hashing needs more than the free plan's 10 ms of
  CPU per request, and Durable Object alarms do the background sending.
- R2 enabled on the account. The free tier covers 10 GB.
- Node.js 22+ locally.

## 1. Deploy

**One click:** use the *Deploy to Cloudflare* button in the README. Cloudflare copies the
repository to your GitHub account, creates the R2 bucket and Durable Object, and deploys.

**From the command line:**

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install
npx wrangler login

npx wrangler r2 bucket create wren-mail           # message bodies & attachments
npm run deploy                                     # builds the web app and deploys
```

Open the `*.workers.dev` URL that wrangler prints. The **setup wizard** asks for an
instance name, your first domain and the owner account.

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

In **Workers & Pages → wren → Settings → Domains & Routes**, add a custom domain
such as `mail.example.com`. Wren uses the hostname each request arrives on to build
inbound webhook URLs. To pin it explicitly, set `PUBLIC_URL` under `[vars]` in
`wrangler.toml`.

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

Choose one provider in **Admin → Providers → Add provider**, then assign it to your
domain or make it the default.

| Option | Setup |
|---|---|
| **Cloudflare Email Service (REST API)**, recommended | In the dashboard, open **Email Service → Email Sending** and onboard the domain (Cloudflare adds the DKIM/SPF records). Create an API token with *Email Sending: Send* permission. In Wren, enter the account ID and token, then **Send test email**. |
| **Cloudflare Email (Workers binding)** | Uncomment the `[[send_email]]` block in `wrangler.toml` and redeploy. Then add the *Cloudflare Email (Workers binding)* provider. No token is needed. |
| Resend, Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Mailjet, SparkPost, MailerSend, MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway, Postal, custom webhook | HTTP APIs. Follow the setup notes shown in Wren for each one. |
| **SMTP relay** (Gmail / Google Workspace, Microsoft 365, Fastmail, Zoho, iCloud, SES/SendGrid/Mailgun SMTP…) | Uses Workers TCP sockets. Choose port **587** (STARTTLS) or **465** (TLS); Cloudflare blocks outbound port 25. Certificates are always verified. |

Mail between users on your own domains never leaves the Durable Object, so it's
instant and free.

## 4. Recommended DNS

**Admin → Domains → your domain** lists every record and has a **Check DNS** button
(it queries over DNS-over-HTTPS):

- `_wren.example.com TXT wren-verify=…`: proves ownership.
- SPF and DKIM: added by Cloudflare when you onboard Email Sending (selector `cf2024-1`).
- DMARC: `_dmarc.example.com TXT "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"`.

## Local development

```bash
npm run cf:dev                   # http://localhost:8787 on the real Workers runtime (workerd)

# Deliver a test message through the email() handler:
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@example.org&to=you@example.com' \
  --data-binary @message.eml
```

Durable Object, R2 and alarm state persist locally under `.wrangler/`. Point-in-time
recovery is only available once deployed.

## Backups

**Admin → System & backup** has three tools:

- **Point-in-time recovery.** Roll the whole database back to any moment in the last 30
  days, for example after an accidental bulk delete. Message files that were deleted in
  that window are kept for 30 days, so restored messages still open.
- **Download export.** A portable, streamed copy of the database (newline-delimited
  JSON). It works the same on Docker, so you can also use it to move between the two.
- **Restore from export.** Replaces all data with an export, then signs everyone out.
  If the restore fails part-way, the database is rolled back automatically.

Message files stay in R2 in every case.

## Feature parity with Docker

Everything in the Docker build works on Workers, with the same code, except one feature
that would need a listening TCP port:

| Docker / Node.js | On Workers |
|---|---|
| Built-in SMTP server (MX → Wren) | Email Routing delivers to the Worker's `email()` handler. Domains outside Cloudflare DNS can use a provider's inbound webhook. |
| SMTP relay providers | ✅ Supported on ports 587 and 465. |
| SQLite snapshot download | Export + 30-day point-in-time recovery. |
| `data/.secret` auto-generated key | Generated automatically and stored in the Durable Object. |
| SMTP submission for desktop mail clients | Not possible: Workers can't accept inbound TCP connections. Use the web app (it works on mobile too). |

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
