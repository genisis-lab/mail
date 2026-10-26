import Foundation

/// What the message list shows of each conversation.
let listProperties: JSON = ["threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"]
/// What the reader needs of each message.
let fullProperties: JSON = [
    "threadId", "mailboxIds", "keywords", "from", "to", "cc", "bcc", "replyTo", "subject", "receivedAt", "preview", "hasAttachment",
    "messageId", "references", "textBody", "htmlBody", "attachments", "bodyValues",
]

extension JMAPClient {
    public func mailboxes(account: String) async throws -> [Mailbox] {
        let r = try await call([("Mailbox/get", ["accountId": .string(account), "properties": ["name", "role", "sortOrder", "totalEmails", "unreadEmails"]])])
        return try (r[0]["list"] ?? []).decode([Mailbox].self).sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
    }

    public func identities(account: String) async throws -> [Identity] {
        let r = try await call([("Identity/get", ["accountId": .string(account)])])
        return try (r[0]["list"] ?? []).decode([Identity].self)
    }

    /// The newest `limit` conversations in a mailbox, optionally matching a search, and how many there are in all.
    public func conversations(account: String, mailbox: String, search: String = "", limit: Int) async throws -> (list: [Conversation], total: Int) {
        var filter: [String: JSON] = ["inMailbox": .string(mailbox)]
        let words = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { filter["text"] = .string(words) }
        let a = JSON.string(account)
        let r = try await call([
            ("Email/query", [
                "accountId": a, "filter": .object(filter), "sort": [["property": "receivedAt", "isAscending": false]],
                "collapseThreads": true, "limit": .number(Double(limit)), "calculateTotal": true,
            ]),
            ("Email/get", ["accountId": a, "#ids": ["resultOf": "0", "name": "Email/query", "path": "/ids"], "properties": listProperties]),
            ("Thread/get", ["accountId": a, "#ids": ["resultOf": "1", "name": "Email/get", "path": "/list/*/threadId"]]),
        ])
        let emails = try (r[1]["list"] ?? []).decode([Email].self)
        var counts: [String: Int] = [:]
        for t in r[2]["list"]?.array ?? [] {
            if let id = t["id"]?.string { counts[id] = t["emailIds"]?.array?.count }
        }
        return (emails.map { Conversation(email: $0, count: counts[$0.threadId] ?? 1) }, r[0]["total"]?.int ?? emails.count)
    }

    /// Every message of a conversation, oldest first, with bodies.
    public func conversation(account: String, threadId: String) async throws -> [Email] {
        let a = JSON.string(account)
        let r = try await call([
            ("Thread/get", ["accountId": a, "ids": [.string(threadId)]]),
            ("Email/get", [
                "accountId": a, "#ids": ["resultOf": "0", "name": "Thread/get", "path": "/list/0/emailIds"],
                "properties": fullProperties, "fetchAllBodyValues": true,
            ]),
        ])
        return try (r[1]["list"] ?? []).decode([Email].self)
    }

    /// The messages of some conversations, with just what's needed to change them.
    public func members(account: String, threadIds: [String]) async throws -> [Email] {
        let a = JSON.string(account)
        let r = try await call([
            ("Thread/get", ["accountId": a, "ids": .array(threadIds.map(JSON.string))]),
            ("Email/get", [
                "accountId": a, "#ids": ["resultOf": "0", "name": "Thread/get", "path": "/list/*/emailIds"],
                "properties": ["threadId", "mailboxIds", "keywords", "receivedAt"],
            ]),
        ])
        return try (r[1]["list"] ?? []).decode([Email].self)
    }

    /// Apply patches (email id → PatchObject); throws if any is refused.
    public func update(account: String, _ patches: [String: JSON]) async throws {
        guard !patches.isEmpty else { return }
        let r = try await call([("Email/set", ["accountId": .string(account), "update": .object(patches)])])
        try checkSet(r[0])
    }

    /// Delete messages for good.
    public func destroy(account: String, ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        let r = try await call([("Email/set", ["accountId": .string(account), "destroy": .array(ids.map(JSON.string))])])
        try checkSet(r[0])
    }

    /// Save a draft into Drafts (replacing the one it was opened from) and return its new id.
    public func save(_ draft: Draft, from identity: Identity, draftsMailbox: String) async throws -> String {
        var args: [String: JSON] = ["accountId": .string(draft.accountId), "create": ["draft": try draft.emailObject(from: identity, draftsMailbox: draftsMailbox)]]
        if let old = draft.replaces { args["destroy"] = [.string(old)] }
        let r = try await call([("Email/set", .object(args))])
        // The draft it replaces may already be gone (sent or deleted elsewhere); that's fine.
        try checkSet(r[0], ignoringMissing: true)
        guard let id = r[0]["created"]?["draft"]?["id"]?.string else { throw JMAPError.badResponse }
        return id
    }

    /// Send a saved draft now, or hold it until `sendAt` (scheduled send), and file it in Sent.
    public func submit(emailId: String, account: String, identity: Identity, recipients: [EmailAddress], sendAt: Date? = nil, draftsMailbox: String, sentMailbox: String) async throws {
        var submission: [String: JSON] = ["identityId": .string(identity.id), "emailId": .string(emailId)]
        if let sendAt {
            submission["envelope"] = [
                "mailFrom": ["email": .string(identity.email), "parameters": ["HOLDUNTIL": .string(utcDate(sendAt))]],
                "rcptTo": .array(recipients.map { ["email": .string($0.email)] }),
            ]
        }
        let r = try await call([
            ("EmailSubmission/set", [
                "accountId": .string(account),
                "create": ["send": .object(submission)],
                "onSuccessUpdateEmail": ["#send": .object(["mailboxIds/\(draftsMailbox)": nil, "mailboxIds/\(sentMailbox)": true, "keywords/$draft": nil])],
            ]),
        ])
        try checkSet(r[0])
    }
}

/// Patches for Email/set. Wren keeps each message in exactly one folder (a mailbox with a role) plus any labels.
public enum Patch {
    public static func keyword(_ keyword: String, _ on: Bool) -> JSON {
        ["keywords/\(keyword)": on ? true : nil]
    }

    public static func label(_ mailbox: String, _ on: Bool) -> JSON {
        ["mailboxIds/\(mailbox)": on ? true : nil]
    }

    /// Move to another folder, keeping the labels.
    public static func move(_ email: Email, to folder: String, folders: Set<String>) -> JSON {
        ["mailboxIds": mailboxIds(email, folder: folder, folders: folders)]
    }

    /// Put back exactly where it was (for undo).
    public static func restore(_ email: Email) -> JSON {
        ["mailboxIds": .object(email.mailboxIds.filter(\.value).mapValues { _ in true })]
    }

    /// Snooze until a time: into the Snoozed mailbox, and back to the Inbox, unread, when it wakes.
    public static func snooze(_ email: Email, until: Date, snoozedMailbox: String, folders: Set<String>) -> JSON {
        ["mailboxIds": mailboxIds(email, folder: snoozedMailbox, folders: folders), "snoozed": ["until": .string(utcDate(until))]]
    }

    private static func mailboxIds(_ email: Email, folder: String, folders: Set<String>) -> JSON {
        var ids: [String: JSON] = [folder: true]
        for (id, on) in email.mailboxIds where on && !folders.contains(id) { ids[id] = true }
        return .object(ids)
    }
}
