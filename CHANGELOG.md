# Changelog

## Unreleased

**Attachment policy.** Settings → Spam & blocking has a list of risky attachment types
(by default the executables that already added to the spam score) and what to do with
mail carrying one: add to its spam score (as before), always put it in Spam, or refuse it,
which shows in the inbound log with the reason. Every attachment is checked by its last
extension, so `invoice.pdf.exe` counts as `.exe`.

**DMARC reports for admins.** The aggregate reports that Gmail, Outlook and others send
to `postmaster@` your domain (as gzip, zip or XML attachments) are read on arrival.
Admin → DMARC reports shows each domain's pass rate, DKIM and SPF alignment, and the
sources failing both. Reports sent twice are kept once and are pruned after 180 days.
The report email itself is delivered as before.

**Domain footers.** Admins can give a domain a plain-text footer (a disclaimer, say) in
the domain editor. It is added once to the end of mail sent from that domain, in the
text and HTML parts and in the Sent copy, and comes off again on undo send. PGP-signed
or encrypted mail, private links and system mail never get it.

**Legal hold.** An admin can put a mailbox on legal hold from its page in Admin → Users,
with an optional note; placing and releasing it are in the audit log. Until it's released,
none of that person's mail is permanently deleted: Trash and Spam aren't emptied, "Delete
forever", "Empty trash" and mail apps' deletes are refused, expired or withdrawn private
links keep their content, and the account can't be deleted by them or by an admin. They
can still move mail to Trash and discard drafts, and only see "This mailbox can't be
permanently deleted right now". The users list shows a badge and an "On legal hold" filter.

**Sign-in history for admins.** Every sign-in attempt on an existing account (password,
passkey, 2-step code, reset link; success or failure) is kept for 90 days with its IP,
country (from Cloudflare) and browser. A user's page lists the last 50, and a successful
sign-in is marked **new location** when that person hadn't signed in from its country (or,
without one, its /24 or /48 network) in 90 days. The Overview shows failed sign-ins in the
last day and new-location ones in the last week, with whose.

**Admin IP allowlist.** **Admin → Settings → Security** can limit the admin panel to IP
addresses and CIDR ranges (IPv4 and IPv6), for every role. Wren shows your current IP and
won't save a list that leaves it out. Locked out anyway: set
`WREN_IGNORE_ADMIN_IP_ALLOWLIST=1`, fix the list, and remove the variable (see README).

**Sending pauses on unusual activity.** A compromised-account guard pauses someone's
sending when they go over an hourly limit (100 messages by default) or when 20% of the
last day's mail hard-bounced (once they've sent 20). Sends from the web, mail apps and
API keys are refused and queued or scheduled mail is held; reading and receiving keep
working and the person sees a notice. Admins get an alert and resume sending, or pause
it by hand, from the person's page. Settings → Limits has the switch and thresholds.

**Helpdesk role.** Admins can make someone helpdesk staff in Admin → Users. Helpdesk staff
open an admin panel with only Users and Invites, and can do account support for ordinary
users: unlock, sign out, reset 2-step verification and passkeys, send a password reset or
sign-in link, set a password, and suspend or reactivate. Every other admin route refuses
them, as does any action on an admin, owner or other helpdesk account. Their actions are
in the audit log under their name. "Require 2-step verification for administrators" now
covers helpdesk staff too.

## v0.5.1 — a code to open private links; security fixes

**Private links need a code.** Opening a private link now works like Gmail's confidential
mode passcode. The page shows only who sent the message and asks for the address it was
sent to. If that address was in To, Cc or Bcc, Wren emails it a 6-digit code, and
entering the code opens the message in that browser for an hour. This is always on,
including for links sent before the upgrade.
- A code works once, for 10 minutes and 5 tries, and only for the address it was sent
  to. Wren stores only a keyed hash of it.
- Any address gets the same answer, so the link can't be used to find out who else got
  the message. Asking for codes is rate-limited.
