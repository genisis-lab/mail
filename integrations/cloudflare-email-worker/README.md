# Cloudflare Email Routing → Wren (Docker/Node deployments)

> **Running Wren itself on Cloudflare Workers?** You don't need this: Wren's own Worker
> has an `email()` handler. Point Email Routing at the `wren` Worker. See `docs/cloudflare.md`.

This tiny Worker lets Cloudflare receive mail for your domain and pass it to Wren.
Pair it with the **Cloudflare Email Service** provider in Wren for sending, and you
have a complete setup with no SMTP server to run.

## Setup

1. In Wren, go to **Admin → Providers → Add provider → Cloudflare Email Service**.
   Enter your account ID and an API token that can send email, then save. Copy the **inbound URL**.
2. In the Cloudflare dashboard, enable **Email Routing** for the domain. Cloudflare adds the MX
   and SPF records for you.
3. Deploy this Worker:

   ```bash
   cd integrations/cloudflare-email-worker
   npx wrangler deploy
   npx wrangler secret put WREN_INBOUND_URL   # paste the inbound URL from step 1
   ```

4. In **Email Routing → Routing rules**, set the **catch-all** action to *Send to a Worker* →
   `wren-email-router`. You can also route only specific addresses.
5. Send a test message to an address on your domain. It should show up in Wren within seconds.
   **Admin → Delivery logs → Inbound** shows every message the Worker delivered.

## Behaviour

| Wren response | What the sender sees |
|---|---|
| 200, at least one recipient accepted | Delivered |
| 200, every recipient unknown | `550 5.1.1` bounce (no silent drops) |
| 4xx | Permanent rejection |
| 5xx / network error | Temporary failure, so the sender retries. If `FALLBACK_FORWARD` is set, the message is forwarded there instead. |

Cloudflare Email Routing accepts messages up to 25 MiB.
