# Email providers

Wren separates **mail hosting** (mailboxes, aliases, groups, search, the UI) from
**mail transport** (who actually sends and receives on the internet). Add providers in
**Admin → Providers**, then assign one per domain, with an optional fallback, or mark
one as the default.

Every provider gets a secret **inbound URL** (`/api/inbound/<token>`). Providers that
can deliver incoming mail to a webhook post to that URL. Credentials are encrypted at
rest with `WREN_SECRET`.

| Provider | Send | Receive | Runs on | Notes |
|---|:-:|:-:|---|---|
| Cloudflare Email Service | ✅ REST `send_raw` | ✅ Email Routing | Workers, Node | On Workers, inbound needs no webhook (the Worker's `email()` handler). On Node, use `integrations/cloudflare-email-worker`. |
| Cloudflare Email (Workers binding) | ✅ | — | Workers | `[[send_email]]` binding, no token. |
| Resend | ✅ | ✅ `email.received` | Workers, Node | Verifies Svix signatures and downloads the original raw message. |
| Amazon SES (v2) | ✅ raw MIME, SigV4 | ✅ SNS / S3 | Workers, Node | Auto-confirms SNS subscriptions and can restrict to one topic ARN. |
| Postmark | ✅ | ✅ inbound webhook | Workers, Node | Enable "include raw email" for full fidelity. |
| SendGrid | ✅ | ✅ Inbound Parse | Workers, Node | Tick "POST the raw, full MIME message". |
| Mailgun (US/EU) | ✅ raw MIME | ✅ Routes | Workers, Node | Use `forward("<url>/mime")`; verifies the signing key. |
| SparkPost (US/EU) | ✅ raw RFC 822 | ✅ relay webhooks | Workers, Node | Checks the relay auth token. |
| Brevo | ✅ | ✅ inbound parsing | Workers, Node | Downloads attachments with the API key. |
| Mailjet | ✅ | ✅ Parse API | Workers, Node | |
| MailerSend | ✅ | — | Workers, Node | |
| MailChannels | ✅ | — | Workers, Node | Optional DKIM signing with your own key. |
| SMTP2GO | ✅ raw MIME | — | Workers, Node | |
| ZeptoMail (Zoho) | ✅ | — | Workers, Node | All data centres. |
| Elastic Email | ✅ | — | Workers, Node | |
| Mailtrap | ✅ | — | Workers, Node | Transactional or bulk stream. |
| Scaleway TEM | ✅ | — | Workers, Node | |
| Postal (self-hosted) | ✅ raw MIME | ✅ HTTP endpoint | Workers, Node | |
| Custom HTTP webhook | ✅ signed JSON | ✅ generic JSON | Workers, Node | `X-Wren-Signature: sha256=HMAC(body)`. |
| Raw MIME (HTTP) | — | ✅ | Workers, Node | For MTA pipes and scripts. |
| ForwardEmail | — | ✅ | Workers, Node | |
| CloudMailin | — | ✅ | Workers, Node | JSON-normalized or raw format. |
| SMTP relay (Gmail, M365, Fastmail, Zoho, iCloud, Postfix…) | ✅ | — | Node only | Includes presets for common hosts. |
| Log only (testing) | ✅ | — | Workers, Node | Records the message in the log without delivering it. |

## Delivery behaviour

- Mail to other mailboxes on your own domains is always delivered internally.
- Temporary failures retry with backoff (30 s, 2 m, 10 m, 30 m, 1 h, 2 h, 4 h; the
  limit is configurable). If the primary provider fails, the fallback provider is
  tried immediately.
- Permanent failures put a *Delivery Status Notification* in the sender's inbox,
  threaded with the original. The admin can retry from **Mail queue**.
- Raw-MIME providers keep Wren's exact message (and Message-ID). JSON providers get
  structured fields plus the threading headers (`In-Reply-To`, `References`).

## Adding a provider

Create `src/server/providers/outbound/<name>.ts` exporting a `ProviderDefinition`:
metadata, `fields`, and `send()` and/or `receive()`. Register it in
`providers/registry.ts`. The admin UI builds its form from `fields` automatically.
