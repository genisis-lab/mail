# Deploy Wren on Cloudflare Workers

This is the recommended way to run Wren. One Worker serves the web app and API.
It receives mail through **Email Routing** and sends it through **Email Service**
(or any other API provider). There are no servers, ports or TLS certificates to
manage.

```
Browser ─► Worker ─► Static assets (the Gmail-style app)
              └────► /api/* ─► WrenDurableObject ─► SQLite (users, mail index, search)
                                      │           └► R2 (raw messages, attachments)
                                      └► alarms ─► send queue, snoozes, retention
Email Routing ─► Worker email() handler ─► WrenDurableObject.receiveEmail()
```

## What you need

- A Cloudflare account with your domain on Cloudflare DNS (required for Email Routing).
- **Workers Paid** ($5/month) is recommended. Password hashing needs more than the
  free plan's 10 ms of CPU per request, and Durable Object alarms do the background sending.
- R2 enabled on the account. The free tier covers 10 GB.
- Node.js 22+ locally.

## 1. Deploy

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install
npx wrangler login

npx wrangler r2 bucket create wren-mail           # message bodies & attachments
openssl rand -base64 32 | npx wrangler secret put WREN_SECRET   # encrypts provider credentials

npm run cf:deploy                                  # builds the web app and deploys
```

Open the `*.workers.dev` URL that wrangler prints. The **setup wizard** asks for an
instance name, your first domain and the owner account.

> **Keep `WREN_SECRET` safe.** It encrypts provider API keys stored in the database.
> If you lose it, you'll need to re-enter those credentials.

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
| Resend, Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Mailjet, SparkPost, MailerSend, MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway, Postal, custom webhook | All of these are HTTP APIs, so they work on Workers. Follow the setup notes shown in Wren for each one. |

Raw SMTP relays (Gmail, Fastmail…) need TCP sockets and are only available in the
Docker/Node build.

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
cp .dev.vars.example .dev.vars   # set WREN_SECRET
npm run cf:dev                   # http://localhost:8787 on the real Workers runtime (workerd)

# Deliver a test message through the email() handler:
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@example.org&to=you@example.com' \
  --data-binary @message.eml
```

Durable Object, R2 and alarm state persist locally under `.wrangler/`.

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
- **Backups:** Durable Objects keep 30 days of point-in-time recovery automatically.
  **Admin → System & backup** also downloads a portable JSON export.
- **Inbound limit:** Email Routing accepts messages up to 25 MiB.
