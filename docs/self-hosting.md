# Self-hosting (optional)

You don't need any of this: the recommended setup is a Cloudflare deployment
([cloudflare.md](cloudflare.md)), with no server and no Docker.

If you'd rather keep Wren on your own machine or server, run the **same Worker** locally
on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source Workers
runtime. There's no separate server codebase: the database is the same SQLite Durable
Object, background work runs on the same alarms, and the web app is identical.

## Setup from the terminal

```bash
git clone https://github.com/genisis-lab/mail wren && cd wren
npm install
npm run setup          # choose "Docker" or "your own machine"
```

### With Docker

```bash
docker compose up -d --build       # http://localhost:8787, data in ./data
```

Set `PUBLIC_URL` (the address people and providers use) and, behind a reverse proxy,
`TRUST_PROXY=1` in `.env`. `npm run setup -- docker` writes the file for you.

### Without Docker

```bash
npm run serve                      # http://localhost:8787, data in ./data
PORT=80 DATA_DIR=/srv/wren PUBLIC_URL=https://mail.example.com npm run serve
```

Put a TLS reverse proxy in front for HTTPS, for example Caddy:

```
mail.example.com {
  reverse_proxy localhost:8787
}
```

## Sending and receiving

Email Routing and Email Service are part of Cloudflare's network, so a self-hosted copy uses
a provider instead. In the setup wizard choose **Resend** and paste your API key.

- **Sending:** Resend, or any provider in Admin → Providers (SES, Postmark, SendGrid,
  Mailgun, SMTP relays such as Gmail or Microsoft 365…).
- **Receiving:** the provider's inbound webhook. For Resend, add the URL shown in
  Admin → Providers → Resend to Resend's `email.received` webhook. `PUBLIC_URL` must be
  reachable from the internet for that.

## Data and backups

Everything lives in `DATA_DIR` (`./data`, or the `/data` volume in Docker): the SQLite
database, message files, and the encryption key Wren generates on first start. Back up
that directory. **Admin → System & backup** also downloads a portable export, which you
can restore on a Cloudflare deployment if you move later.

Provider credentials and 2FA secrets in an export can only be read by an install with the
same `WREN_SECRET`. If you might move, choose your own `WREN_SECRET` from the start and use
it on both. Otherwise, after a restore you re-enter provider settings and users set up 2FA
again (Wren walks you through it).

## Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `DATA_DIR` | `./data` | Database, message files and key |
| `PUBLIC_URL` | request origin | Public address, used in webhook URLs |
| `TRUST_PROXY` | off | Use `X-Forwarded-For` for client IPs behind a reverse proxy |
| `WREN_SECRET` | generated | Encryption key (16+ characters) |

The launcher (`scripts/serve.mjs`) never exposes Wrangler's local `/cdn-cgi/` test
endpoints, so nobody can inject mail through them.
