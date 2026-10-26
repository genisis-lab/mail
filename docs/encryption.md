# PGP keys across browsers

Public keys can be published on the server so other people can encrypt mail to you. They are public information and do not need password protection.

Your private key is protected with a separate PGP passphrase. Wren can keep an encrypted backup in your account and restore it after you sign in on another browser. The passphrase and unlocked private key stay in the tab's memory; neither is sent to the server. Signing out locks the key. Closing a private-browsing window can erase the local copy, but a saved encrypted backup remains available after signing in again.

In **Settings → Encryption**:

- For an existing browser-only key, choose **Save encrypted backup** once. Existing keys are not uploaded automatically.
- Creating or importing a key saves its encrypted backup and publishes its public key. Check for **encrypted backup saved**; if saving fails, download a copy before closing the browser.
- Keep a downloaded private-key backup somewhere safe as well. Use a long, unique PGP passphrase. Resetting your account password cannot recover a forgotten PGP passphrase.
- **Remove from this browser** removes the local copy; it does not delete the server backup. A later sign-in or unlock can restore it.
- **Delete server backup** removes the account's active backup, not copies already downloaded to browsers or retained database backups. Download the old key before replacing it: mail encrypted to an old key still needs that key.

Only your authenticated account can retrieve its encrypted backup. It is never included in public-key lookup results. Private backups are included, still passphrase-encrypted, in database backups. Wren refuses unprotected private keys and refuses to overwrite a backup with a different key until you explicitly remove the old backup.

# New tabs and private browsing

Tabs that share the browser's cookie jar share their Wren login. Wren checks the current cookies when opening a new tab and does not reuse cached authentication responses. Some browsers, including Safari Private Browsing, isolate private tabs or windows. A tab with an isolated cookie jar must sign in separately; use the original tab or a normal browser window for a shared session. Wren does not put session credentials into inbox links to bypass this isolation.

# Profile-picture caching

Wren reuses loaded pictures while navigating and lets the browser cache image responses. Changing or removing your own picture changes its URL immediately. Other people's local profile pictures are cached for up to five minutes on subsequent loads, with ETags avoiding a full download when unchanged; external Gravatar/BIMI pictures may remain cached longer. Missing pictures are cached briefly and retried on subsequent loads rather than remembered for the entire session.