- Stop sharing, or the link running out, also ends every code and open browser.

**Private links start counting at delivery.** A private link's time now starts when the
first recipient accepts the message, not when it is queued. The notice says "7 days after
delivery" instead of a date, and the original stays in Sent until then, so a failed or
retried delivery no longer eats into the time or loses the message.

**Security fixes.**
- **Self-hosted:** the public server now refuses Wrangler's internal endpoints
  (`/cdn-cgi/*`, `/__scheduled`) however the path is encoded.
- **Sign-in:** someone who still has to choose a new password or set up 2-step
  verification can reach only those steps, not the rest of Settings. API keys follow the
  same rule.
- **Calendar:** an invitation can only add or change an event, or be answered, when it
  comes from its organizer and doesn't fail DMARC.
- **Tracking:** pictures in CSS backgrounds and `url()` (including escaped ones) now go
  through the same tracker and remote-image blocking as normal pictures, and remote
  stylesheets (`@import`) never load.

**Stored files.** Wren now remembers what each stored file should contain, and refuses a
file in the bucket that was swapped or copied from another one. A message whose full body
can't be read now says so instead of quietly showing a shortened copy, and can't be
edited or sent until the storage or key is back. Details:
[docs/cloudflare.md](docs/cloudflare.md).

**Smaller fixes.** "Sign" in Compose is remembered when a draft is saved, reopened or
the send is undone.

**Under the hood.** Dependency updates (postal-mime, zod, React, Vite, Vitest, Wrangler
and others).

**Upgrading.** Redeploy; the database updates (migrations 21 to 24) run by themselves.
Calendar invitations are re-read once, and existing stored files are enrolled in the
integrity check in the background. Everyone stays signed in.

## v0.5.0 — privacy, PGP, calendar, private links; more for mail apps

**Privacy when reading.**
- **Link trackers are cleaned.** Tracking bits (`utm_*`, `fbclid`, `gclid` and the like)
  are taken off links in mail you receive, and known redirect wrappers (Google, Outlook
  SafeLinks, Facebook and others) are unwrapped, so a link goes straight where it says.
  Hovering shows the real address, and a link whose text names a different site asks
  before opening.
- **Tracking pixels are blocked.** Tiny or hidden images and images from well-known
  trackers never load, even with images turned on, and the email says how many were
  blocked ("3 trackers blocked").
- **Sent mail doesn't name Wren.** The `X-Mailer` header is gone, so recipients no longer
  see which app or version you use. Forwarded mail now carries `X-Forwarded-By`.

**Encrypted mail files.** Raw messages, attachments, very large bodies, profile pictures,
backups and exports are now encrypted in storage (AES-256-GCM, with a key from
`WREN_SECRET` or the key Wren generated), and named so the storage bucket alone shows
nothing about them. Downloads come out as normal, readable files.
- Files stored before the upgrade are encrypted in the background; **Admin → System**
  shows how many are left.
- The owner can see the generated key in **Admin → System → Show key** (password and
  2-step code needed). Keep a copy somewhere safe: moving to another deployment, or
  restoring a stored backup there, needs it.
- If the key changes, Wren warns in the admin panel. Put the original key back, or
  choose **Use the current key** to carry on without what the old key protected.
  Details: [docs/cloudflare.md](docs/cloudflare.md) and
  [docs/self-hosting.md](docs/self-hosting.md).

**PGP.** Settings → Encryption: create or import a PGP key, publish your public key so
others on your server can write to you encrypted, and save other people's keys. Your
private key stays in this browser only, for each account. Encrypted mail (inline and
PGP/MIME) is decrypted in the browser, and signatures are checked. Compose has
**Encrypt** and **Sign**; drafts and the outbox only ever hold the encrypted text.

**Delete your account.** Settings → Security → **Delete your account**, with a reminder
to download your mail first, your password and your 2-step code if that's on. Its mail
goes and its addresses are freed. An admin can turn this off in Admin → Settings &
policies → Security → **People can delete their own account** (on by default). The last
owner or admin can't delete themselves.

