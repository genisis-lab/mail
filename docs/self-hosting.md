# Self-hosting Wren with Docker or Node.js

Prefer Cloudflare? See [cloudflare.md](cloudflare.md). It's the recommended setup and
needs no Docker or server.

Run the Node.js build when you want your own server. It has everything the Workers build
has, plus a built-in **SMTP server** (point your MX straight at Wren) and **SMTP
submission** for desktop mail clients. Workers can't listen on TCP ports, so these two
are the only Docker-only features. Data is stored in SQLite plus a directory of files.

## Docker Compose

```bash
cp .env.example .env        # set PUBLIC_URL, WREN_SECRET, SMTP_HOSTNAME
docker compose up -d --build
```

Open `http://your-server:3000` and complete the setup wizard. Put a TLS reverse proxy
in front of port 3000. Example `Caddyfile`:

```
mail.example.com {
  reverse_proxy localhost:3000
}
```

Set `TRUST_PROXY=true` when running behind a proxy.

### Volumes

Everything lives in `/data`:

- `wren.db`: the SQLite database.
- `blobs/`: raw messages and attachments.
- `.secret`: the generated `WREN_SECRET`, if you didn't set one.

Back up the whole directory. **Admin → System & backup** also downloads a hot SQLite
snapshot or a portable export. You can restore an export here or on a Cloudflare
deployment. To keep provider credentials and 2FA when you move, set `WREN_SECRET` on
the new instance to the old instance's key (from `data/.secret`).

## Receiving mail

Pick one approach per domain:

1. **Built-in SMTP.** Point `MX 10 mx.example.com` at the server and expose port 25.
   The compose file maps host port 25 to the container's port 2525. Set `SMTP_HOSTNAME`,
   and set `SMTP_TLS_KEY`/`SMTP_TLS_CERT` to enable STARTTLS. Many residential ISPs and
   clouds block port 25.
2. **A provider's inbound webhook.** Cloudflare Email Routing (with
   `integrations/cloudflare-email-worker`), Resend, Postmark, SendGrid, Mailgun, SES,
   SparkPost, Postal, Brevo, Mailjet, ForwardEmail or CloudMailin. Add the provider in
   **Admin → Providers**, copy its inbound URL, and follow the steps shown.
3. **Raw MIME pipe.** Any MTA can POST messages to a *Raw MIME* provider URL:
   `curl --data-binary @- -H 'Content-Type: message/rfc822' -H "X-Rcpt-To: $RECIPIENT" $URL`.

## Sending mail

Add any provider under **Admin → Providers** (all API providers, plus SMTP relays) and
assign it per domain, with an optional fallback provider.

## Desktop and mobile clients

Set `SUBMISSION_PORT=2587` and map host port 587 to it. Clients authenticate with the
account password, or with an API key (**Settings → Security**) when 2FA is enabled.
Wren stores sent messages in the Sent folder and delivers them through your provider.

## Environment variables

See `.env.example` for the full list: `PUBLIC_URL`, `WREN_SECRET`, `PORT`,
`TRUST_PROXY`, `DATA_DIR`, `SMTP_*`, `SUBMISSION_PORT`, `LOG_LEVEL`, `DNS_SERVERS`.

## Running without Docker

```bash
npm install
npm run build
NODE_ENV=production PUBLIC_URL=https://mail.example.com npm start
```

During development, `npm run dev` runs the API with reload alongside the Vite dev server.
