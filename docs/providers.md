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

## Sending from a subdomain

System mail (invites, setup and password links, alerts) can come from a subdomain such
as `contact.example.com` while people's mailboxes stay on `example.com`:

1. Set the subdomain up with your provider (in Resend: **Domains → Add domain**) and add
   the DNS records it shows.
2. In Wren, add it under **Admin → Domains**. Add the `_wren` TXT record the domain page
   shows, then press **Check DNS**. This is how Wren knows you own it. A subdomain with no
   addresses on it doesn't need an MX record, and the page says so.
3. Under **Admin → Settings → General → System emails**, set **Send from** to an address
   on it, for example `no-reply@contact.example.com`.

The domain page and the System emails card show whether your provider has the domain
verified. Resend, Mailgun, SendGrid, SparkPost, Brevo and MailerSend can be asked. A
Resend key that may only send can't list domains, so Wren tells you to check by hand.

## Delivery status, bounces and the suppression list

After a provider accepts a message, Wren still finds out what happened to it, and
an address that hard-bounces or reports spam isn't mailed again until an admin
removes it (**Delivery logs → Suppressions**). This works with every provider:

| How it arrives | Providers |
|---|---|
| The provider's event webhook, posted to the same secret URL as its inbound mail (**Admin → Providers → Delivery status** shows the URL and which events to tick) | Resend, Amazon SES (SNS), Postmark, SendGrid (signed webhooks verified when you paste the key), Mailgun (signing key), Brevo, Mailjet, SparkPost, MailerSend (signing secret), MailChannels, SMTP2GO, ZeptoMail, Elastic Email, Mailtrap, Scaleway TEM, Postal, and the custom HTTP webhook |
| Bounce messages (RFC 3464) and spam reports (RFC 5965, ARF) that come back to the sender | SMTP relays (Gmail, Microsoft 365, Fastmail…), Cloudflare Email Service, and any provider whose bounces come back by email |
| Refused at send time | SMTP servers that refuse some recipients while accepting the rest |

- Events are matched by the provider's message id or by the Message-ID, only for
  messages that went out through that provider, and only for the recipients the
  message actually had. Events for mail another app sent through the same account are
  ignored.
- A bounce that comes back by email counts only for the person who sent the original,
  and only an address that doesn't exist (5.1.x) is suppressed; a message refused for
  its content or by policy (5.7.x) is logged but the address stays.
- The sender gets a *Delivery Status Notification* in their inbox, threaded with the
  original (for bounces that came by email, the bounce itself is that notice).
- `tests/all-providers.test.ts` feeds every provider's real-shaped bounce webhook and
  checks the log and the suppression list.

## Meeting replies

Answering an invitation (Yes / Maybe / No) sends an iTIP REPLY as a
`text/calendar; method=REPLY` part. Raw-MIME providers send Wren's message as is;
JSON APIs get it as a calendar attachment with that content type. Brevo and MailerSend
have no content-type field for attachments, so there it goes as `invite.ics`, which
calendar apps generally still read. `tests/all-providers.test.ts` checks every provider.

## Adding a provider

Create `src/server/providers/outbound/<name>.ts` exporting a `ProviderDefinition`:
metadata, `fields`, and `send()` and/or `receive()`. Register it in
`providers/registry.ts`. The admin UI builds its form from `fields` automatically.
If the provider reports delivery status by webhook, add a parser and setup text in
`providers/events.ts`, and a case in `tests/all-providers.test.ts`.