**Calendar.** A new Calendar page: a month view (an agenda on phones) with the
invitations in your mail, your answer to each and any cancellations, plus events you add
yourself. Events download as .ics. It works for shared mailboxes too.

**Private links.** Compose → **Send as private link**, for 1 day, 1 week or 1 month.
Recipients get a link to the message instead of the message itself; it stops working when
the time is up, and you can **Stop sharing** sooner. The content is deleted once it
expires.

**Mail apps (JMAP).**
- **Shared mailboxes.** Each shared mailbox you belong to shows as another account in
  your mail app, with its own mail and push. Sending from it follows the same rules as in
  the web app, and removing someone from it stops their app at once.
- **Scheduled send.** Apps that support it (FUTURERELEASE) can send later, up to a year
  ahead. Scheduled mail shows in the web app's Scheduled folder, and cancelling it from
  either side turns it back into a draft.
- **Snooze.** Snoozed mail is in a Snoozed mailbox in apps, and moving it out un-snoozes
  it. Apps that speak Fastmail's snooze extension can also snooze and change the time.
  Details: [docs/jmap.md](docs/jmap.md).

**Under the hood.** One new dependency, `openpgp`, loaded only when PGP is used.

**Upgrading.** Redeploy; the database updates (migrations 16 to 20) run by themselves,
and existing mail files are encrypted in the background. If Wren generated its own key,
copy it from **Admin → System → Show key** and keep it safe. Everyone stays signed in.

## v0.4.0 — several accounts in one browser; mail apps

**Several accounts.** Sign in to more than one account on your Wren server in the same
browser and switch between them, like Gmail. Your picture (top right) lists your other
accounts, each with its unread count; tap one to open it. **Add another account** signs
in to one more without signing out (up to 10 per browser). From there you can also
create an account, if your server allows it, and an invitation link now works while
you're signed in. An alias is another address on the same account; this is for
separate accounts.
- Each account has its own address in the app: the first one at `/inbox` as before, the
  others at `/u/<id>/inbox`. Tabs of different accounts can be open side by side, and
  with several accounts the tab title says whose tab it is.
- A tab always acts as its own account. If that account is signed out somewhere else,
  the tab asks you to sign in again, or to carry on with an account still signed in,
  instead of showing another account's mail.
- **Notifications for every account.** The device gets new-mail notifications for each
  account signed in on it, and each one says which account the mail is for; tapping it
  opens that account. A device that already gets notifications turns them on for an
  account you add, and each account can turn them off in Settings → General →
  Notifications. Without push, an open tab also tells you about new mail for your other
  accounts. The app icon's count adds up the unread mail of all of them.
- **Signing out.** Your picture has **Sign out of this account** and **Sign out of all
  accounts**. Signing out of an account stops this device's notifications for it and
  clears what was saved for it on the device; the other accounts stay signed in. When
  the first account signs out, the next one takes its place at `/inbox`.
- Each account keeps its own offline copy on the device.
- A sign-in waiting for its 2-step code waits on its own and signs no one out, and "Use
  a different account" only gives up that sign-in.

**Mail apps (JMAP).** Wren now speaks JMAP (RFC 8620, 8621 and 9425), the modern open
protocol for mail apps, so apps that support it can read, search, organize and send your
mail, with live push. It works over HTTPS, so it runs on Cloudflare Workers.
- An admin turns it on for everyone: Admin → Settings & policies → Security → **Let
  people use mail apps (JMAP)**. It stays off until then.
- To leave one person out, turn off **Allow mail apps** on their page in Admin → Users.
  Their app passwords stop working at once, and work again when it's turned back on.
- Each app signs in with its own app password (Settings → Security → Mail apps), never
  the account password. App passwords work with 2-step sign-in on and can be revoked one
  by one.
