# Email providers

Wren separates **mail hosting** (mailboxes, aliases, groups, search, the UI) from
**mail transport** (who actually sends and receives on the internet). Add providers in
**Admin → Providers**, then assign one per domain, with an optional fallback, or mark
one as the default.

Every provider gets a secret **inbound URL** (`/api/inbound/<token>`). Providers that
can deliver incoming mail to a webhook post to that URL. Credentials are encrypted at
rest. Mail that arrives through Cloudflare Email Routing needs no provider at all.

| Provider | Send | Receive | Notes |
|---|:-:|:-:|---|
| **Cloudflare Email Service** (recommended) | ✅ `send_email` binding | ✅ Email Routing | Built into Workers: no API key. Onboard the domain in Email Sending. Email Routing delivers to the Worker's `email()` handler, so no webhook is needed. |
| **Resend** | ✅ | ✅ `email.received` | Paste the API key in the setup wizard. Inbound verifies Svix signatures and downloads the original raw message. Or receive with Email Routing. |
| Cloudflare Email Service (API token) | ✅ REST `send_raw` | — | For sending through another Cloudflare account. |
| Amazon SES (v2) | ✅ raw MIME, SigV4 | ✅ SNS / S3 | Auto-confirms SNS subscriptions and can restrict to one topic ARN. |
| Postmark | ✅ | ✅ inbound webhook | Enable "include raw email" for full fidelity. |
| SendGrid | ✅ | ✅ Inbound Parse | Tick "POST the raw, full MIME message". |
| Mailgun (US/EU) | ✅ raw MIME | ✅ Routes | Use `forward("<url>/mime")`; verifies the signing key. |
| SparkPost (US/EU) | ✅ raw RFC 822 | ✅ relay webhooks | Checks the relay auth token. |
| Brevo | ✅ | ✅ inbound parsing | Downloads attachments with the API key. |
| Mailjet | ✅ | ✅ Parse API | |
| MailerSend | ✅ | — | |
| MailChannels | ✅ | — | Optional DKIM signing with your own key. |
| SMTP2GO | ✅ raw MIME | — | |
| ZeptoMail (Zoho) | ✅ | — | All data centres. |
| Elastic Email | ✅ | — | |
| Mailtrap | ✅ | — | Transactional or bulk stream. |
| Scaleway TEM | ✅ | — | |
| Postal (self-hosted) | ✅ raw MIME | ✅ HTTP endpoint | |
| SMTP relay (Gmail, Microsoft 365, Fastmail, Zoho, iCloud, provider SMTP…) | ✅ | — | Workers TCP sockets on port 587 (STARTTLS) or 465 (TLS); Cloudflare blocks port 25. Presets for common hosts. |
| Custom HTTP webhook | ✅ signed JSON | ✅ generic JSON | `X-Wren-Signature: sha256=HMAC(body)`. |
| Raw MIME (HTTP) | — | ✅ | For MTA pipes and scripts. |
| ForwardEmail | — | ✅ | |
| CloudMailin | — | ✅ | JSON-normalized or raw format. |
| Log only (testing) | ✅ | — | Records the message in the log without delivering it. |

## Delivery behaviour

- Mail to other mailboxes on your own domains is always delivered internally.
- Temporary failures retry with backoff (30 s, 2 m, 10 m, 30 m, 1 h, 2 h, 4 h; the
  limit is configurable). If the primary provider fails, the fallback provider is
  tried immediately.
- Permanent failures put a *Delivery Status Notification* in the sender's inbox,
  threaded with the original. The admin can retry from **Mail queue**.
- Raw-MIME providers keep Wren's exact message (and Message-ID). JSON providers get
  structured fields plus an allowlist of headers: threading (`In-Reply-To`,
  `References`), `Auto-Submitted`, `List-Unsubscribe`, and Wren's `X-Wren-Roundtrip`
  marker for the admin round-trip test.
- The round-trip test also carries its code in the message body, and a test that comes
  back from your own address with the test subject counts too, so it works with every
  provider, including ones that drop custom headers (MailerSend without its paid-plan
  header option). `tests/roundtrip-providers.test.ts` checks every registered provider.

## Adding a provider

Create `src/server/providers/outbound/<name>.ts` exporting a `ProviderDefinition`:
metadata, `fields`, and `send()` and/or `receive()`. Register it in
`providers/registry.ts`. The admin UI builds its form from `fields` automatically.
