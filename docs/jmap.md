# Mail apps (JMAP)

Wren speaks [JMAP](https://jmap.io), the modern open protocol for mail apps
(RFC 8620 and RFC 8621). It runs over HTTPS, so it works on Cloudflare Workers, where
IMAP can't (Workers don't accept raw TCP connections). Apps that only speak IMAP, such
as Apple Mail, Outlook or the Gmail app, can't connect.

## Turning it on

Mail apps are off until an admin turns them on: **Admin → Settings & policies →
Security → Let people use mail apps (JMAP)**. That turns them on for everyone. Turning
it off again locks every app out at once (their app passwords stay, and work again if
it's turned back on).

To leave one person out, open their page in **Admin → Users** and turn off **Allow mail
apps**. Their app passwords stop working right away, any push to their apps stops, and
they can't create new ones; everyone else is unaffected. The Users list marks them
"mail apps off". Turn it back on and their existing app passwords work again.

## Connecting an app

Wren has its own Mac app, which works this way: see [apps/macos](../apps/macos).

1. In Wren, open **Settings → Security → Mail apps** and create an app password, one
   per app or device.
2. In the app, enter:
   - **Server:** your Wren address, such as `https://mail.example.com` (apps find the
     rest at `/.well-known/jmap`; some ask for the session URL,
     `https://mail.example.com/jmap/session`)
   - **Username:** your email address (any of your own addresses works)
   - **Password:** the app password

Your account password never works in a mail app. An app password can only reach your
mail (not your account settings), works even with two-step sign-in on, and can be
revoked on its own from the same page. API keys for the HTTP send API can't be used as
app passwords, and app passwords can't be used with the send API.

## What apps see

| Wren | In a mail app |
|---|---|
| Inbox, Archive, Drafts, Sent, Spam, Trash | Mailboxes with the matching roles (`junk` for Spam) |
| Snoozed | A Snoozed mailbox (role `snoozed`): snoozed mail shows there instead of Inbox or Archive until it wakes |
| Labels | Mailboxes without a role. An email can be in one folder (or Snoozed) plus any number of labels. |
| Shared mailboxes you belong to | More accounts in the app, next to your own |
| Read, starred, important | The `$seen`, `$flagged` and `$important` keywords |
| Other keywords (`$answered`, `$forwarded`, your own) | Kept as they are; Wren marks the original `$answered` when you reply |
| Conversations | Threads |
| Search | `Email/query` filters: text, from, to, cc, bcc, subject, body, dates, sizes, keywords, attachments |
| Scheduled send | `EmailSubmission` held with `HOLDUNTIL` or `HOLDFOR` (FUTURERELEASE) |
| Out-of-office reply | `VacationResponse` |
| Storage used and allowed | `Quota` (RFC 9425) |
| Your addresses and signatures | `Identity` (read only; manage them in Wren) |

Apps can read mail, search, flag and move it, manage labels, write drafts with
attachments, send (now or later), snooze, and import messages. Changes made anywhere
(in the web app, by a filter, by another app) reach every app through `/changes` and
push.

**Shared mailboxes.** Each shared mailbox you're a member of is another account in the
session (`isPersonal: false`), with its own mail, labels, changes and push. Sending from
it works as in the web app: from the shared mailbox's own addresses, and only if an admin
lets you send from it (otherwise you can read and write drafts, and sending is refused
with `forbiddenToSend`); Wren records who sent each message. Shared mailboxes have no
quota or vacation reply of their own in apps. When an admin removes you, the account
disappears from the session and every request, download, upload and push for it stops
right away.

**Scheduled send.** Apps that support FUTURERELEASE (the session's `maxDelayedSend` and
`submissionExtensions`) can hold a message up to a year ahead with `HOLDUNTIL` or
`HOLDFOR` on the envelope's `mailFrom`. It goes into Wren's scheduled-send queue, shows in
the web app's Scheduled folder (and in Sent in apps), and its submission is `pending` until
it goes out. Cancelling it from the app (`undoStatus: "canceled"`) or the web app turns it
back into a draft. Sends without a hold go out right away, as before. (The web app has no
upper limit on how far ahead you schedule; apps need a number, so it's a year.)

**Snooze.** Snoozed mail is in the Snoozed mailbox. Taking it out (moving it to Inbox,
say) un-snoozes it. Apps that speak Fastmail's snooze extension (the
`https://cyrusimap.org/ns/jmap/mail` capability, as Cyrus IMAP names it) also see and set
the Email `snoozed` property, `{ "until": …, "moveToMailboxId": "inbox" }`, together with
the Snoozed mailbox: setting it snoozes, changing `until` moves the wake-up time, and
`null` (with the email taken out of Snoozed) wakes it. Snoozed mail always comes back to
the Inbox, unread, when its time comes, like snooze in the web app, so `moveToMailboxId`
can only be the Inbox and `setKeywords` isn't supported.

**Push.** Apps can register a push URL (`PushSubscription`); Wren sends a small state
change there whenever something changes, encrypted for the app (RFC 8291) when it gives
keys, and only after the app has confirmed the subscription. Subscriptions last up to 7
days and the app renews them. Apps can also hold an `EventSource` stream open; Wren
ends each stream after 15 minutes and the app reconnects.

**Not yet:** inbox tabs are web-only. Mailboxes don't nest, and `queryChanges` isn't
supported, so apps re-run their queries.

## Limits and safety

- 20 failed sign-ins from one IP address within 15 minutes block that address for the
  rest of the 15 minutes.
- Requests: up to 10 MB, 16 method calls and 500 objects per call; 4 requests and 4
  uploads at once per person. Uploads are limited to the attachment size limit in
  **Admin → Settings → Limits**; uploads nothing uses are removed after a day.
- Push URLs must be public `https://` addresses (no IP addresses or local names).
- Downloads are sent as attachments with a sandboxing Content-Security-Policy.
- People who must choose a new password or set up two-step sign-in do that in the web
  app first.

## How it works (for developers)

The code is in `src/server/jmap/`. Requests reach the Durable Object like `/api/*`
(`run_worker_first` in `wrangler.toml` lists `/jmap/*` and `/.well-known/jmap`).

- **Change log.** SQLite triggers (migration 13) record every change an app can see in
  `jmap_changes`, whichever code path made it: a per-mailbox counter (`jmap_modseq`)
  and a random tag per change. A state string is `{counter}-{tag}`, so after a
  point-in-time recovery or a backup restore an app's old state no longer matches and it
  gets `cannotCalculateChanges` and starts over, instead of missing changes. Entries
  older than 30 days are pruned by hourly maintenance.
- **Ids.** `M{message}T{thread}C{created}[V{revision}]` for emails,
  `T{thread}C{created}` for threads, `L{label}C{created}` for labels and the folder
  names for folders. The creation time keeps an id from coming back when SQLite reuses
  a rowid. JMAP emails never change, so merging conversations or editing a draft gives
  the email a new id (the old one is destroyed and a new one created). Raw messages and
  body parts are `R…` and `P…` blobs named the same way; attachments and uploads are
  `A{attachment}`.
- **Accounts.** An account id is `u{user id}`: the person's own, or a shared mailbox's
  (`users.kind = 'shared'`). Every method call, download and upload looks up the
  person's membership again before touching the mailbox; inside a call the mailbox is
  `ctx.user` and the person `ctx.actor`, like `user` and `actor` in the web app's
  `actAsMailbox`. The change log is kept per mailbox, so a shared mailbox's changes are
  the same for all its members.
- **Push** runs after each request, incoming mail and background work, only when
  someone is listening. A change to a mailbox goes to its person, or to a shared
  mailbox's members as they are at that moment.