- Folders, labels, read, starred and important, conversations, search, drafts, sending,
  the out-of-office reply and storage quota all carry over. Shared mailboxes aren't
  available to apps yet. Setup and details: [docs/jmap.md](docs/jmap.md).

**Under the hood.** Dependency updates (Hono, postal-mime, Vite, Wrangler and others),
and CI on the latest GitHub Actions.

**Upgrading.** Redeploy; the database updates (migrations 13 to 15) run by themselves.
Everyone stays signed in, and devices that get notifications keep getting them.

## v0.3.1 — profile and sender pictures; iPhone fixes

**Profile pictures.** Settings → General → Profile picture: upload one (it's cropped to a
square on your device first) or remove it. Everyone on your Wren server sees it next to
your mail, in the inbox and in conversations.

**Sender pictures.** People who write to you show a picture instead of initials when
there is one:
- their profile picture, if they're on your server;
- otherwise their Gravatar;
- otherwise, for a company, the verified logo it publishes for its mail (BIMI). That's
  what Gmail and Yahoo show, and it's only used when the company's DMARC turns away
  forgeries.

Gmail and Yahoo don't share their users' own photos, so those can't be fetched. The
server makes the lookups, not your device, and remembers the answers for a week. Mail
that fails the sender checks never shows a picture or logo. Turn it off in Settings →
General → Sender pictures.

**Fixes.**
- With "Ask before displaying external images" on, some emails stayed cut off at the
  top on an iPhone until you left the app and came back. iOS hadn't laid the email out
  yet when Wren first measured it. The message area now keeps checking until it has the
  email's real size.
- Settings could be swiped sideways on a phone. The vacation responder's two date
  fields, side by side, were wider than the screen, because iOS draws date fields at
  their full natural width. Date and time fields, and forms, now always fit the screen.

**Upgrading.** Redeploy; the database update (migration 12, additive) runs by itself.

## v0.3.0 — packages, private pictures, manage subscriptions

**Packages.** Shipping mail ("Your order has shipped", "Delivered: …", a forwarder's
"Package status update") shows a card at the top of the conversation, like Gmail's: the
item, the shop, where the package is ("Delivered · Tue, Oct 6", "Arriving tomorrow"), the
order and tracking numbers (tap to copy), and **View order** and **Track package**.
- Every email about the same package is put together: the shop's order confirmation, its
  shipping email and the courier's or forwarder's delivery notice make one card ("Based on
  3 emails"), matched by tracking number or by the shop's order number. On addresses many
  shops share (Gmail, Shopify's t.shopifyemail.com, where every store starts at #1001), an
  order number only matches mail from the same sender. A small shop's order confirmation
  joins the card once its shipping email arrives.
- **View order** opens the shop's own order page (Amazon, Walmart, Macy's, Target, Best Buy,
  eBay, Etsy, Temu, SHEIN, AliExpress, Nike, Costco, Home Depot, Chewy, Sephora, Nordstrom,
  Apple), or the order link in the shop's email. On a phone with the shop's app, that page
  opens in the app. **Track package** opens the carrier's page (UPS, USPS, FedEx, DHL,
  Amazon, OnTrac, Canada Post, Royal Mail; others through 17TRACK).
- Wren reads the order markup shops add for Gmail (schema.org), carrier tracking links, and
  tracking numbers it can check by their check digit (UPS 1Z…, USPS, international post),
  or ones labelled "Tracking number".
- The inbox row shows where the package is ("Arriving Thu", "Delivered").
- Links in the card only go to the sender's, the shop's or the carrier's own site. A sender
  that uses a shop's name from another domain is shown by its domain, and mail that failed
  DMARC gets no card.

**Packages page.** Packages in the sidebar lists everything on its way (soonest first) and
what was delivered in the last 60 days, each with View order, Track package and its emails.
Search `has:package` finds every shipping email.

