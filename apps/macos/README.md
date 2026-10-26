# Wren for Mac

A native Mac mail app for Wren, written in SwiftUI. It signs in with an app password and
talks to your Wren server over JMAP ([docs/jmap.md](../../docs/jmap.md)), so mail apps
have to be turned on in Wren (Admin → Settings & policies → Security).

- Mailboxes, labels and shared mailboxes in the sidebar, with unread counts and a Dock badge
- Conversations, search as you type, and a reader that folds older messages
- Archive, Trash, Junk, flag, read/unread, labels and snooze, from the toolbar, the Message
  menu, swipes and right-click; moves can be undone with ⌘Z
- Compose in its own window: reply, reply all, forward (with attachments), attach files,
  send now or later; closing a window with changes saves it to Drafts
- Live updates over Wren's push stream, and a notification for new mail in your Inbox
- Mail's keyboard shortcuts (⌘N, ⌘R, ⇧⌘R, ⇧⌘F, ⇧⌘D, ⌃⌘A, ⇧⌘U, ⇧⌘L, ⇧⌘J, ⇧⌘N)

## Privacy and security

- The app password is kept in your login keychain. The server address must be `https`
  (plain `http` only works for `localhost`).
- HTML mail is shown with JavaScript off, no cookies or storage, and a Content-Security-Policy
  that blocks everything from the web until you click **Load Remote Content** (or turn it on
  in Settings → Viewing). Links open in your browser.
- Attachments you open are saved with the quarantine flag, so Gatekeeper checks them.

## Building

You need macOS 14 (Sonoma) or later and Xcode 16 or later.

**To try it:** open `Package.swift` in Xcode, pick the **Wren** scheme and **My Mac**, and
press ⌘R. Notifications need a real app bundle, so they're off when run this way.

**To use it:** run `./bundle.sh`. It builds `build/Wren.app`, signed for your own Mac; drag
it into Applications.

**To share it** with other people, sign it with a Developer ID certificate (from a paid
Apple Developer account) and have Apple notarize it, or Gatekeeper will refuse to open it:

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./bundle.sh
ditto -c -k --keepParent build/Wren.app build/Wren.zip
xcrun notarytool submit build/Wren.zip --keychain-profile <profile> --wait
xcrun stapler staple build/Wren.app
```

(`xcrun notarytool store-credentials` creates the keychain profile once.) The app isn't
sandboxed, so it can't go on the Mac App Store as it is.

## Tests

The mail engine (`Sources/WrenKit`: the JMAP client, models and compose helpers) uses only
Foundation, so its tests run on macOS and Linux:

```sh
swift test
```

`LiveServerTests` also runs everything the app does against a real Wren server, when you
give it one with mail in its inbox. Use a test server: it sends, snoozes and deletes.

```sh
WREN_SERVER=http://localhost:8787 WREN_USER=you@example.com WREN_APP_PASSWORD=wren_… swift test
```

## Not yet

Several Wren sign-ins at once, an app icon, a rich-text editor, drag-and-drop attachments,
opening `mailto:` links from other apps, and choosing a notification to open its message.
