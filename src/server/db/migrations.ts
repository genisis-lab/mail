/**
 * Schema migrations, applied in order. The current version is tracked in the
 * `_meta` table. Never edit a migration that has shipped; append a
 * new one instead.
 */
export const migrations: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                TEXT NOT NULL DEFAULT '',
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner','admin','user')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    quota_bytes         INTEGER,
    used_bytes          INTEGER NOT NULL DEFAULT 0,
    send_limit_per_day  INTEGER,
    totp_secret         TEXT,
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    recovery_codes      TEXT,
    prefs               TEXT NOT NULL DEFAULT '{}',
    created_at          INTEGER NOT NULL,
    last_login_at       INTEGER,
    password_changed_at INTEGER
  );

  CREATE TABLE providers (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL,
    config         TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    is_default     INTEGER NOT NULL DEFAULT 0,
    inbound_token  TEXT NOT NULL UNIQUE,
    sent_count     INTEGER NOT NULL DEFAULT 0,
    failed_count   INTEGER NOT NULL DEFAULT 0,
    received_count INTEGER NOT NULL DEFAULT 0,
    last_used_at   INTEGER,
    last_error     TEXT,
    last_error_at  INTEGER,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE domains (
    id                   INTEGER PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
    enabled              INTEGER NOT NULL DEFAULT 1,
    verify_token         TEXT NOT NULL,
    verified_at          INTEGER,
    provider_id          INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    fallback_provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    catch_all_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    dkim_selector        TEXT,
    dns_report           TEXT,
    dns_checked_at       INTEGER,
    created_at           INTEGER NOT NULL
  );

  -- Every deliverable address. kind:
  --   mailbox: a user's primary address
  --   alias:   extra address delivering to user_id
  --   group:   delivers to address_targets (users and/or external)
  CREATE TABLE addresses (
    id          INTEGER PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('mailbox','alias','group')),
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',
    can_send    INTEGER NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_addresses_user ON addresses(user_id);
  CREATE INDEX idx_addresses_domain ON addresses(domain_id);

  CREATE TABLE address_targets (
    id         INTEGER PRIMARY KEY,
    address_id INTEGER NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    external   TEXT COLLATE NOCASE,
    CHECK ((user_id IS NULL) <> (external IS NULL))
  );
  CREATE INDEX idx_address_targets_addr ON address_targets(address_id);

  CREATE TABLE threads (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject    TEXT NOT NULL DEFAULT '',
    last_date  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_threads_user ON threads(user_id, last_date DESC);

  CREATE TABLE messages (
    id                  INTEGER PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id           INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    folder              TEXT NOT NULL CHECK (folder IN ('inbox','sent','drafts','archive','spam','trash')),
    direction           TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
    message_id          TEXT,
    in_reply_to         TEXT,
    refs                TEXT NOT NULL DEFAULT '',
    from_addr           TEXT NOT NULL DEFAULT '',
    from_name           TEXT NOT NULL DEFAULT '',
    to_json             TEXT NOT NULL DEFAULT '[]',
    cc_json             TEXT NOT NULL DEFAULT '[]',
    bcc_json            TEXT NOT NULL DEFAULT '[]',
    reply_to            TEXT,
    subject             TEXT NOT NULL DEFAULT '',
    snippet             TEXT NOT NULL DEFAULT '',
    text_body           TEXT,
    html_body           TEXT,
    date                INTEGER NOT NULL,
    size                INTEGER NOT NULL DEFAULT 0,
    raw_blob            TEXT,
    has_attachments     INTEGER NOT NULL DEFAULT 0,
    is_read             INTEGER NOT NULL DEFAULT 0,
    is_starred          INTEGER NOT NULL DEFAULT 0,
    is_important        INTEGER NOT NULL DEFAULT 0,
    snoozed_until       INTEGER,
    woke_at             INTEGER,
    status              TEXT NOT NULL DEFAULT 'none'
                        CHECK (status IN ('none','draft','queued','sending','sent','failed','cancelled')),
    send_at             INTEGER,
    is_scheduled        INTEGER NOT NULL DEFAULT 0,
    identity            TEXT,
    last_error          TEXT,
    provider_id         INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    provider_message_id TEXT,
    sent_at             INTEGER,
    spam_score          REAL,
    auth_results        TEXT,
    source              TEXT,
    trashed_at          INTEGER,
    created_at          INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_user_folder ON messages(user_id, folder, date DESC);
  CREATE INDEX idx_messages_thread ON messages(thread_id, date);
  CREATE INDEX idx_messages_msgid ON messages(user_id, message_id);
  CREATE INDEX idx_messages_inreplyto ON messages(user_id, in_reply_to);
  CREATE INDEX idx_messages_status ON messages(user_id, status);
  CREATE INDEX idx_messages_snooze ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject, sender, recipients, body,
    content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    content_id   TEXT,
    inline       INTEGER NOT NULL DEFAULT 0,
    blob         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments(message_id);

  CREATE TABLE labels (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );

  CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id   INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
  );
  CREATE INDEX idx_message_labels_label ON message_labels(label_id);

  CREATE TABLE contacts (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email             TEXT NOT NULL COLLATE NOCASE,
    name              TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    phone             TEXT NOT NULL DEFAULT '',
    company           TEXT NOT NULL DEFAULT '',
    saved             INTEGER NOT NULL DEFAULT 0,
    times_contacted   INTEGER NOT NULL DEFAULT 0,
    last_contacted_at INTEGER,
    created_at        INTEGER NOT NULL,
    UNIQUE (user_id, email)
  );

  CREATE TABLE filters (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    criteria   TEXT NOT NULL,
    actions    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE blocked_senders (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = instance-wide
    pattern    TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, pattern)
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mfa_pending  INTEGER NOT NULL DEFAULT 0,
    ip           TEXT,
    user_agent   TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    last_used_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE invites (
    id         INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email      TEXT COLLATE NOCASE,
    role       TEXT NOT NULL DEFAULT 'user',
    domain_id  INTEGER REFERENCES domains(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    details    TEXT,
    ip         TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

  CREATE TABLE inbound_log (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    mail_from   TEXT NOT NULL DEFAULT '',
    rcpt_to     TEXT NOT NULL DEFAULT '',
    subject     TEXT NOT NULL DEFAULT '',
    message_id  TEXT,
    size        INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_inbound_created ON inbound_log(created_at DESC);

  CREATE TABLE delivery_log (
    id          INTEGER PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    event       TEXT NOT NULL,
    recipients  TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_delivery_created ON delivery_log(created_at DESC);
  CREATE INDEX idx_delivery_message ON delivery_log(message_id);

  -- Every outbound delivery (user mail, forwards, auto-replies, notices, tests)
  CREATE TABLE outbox (
    id                  INTEGER PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('user','forward','autoreply','notice','test','api')),
    message_id          INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
    mail_from           TEXT NOT NULL,
    recipients          TEXT NOT NULL,
    raw_blob            TEXT NOT NULL,
    subject             TEXT NOT NULL DEFAULT '',
    provider_id         INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','sent','failed','cancelled')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER NOT NULL,
    last_error          TEXT,
    provider_message_id TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
  CREATE INDEX idx_outbox_queue ON outbox(status, next_attempt_at);
  CREATE INDEX idx_outbox_message ON outbox(message_id);

  CREATE TABLE autoreply_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender  TEXT NOT NULL COLLATE NOCASE,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sender)
  );

  CREATE TABLE login_attempts (
    key        TEXT PRIMARY KEY,
    count      INTEGER NOT NULL,
    reset_at   INTEGER NOT NULL
  );
  `,

  // 2: very large bodies live in blob storage (Durable Object rows max out at 2 MB).
  `
  ALTER TABLE messages ADD COLUMN body_blob TEXT;
  `,

  // 3: unreferenced blobs are kept for a grace period so restored backups find their files.
  `
  CREATE TABLE blob_tombstones (
    key     TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  `,

  // 4: shared mailboxes, recovery email, one-time links, alerts, push, saved replies and
  //    searches, background jobs (import/export) and the setup round-trip test.
  `
  ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','shared'));
  ALTER TABLE users ADD COLUMN recovery_email TEXT;
  ALTER TABLE users ADD COLUMN recovery_verified_at INTEGER;
  ALTER TABLE addresses ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE messages ADD COLUMN sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE delivery_log ADD COLUMN outbox_id INTEGER;
  ALTER TABLE invites ADD COLUMN emailed_at INTEGER;
  ALTER TABLE invites ADD COLUMN sent_to TEXT;
  CREATE INDEX idx_delivery_log_created ON delivery_log(created_at);
  CREATE INDEX idx_inbound_log_created ON inbound_log(created_at);

  CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('reset','setup','verify_recovery')),
    data       TEXT,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, kind);

  CREATE TABLE mailbox_members (
    mailbox_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_send   INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mailbox_id, user_id)
  );
  CREATE INDEX idx_mailbox_members_user ON mailbox_members(user_id);

  CREATE TABLE alerts (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    key         TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
    title       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    link        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    notified_at INTEGER,
    resolved_at INTEGER
  );
  CREATE UNIQUE INDEX idx_alerts_open ON alerts(kind, key) WHERE resolved_at IS NULL;

  CREATE TABLE push_subscriptions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    user_agent   TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX idx_push_user ON push_subscriptions(user_id);

  CREATE TABLE saved_replies (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    html       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_saved_replies_user ON saved_replies(user_id);

  CREATE TABLE saved_searches (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    query      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_saved_searches_user ON saved_searches(user_id);

  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('imap_import','export')),
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
    config      TEXT,
    state       TEXT NOT NULL DEFAULT '{}',
    progress    TEXT NOT NULL DEFAULT '{}',
    error       TEXT,
    next_run_at INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_due ON jobs(status, next_run_at);

  CREATE TABLE roundtrip_tests (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    address     TEXT NOT NULL,
    outbox_id   INTEGER,
    sent_at     INTEGER NOT NULL,
    received_at INTEGER
  );
  `,

  // 5: delivery status and suppressions, alias "via", catch-all control, inbox
  //    categories and unsubscribe, passkeys and sign-in alerts, automatic backups.
  `
  ALTER TABLE messages ADD COLUMN delivered_to TEXT;
  ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT 'primary';
  ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
  ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;
  CREATE INDEX idx_messages_user_category ON messages(user_id, folder, category, date DESC);
  CREATE INDEX idx_outbox_provider_message ON outbox(provider_message_id);

  CREATE TABLE suppressions (
    address     TEXT PRIMARY KEY COLLATE NOCASE,
    reason      TEXT NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
    detail      TEXT NOT NULL DEFAULT '',
    provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE blocked_recipients (
    address    TEXT PRIMARY KEY COLLATE NOCASE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE catchall_hits (
    address      TEXT PRIMARY KEY COLLATE NOCASE,
    domain_id    INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    count        INTEGER NOT NULL DEFAULT 0,
    first_at     INTEGER NOT NULL,
    last_at      INTEGER NOT NULL,
    last_from    TEXT NOT NULL DEFAULT '',
    last_subject TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_catchall_domain ON catchall_hits(domain_id, last_at DESC);

  CREATE TABLE category_rules (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL COLLATE NOCASE,
    category   TEXT NOT NULL CHECK (category IN ('primary','updates','promotions')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sender)
  );

  CREATE TABLE unsubscribes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL COLLATE NOCASE,
    method     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sender)
  );

  CREATE TABLE passkeys (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,
    algorithm     INTEGER NOT NULL,
    sign_count    INTEGER NOT NULL DEFAULT 0,
    name          TEXT NOT NULL DEFAULT '',
    transports    TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );
  CREATE INDEX idx_passkeys_user ON passkeys(user_id);

  CREATE TABLE webauthn_challenges (
    challenge  TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('register','login')),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE known_devices (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_hash)
  );

  CREATE TABLE backups (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('auto','manual')),
    status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
    parts       TEXT NOT NULL DEFAULT '[]',
    state       TEXT NOT NULL DEFAULT '{}',
    rows        INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  `,

  // 6: throwaway sign-up aliases.
  `
  ALTER TABLE addresses ADD COLUMN throwaway INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_messages_delivered_to ON messages(user_id, delivered_to);
  `,

  // 7: meeting invitations: the answer the user sent.
  `
  ALTER TABLE messages ADD COLUMN rsvp TEXT;
  `,

  // 8: an admin can require a new password at the next sign-in (met once the password changes after this time).
  `
  ALTER TABLE users ADD COLUMN password_change_required_at INTEGER;
  `,

  // 9: conversations started from an autosaved draft kept the subject as first saved (often
  //    blank or half-typed). Give each the subject of its first message.
  `
  UPDATE threads SET subject = (SELECT m.subject FROM messages m WHERE m.thread_id = threads.id ORDER BY m.date, m.id LIMIT 1)
   WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)
     AND subject IS NOT (SELECT m.subject FROM messages m WHERE m.thread_id = threads.id ORDER BY m.date, m.id LIMIT 1);
  `,

  // 10: muted conversations, "remind me if no reply", one-time codes in mail, contact groups.
  `
  ALTER TABLE threads ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN follow_up_at INTEGER;
  ALTER TABLE threads ADD COLUMN follow_up_since INTEGER;
  CREATE INDEX idx_threads_follow_up ON threads(follow_up_at) WHERE follow_up_at IS NOT NULL;
  ALTER TABLE messages ADD COLUMN otp TEXT;
  ALTER TABLE messages ADD COLUMN nudged_at INTEGER;

  CREATE TABLE contact_groups (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE TABLE contact_group_members (
    group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    address  TEXT NOT NULL COLLATE NOCASE,
    name     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, address)
  );
  `,

  // 11: packages in shipping mail (tracking number, order, status) for the order card.
  //     NULL: not looked at yet (older mail is looked at when opened); '': none.
  `
  ALTER TABLE messages ADD COLUMN parcel TEXT;
  CREATE INDEX idx_messages_parcel ON messages(user_id, date) WHERE parcel <> '';
  `,

  // 12: profile pictures, and the pictures found (or not) for people who write in.
  `
  ALTER TABLE users ADD COLUMN avatar_blob TEXT;
  ALTER TABLE users ADD COLUMN avatar_type TEXT;
  ALTER TABLE users ADD COLUMN avatar_at INTEGER;

  -- key: an address (Gravatar) or '@domain' (a brand logo published with BIMI).
  CREATE TABLE avatar_cache (
    key          TEXT PRIMARY KEY COLLATE NOCASE,
    source       TEXT NOT NULL,
    blob         TEXT,
    content_type TEXT,
    checked_at   INTEGER NOT NULL
  );
  `,

  // 13: JMAP (RFC 8620/8621) for mail apps. Keys get scopes ("send" for the HTTP API,
  //     "mail" for app passwords); messages get the JMAP keywords Wren has no column
  //     for ($answered, $forwarded, $junk…) and a revision that changes a draft's JMAP
  //     id when its content changes. Triggers record every change a JMAP client can see,
  //     whichever code path made it (see src/server/jmap/changes.ts).
  `
  ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'send';
  ALTER TABLE messages ADD COLUMN keywords TEXT;
  ALTER TABLE messages ADD COLUMN jmap_rev INTEGER NOT NULL DEFAULT 0;

  -- One counter per mailbox. base: the state before any change was recorded.
  -- floor: changes up to here were pruned. pushed: the counter push last reported.
  CREATE TABLE jmap_modseq (
    user_id INTEGER PRIMARY KEY,
    modseq  INTEGER NOT NULL DEFAULT 0,
    floor   INTEGER NOT NULL DEFAULT 0,
    pushed  INTEGER NOT NULL DEFAULT 0,
    base    TEXT NOT NULL
  );
  -- kind: c(reated) u(pdated) d(estroyed). tag: random, so a state string can't match after a rollback.
  CREATE TABLE jmap_changes (
    user_id INTEGER NOT NULL,
    modseq  INTEGER NOT NULL,
    type    TEXT NOT NULL,
    obj     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    thread  TEXT,
    tag     TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (user_id, modseq)
  ) WITHOUT ROWID;

  CREATE TABLE jmap_push (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id            INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
    device_client_id  TEXT NOT NULL,
    url               TEXT NOT NULL,
    p256dh            TEXT,
    auth              TEXT,
    verification_code TEXT NOT NULL,
    verified          INTEGER NOT NULL DEFAULT 0,
    types             TEXT,
    expires_at        INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (user_id, device_client_id)
  );

  ${jmapTriggers()}
  `,

  // 14: an admin can turn mail apps (JMAP) off for one person while they stay on for everyone else.
  `
  ALTER TABLE users ADD COLUMN mail_apps_blocked INTEGER NOT NULL DEFAULT 0;
  `,

  // 15: one browser can be signed in to several accounts and get each one's notifications,
  //     so a push subscription (one per browser) is kept per account and device.
  `
  CREATE TABLE push_subscriptions_new (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    user_agent   TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (user_id, endpoint)
  );
  INSERT INTO push_subscriptions_new (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
    SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at FROM push_subscriptions;
  DROP TABLE push_subscriptions;
  ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
  CREATE INDEX idx_push_user ON push_subscriptions(user_id);
  CREATE INDEX idx_push_endpoint ON push_subscriptions(endpoint);
  `,

  // 16: private links: recipients get a link instead of the message, and it stops working
  //     after a set time. The row is made when a draft is marked private; the token's hash,
  //     the expiry and the content are filled in as the message goes out (mail/private.ts).
  //     attachments: the message's attachment rows as JSON [{id, filename, content_type, size, content_id, inline, blob}].
  //     Expired and withdrawn rows are deleted.
  `
  CREATE TABLE private_links (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    days        INTEGER NOT NULL,
    token_hash  TEXT UNIQUE,
    expires_at  INTEGER,
    html_body   TEXT,
    text_body   TEXT,
    body_blob   TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_private_links_expiry ON private_links(expires_at);
  `,

  // 17: the Calendar page: events people add themselves, and what each invitation in mail says.
  //     messages.invite: NULL: not read yet (the calendar reads it on its next load); '': none; JSON: the event.
  `
  CREATE TABLE calendar_events (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    all_day    INTEGER NOT NULL DEFAULT 0,
    start_at   INTEGER NOT NULL,
    end_at     INTEGER NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_calendar_events_user ON calendar_events(user_id, start_at);
  ALTER TABLE messages ADD COLUMN invite TEXT;
  CREATE INDEX idx_messages_invite ON messages(user_id) WHERE invite <> '';
  CREATE INDEX idx_attachments_calendar ON attachments(user_id) WHERE content_type LIKE 'text/calendar%' OR content_type LIKE 'application/ics%' OR filename LIKE '%.ics';
  `,

  // 18: mail apps see when a snoozed email wakes (the Email "snoozed" property), so moving a
  //     snooze to another time is a change they're told about too.
  `
  DROP TRIGGER IF EXISTS jmap_message_update;
  ${jmapMessageUpdate()}
  `,

  // 19: PGP public keys (private keys never reach the server). own = 1: the person's own key,
  //     published to everyone on this server (one each); own = 0: someone else's key they saved.
  //     emails: JSON array of the addresses in the key's user IDs.
  `
  CREATE TABLE pgp_keys (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    own         INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    emails      TEXT NOT NULL DEFAULT '[]',
    armored     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, own, fingerprint)
  );
  CREATE UNIQUE INDEX idx_pgp_keys_own ON pgp_keys(user_id) WHERE own = 1;
  `,

  // 20: Re-read cached invitations with organizer-scoped identities and date-less cancellations.
  `UPDATE messages SET invite = NULL WHERE invite IS NOT NULL;`,

  // 21: Revalidate cached calendar updates against the message sender.
  `UPDATE messages SET invite = NULL WHERE invite IS NOT NULL;`,

  // 22: Bind stored files to their contents in trusted SQLite, independently of the bucket.
  // Old files are enrolled by the encryption pass (or their first successful read).
  `CREATE TABLE blob_integrity (
    key TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    encrypted INTEGER NOT NULL
  );
  DELETE FROM _meta WHERE key = 'blob_encryption';`,

  // 23: Preserve browser signing intent across draft saves and undo send.
  `ALTER TABLE messages ADD COLUMN pgp_sign INTEGER NOT NULL DEFAULT 0;`,

  // 24: a private link opens only for a recipient who enters the code emailed to them.
  //     kind 'code': that code (its keyed hash, a few tries); kind 'pass': a browser that
  //     entered one (its cookie's hash). Both are short-lived and go with their link.
  `
  CREATE TABLE private_link_access (
    id         INTEGER PRIMARY KEY,
    link_id    INTEGER NOT NULL REFERENCES private_links(id) ON DELETE CASCADE,
    recipient  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    hash       TEXT NOT NULL UNIQUE,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_private_link_access ON private_link_access(link_id, recipient, kind);
  CREATE INDEX idx_private_link_access_expiry ON private_link_access(expires_at);
  `,

  // 25: "Report spam" and "Not spam" are remembered per sender, so later mail from them follows.
  `
  CREATE TABLE sender_verdicts (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL COLLATE NOCASE,
    verdict    TEXT NOT NULL CHECK (verdict IN ('spam','safe')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sender)
  );
  `,

  // 26: sending paused (compromised-account guard, or an admin): the person can't send and
  //     their queued mail is held until an admin resumes it. Reading and receiving go on.
  //     After a resume the guard counts only what was sent since.
  `
  ALTER TABLE users ADD COLUMN send_paused_at INTEGER;
  ALTER TABLE users ADD COLUMN send_paused_reason TEXT;
  ALTER TABLE users ADD COLUMN send_resumed_at INTEGER;
  `,
];

/** SQL for one change-log entry: bump the mailbox's counter, then record the change at the new value. */
function jmapChange(user: string, type: string, obj: string, kind: string, thread = 'NULL', from = '', where = '') {
  return `
    INSERT OR IGNORE INTO jmap_modseq (user_id, base) SELECT ${user}, lower(hex(randomblob(6))) ${from} ${where};
    UPDATE jmap_modseq SET modseq = modseq + 1 WHERE user_id = (SELECT ${user} ${from} ${where});
    INSERT INTO jmap_changes (user_id, modseq, type, obj, kind, thread, tag, at)
      SELECT ${user}, q.modseq, '${type}', ${obj}, '${kind}', ${thread}, lower(hex(randomblob(4))), CAST(strftime('%s', 'now') AS INTEGER)
        FROM jmap_modseq q ${from ? from.replace(/^FROM/, ',') : ''} WHERE q.user_id = ${user} ${where.replace(/^WHERE/, 'AND')};`;
}

// JMAP ids (src/server/jmap/ids.ts). created_at keeps an id from coming back when SQLite reuses a
// rowid; a new thread or a new draft revision is a new email, because JMAP emails are immutable.
function jmapEmailId(r: string) {
  return `'M' || ${r}.id || 'T' || ${r}.thread_id || 'C' || ${r}.created_at || CASE WHEN ${r}.jmap_rev > 0 THEN 'V' || ${r}.jmap_rev ELSE '' END`;
}
function jmapThreadOf(r: string) {
  return `(SELECT 'T' || t.id || 'C' || t.created_at FROM threads t WHERE t.id = ${r}.thread_id)`;
}
// A mailbox being deleted takes its rows with it; record nothing for it.
function jmapLive(u: string) {
  return `EXISTS (SELECT 1 FROM users WHERE id = ${u})`;
}

/** An email changes for mail apps when its folder, flags, keywords or snooze (including its time) do. */
function jmapMessageUpdate(): string {
  return `
  CREATE TRIGGER jmap_message_update AFTER UPDATE OF folder, is_read, is_starred, is_important, snoozed_until, keywords ON messages
    WHEN (OLD.folder IS NOT NEW.folder OR OLD.is_read IS NOT NEW.is_read OR OLD.is_starred IS NOT NEW.is_starred
          OR OLD.is_important IS NOT NEW.is_important OR OLD.snoozed_until IS NOT NEW.snoozed_until
          OR OLD.keywords IS NOT NEW.keywords)
     AND OLD.thread_id = NEW.thread_id AND OLD.jmap_rev = NEW.jmap_rev AND ${jmapLive('NEW.user_id')} BEGIN
    ${jmapChange('NEW.user_id', 'Email', jmapEmailId('NEW'), 'u', jmapThreadOf('NEW'))}
  END;`;
}

function jmapTriggers(): string {
  const emailId = jmapEmailId;
  const threadOf = jmapThreadOf;
  const threadId = (r: string) => `'T' || ${r}.id || 'C' || ${r}.created_at`;
  const mailboxId = (r: string) => `'L' || ${r}.id || 'C' || ${r}.created_at`;
  const live = jmapLive;
  const viaMessage = { from: 'FROM messages m', where: `WHERE m.id = NEW.message_id AND ${live('m.user_id')}` };
  const viaOldMessage = { from: 'FROM messages m', where: `WHERE m.id = OLD.message_id AND ${live('m.user_id')}` };
  return `
  CREATE TRIGGER jmap_message_insert AFTER INSERT ON messages WHEN ${live('NEW.user_id')} BEGIN
    ${jmapChange('NEW.user_id', 'Email', emailId('NEW'), 'c', threadOf('NEW'))}
  END;
  CREATE TRIGGER jmap_message_delete AFTER DELETE ON messages WHEN ${live('OLD.user_id')} BEGIN
    ${jmapChange('OLD.user_id', 'Email', emailId('OLD'), 'd', threadOf('OLD'))}
  END;
  ${jmapMessageUpdate()}
  CREATE TRIGGER jmap_message_replace AFTER UPDATE OF thread_id, jmap_rev ON messages
    WHEN (OLD.thread_id <> NEW.thread_id OR OLD.jmap_rev <> NEW.jmap_rev) AND ${live('NEW.user_id')} BEGIN
    ${jmapChange('OLD.user_id', 'Email', emailId('OLD'), 'd', threadOf('OLD'))}
    ${jmapChange('NEW.user_id', 'Email', emailId('NEW'), 'c', threadOf('NEW'))}
  END;
  CREATE TRIGGER jmap_label_add AFTER INSERT ON message_labels BEGIN
    ${jmapChange('m.user_id', 'Email', emailId('m'), 'u', threadOf('m'), viaMessage.from, viaMessage.where)}
  END;
  CREATE TRIGGER jmap_label_remove AFTER DELETE ON message_labels BEGIN
    ${jmapChange('m.user_id', 'Email', emailId('m'), 'u', threadOf('m'), viaOldMessage.from, viaOldMessage.where)}
  END;
  CREATE TRIGGER jmap_mailbox_insert AFTER INSERT ON labels WHEN ${live('NEW.user_id')} BEGIN
    ${jmapChange('NEW.user_id', 'Mailbox', mailboxId('NEW'), 'c')}
  END;
  CREATE TRIGGER jmap_mailbox_update AFTER UPDATE OF name, position ON labels
    WHEN (OLD.name IS NOT NEW.name OR OLD.position IS NOT NEW.position) AND ${live('NEW.user_id')} BEGIN
    ${jmapChange('NEW.user_id', 'Mailbox', mailboxId('NEW'), 'u')}
  END;
  CREATE TRIGGER jmap_mailbox_delete AFTER DELETE ON labels WHEN ${live('OLD.user_id')} BEGIN
    ${jmapChange('OLD.user_id', 'Mailbox', mailboxId('OLD'), 'd')}
  END;
  CREATE TRIGGER jmap_thread_insert AFTER INSERT ON threads WHEN ${live('NEW.user_id')} BEGIN
    ${jmapChange('NEW.user_id', 'Thread', threadId('NEW'), 'c')}
  END;
  CREATE TRIGGER jmap_thread_delete AFTER DELETE ON threads WHEN ${live('OLD.user_id')} BEGIN
    ${jmapChange('OLD.user_id', 'Thread', threadId('OLD'), 'd')}
  END;
  CREATE TRIGGER jmap_user_delete AFTER DELETE ON users BEGIN
    DELETE FROM jmap_changes WHERE user_id = OLD.id;
    DELETE FROM jmap_modseq WHERE user_id = OLD.id;
  END;
  `;
}