**Package notifications.** A notification for shipping mail leads with where the package
is: "Out for delivery · Amazon", "Delivered · Macy's", with the item underneath (on the
phone and in the browser).

**Pictures without tracking.** When you show the pictures in an email, they now load
through Wren (like Gmail's image proxy): the sender sees Cloudflare fetch them, never your
IP address, device or browser. The Worker answers these itself, without the database: one
Worker request per picture, which your browser then keeps for a day. Only pictures from mail
Wren showed you are fetched, and only pictures are passed on. Product photos on package
cards load the same way. Self-hosted Wren loads pictures directly, as before.

**Manage subscriptions.** Subscriptions in the sidebar lists the newsletters and other list
mail you got in the last six months, the busiest senders first, with Unsubscribe and View
emails.

**Fixes.**
- On a phone, tab strips (Settings, Contacts, admin settings, logs) only slide sideways;
  they could be dragged up and down by a pixel. The chosen tab is scrolled into view.
- On a phone, admin page buttons (Users: Import CSV, Export CSV, Add user) and the accent
  colour picker (Admin → Settings) wrap onto a new line instead of running off the edge
  and letting the page slide sideways. On the smallest phones (320px) the provider cards
  and the System page fit too. Every mail, settings and admin page was checked at 390,
  360 and 320px wide.
- Tests: the automatic-backup retry test no longer fails between midnight and 03:00 UTC,
  and the catch-all list has a stable order (ties sorted by address).

**Upgrading.** Redeploy; the database update (migration 11, additive) runs by itself on the
first request. In the background, Wren then looks at the last 60 days of mail that arrived
before the upgrade, so its packages show on the Packages page and in the inbox; older mail
gets its card the first time it's opened.

## v0.2.3 — sign-in codes, remind me, offline, and emails that fit your phone

**Emails that fit your phone.** Some designed emails (newsletters, receipts, company
mail) showed only their top strip on an iPhone, inside a small box that scrolled both
ways. Now:
- The message area grows to the whole email, whatever the email's own page setup.
- An email's mobile layout (the styles in its `<head>`) is used.
- A fixed-width email (600–700px) is shrunk to fit the screen, like Gmail does.
- The area shrinks again when you hide the trimmed quoted text.
- An email sized to the screen height no longer makes it grow without end.

**Sign-in codes.** Emails carrying a one-time code ("980708 is your sign-in code") show
the code as a one-tap Copy button on the inbox row and at the top of the message, and
the notification leads with it. These emails go to Primary rather than Updates, unless
you've moved that sender to another tab.

**Remind me if no reply.** In a conversation you've sent in, ⋮ → "Remind me if no reply
tomorrow / in 3 days / in a week / by…". If nobody but you has written by then, your
message comes back to the top of the inbox, unread, marked "No reply · sent 3 days ago",
with Follow up (reply to all) and Done. A reply cancels the reminder.

**Mute and merge.** Mute a conversation (⋮ in the conversation or on a selection) and new
replies are archived instead of reaching the inbox, with no notification; unmute any
time. Select two or more conversations → ⋮ → Merge conversations to show them as one.

**Contact groups.** Contacts → Groups: name a group and add people. Type its name in To,
Cc or Bcc and it expands into everyone in it.

**Phishing.** ⋮ on a message → Report phishing moves that sender's mail in the
conversation to Spam and alerts admins. Mail that says it's from your own domain, didn't
come through Wren, and failed SPF, DKIM and DMARC shows a red warning.

**Phone.** Pull down on a mail list to refresh. Press and hold a row to select it.

**Offline.** Your inbox and recently opened conversations (up to 150) stay readable with
no connection, with a bar saying you're offline. Sending while offline queues the message
on the device; it goes out when you're back online, or is saved to Drafts if the server
refuses it. Signing out clears what was saved.

**Fixes.**
- Installed on an iPhone, the app's top row no longer sits flush under the status bar,
  where iOS blurred the logo and avatar into it.
- An open conversation now clears "Sending…" by itself once the message has gone out,
  instead of until you reload.

**Upgrading.** Redeploy; the database update (migration 10, additive) runs by itself on
the first request.

## v0.2.2

**Fix: replies to a new email now land in its conversation.** When you started a new
email, its conversation kept the subject from the first autosave (often blank or
half-typed). Replies to mail sent through Resend (or SES) refer to a Message-ID Wren never
saw, so Wren matches them by subject and people instead, and the stale subject made the
first reply start a separate conversation without your original email. Wren now matches
on the messages' own subjects and keeps a new conversation's subject current. Existing
conversations are repaired on upgrade, though replies already split off stay where they are.

**Upgrading.** Redeploy; the repair runs by itself on the first request.

## v0.2.1

README and screenshots for v0.2.0's features (a user's admin page, dark-mode email), and
a shorter "Require a new password" menu label that no longer gets cut off. No upgrade
steps.

