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
];
