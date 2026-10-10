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
| Labels | Mailboxes without a role. An email can be in one folder plus any number of labels. |
| Read, starred, important | The `$seen`, `$flagged` and `$important` keywords |
| Other keywords (`$answered`, `$forwarded`, your own) | Kept as they are; Wren marks the original `$answered` when you reply |
| Conversations | Threads |
| Search | `Email/query` filters: text, from, to, cc, bcc, subject, body, dates, sizes, keywords, attachments |
| Out-of-office reply | `VacationResponse` |
| Storage used and allowed | `Quota` (RFC 9425) |
| Your addresses and signatures | `Identity` (read only; manage them in Wren) |

Apps can read mail, search, flag and move it, manage labels, write drafts with
attachments, send, and import messages. Changes made anywhere (in the web app, by a
filter, by another app) reach every app through `/changes` and push.

**Push.** Apps can register a push URL (`PushSubscription`); Wren sends a small state
change there whenever something changes, encrypted for the app (RFC 8291) when it gives
keys, and only after the app has confirmed the subscription. Subscriptions last up to 7
days and the app renews them. Apps can also hold an `EventSource` stream open; Wren
ends each stream after 15 minutes and the app reconnects.

**Not yet:** shared mailboxes (coming in the next version). Snooze, scheduled send and
inbox tabs are web-only: a snoozed email shows in Archive until it wakes, and mail
scheduled in the web app shows in Sent with a pending submission, which an app can
cancel (that turns it back into a draft). Sending from an app is immediate (no delayed
send or undo). Mailboxes don't nest, and `queryChanges` isn't supported, so apps re-run
their queries.

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
- **Push** runs after each request, incoming mail and background work, only when
  someone is listening.