## v0.2.0 — admin controls, plainer system mail, dark-mode email

**Admin.** Change a user's address (their sign-in name), optionally keeping the old one
as an alias; they get a note in their inbox. Unlock an account locked by wrong
passwords. Set an out-of-office reply and forwarding for someone who's away or has
left. Export a user's mail as `.mbox`. When deleting a user, hand their addresses and
catch-alls to another account so nothing bounces. Export the user list as CSV, with
locked-out accounts flagged. Only the owner can sign out or manage the owner account.
Require a new password at next sign-in (with a temporary password, for one person, or
in bulk); it's met by any password change, including a reset link.

**Mail.** "Did you mean to attach files?" before sending a message that says "see
attached" without any files. In dark mode, ordinary emails use dark colours (with
readable text whatever colours the sender set); designed emails such as newsletters
keep a white background, and each message can be flipped. Replying to your own message
goes to its recipients, never to an empty To.

**System mail and domains.** System emails are plain, with the link written out, so
they're less likely to land in spam; invites reply to the admin who sent them. A
sending-only subdomain (say contact.example.com) doesn't need MX, its DMARC comes from
the parent domain, and the domain page shows whether your provider has it verified.

**Upgrading from v0.1.0.** Redeploy; the database update runs by itself on the first
request (it only adds a column). No settings, secrets or DNS changes are needed.

## v0.1.0 — first public release

Wren is a Gmail-style webmail for your own domains that runs entirely on Cloudflare
Workers: one Worker, a SQLite Durable Object and R2. Send with Cloudflare Email Service
(no API key), Resend or 20+ other providers; receive with Email Routing or a provider's
inbound webhook.

**Mail.** Conversations, labels, stars, snooze, undo send, scheduled send, search
operators, keyboard shortcuts, dark mode. Primary / Updates / Promotions tabs, one-click
unsubscribe, meeting invitations with Yes / Maybe / No, attachment previews, saved
replies and searches, signatures per address, shared mailboxes.

**Addresses.** Mailboxes, aliases, groups, catch-alls and plus-addressing on any number
of domains; a "via" chip for mail that came through an alias; aliases you can turn off;
throwaway sign-up addresses; catch-all activity with block or make-an-alias.

**Phones.** Installable app (PWA) with Web Push notifications and swipe actions.

**Moving in and out.** Import from Gmail (Takeout), any IMAP account or `.mbox`; export
everything as `.mbox`; contacts from CSV or vCard.

**Admin.** Setup checklist with a round-trip test, one-click Cloudflare setup, DNS
checks, system mail from any hosted address (including a sending-only subdomain, with
its provider verification shown), users with quotas and bulk actions, invites, delivery logs, delivery status and
a suppression list from every provider (webhooks or bounce emails), alerts, daily
backups to R2, point-in-time recovery, audit log.

**Security.** scrypt passwords, passkeys, TOTP 2-step verification, new-device sign-in
alerts, encrypted provider secrets, CSP and sandboxed message rendering.
