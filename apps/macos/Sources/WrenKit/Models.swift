import Foundation

/// The JMAP capabilities Wren speaks.
public enum Capability {
    public static let core = "urn:ietf:params:jmap:core"
    public static let mail = "urn:ietf:params:jmap:mail"
    public static let submission = "urn:ietf:params:jmap:submission"
    /// Fastmail's mail extension, which Wren uses for snooze.
    public static let snooze = "https://cyrusimap.org/ns/jmap/mail"
}

public struct Session: Decodable, Sendable {
    public struct AccountInfo: Decodable, Sendable {
        public var name: String
        public var isPersonal: Bool
        public var accountCapabilities: [String: JSON]
    }

    public var apiUrl: String
    public var downloadUrl: String
    public var uploadUrl: String
    public var eventSourceUrl: String?
    public var username: String
    public var accounts: [String: AccountInfo]
    public var capabilities: [String: JSON]

    /// The accounts with mail: the person's own first, then each shared mailbox they belong to.
    public var mailAccounts: [Account] {
        accounts.filter { $0.value.accountCapabilities[Capability.mail] != nil }
            .map { Account(id: $0.key, name: $0.value.name, isPersonal: $0.value.isPersonal, canSnooze: $0.value.accountCapabilities[Capability.snooze] != nil) }
            .sorted { ($0.isPersonal ? 0 : 1, $0.name) < ($1.isPersonal ? 0 : 1, $1.name) }
    }
}

public struct Account: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var isPersonal: Bool
    public var canSnooze: Bool
}

public struct EmailAddress: Codable, Hashable, Sendable {
    public var name: String?
    public var email: String

    public init(name: String? = nil, email: String) {
        self.name = name
        self.email = email
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return email
    }

    /// As typed in an address field: `Name <email>`, quoting names that hold separators.
    public var formatted: String {
        guard let name, !name.isEmpty else { return email }
        let safe = name.contains(where: { ",;<>\"".contains($0) }) ? "\"\(name.replacingOccurrences(of: "\"", with: ""))\"" : name
        return "\(safe) <\(email)>"
    }
}

public struct Mailbox: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// Folders have a role (inbox, archive, drafts, sent, junk, trash, snoozed); labels don't.
    public var role: String?
    public var sortOrder: Int
    public var totalEmails: Int
    public var unreadEmails: Int
}

public struct Identity: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var email: String
    public var textSignature: String?

    public var address: EmailAddress { EmailAddress(name: name, email: email) }
}

public struct BodyPart: Codable, Hashable, Sendable {
    public var partId: String?
    public var blobId: String?
    public var size: Int
    public var name: String?
    public var type: String
    public var disposition: String?
    public var cid: String?
}

public struct BodyValue: Codable, Hashable, Sendable {
    public var value: String
}

public struct Email: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var threadId: String
    public var mailboxIds: [String: Bool]
    public var keywords: [String: Bool]
    public var from: [EmailAddress]?
    public var to: [EmailAddress]?
    public var cc: [EmailAddress]?
    public var bcc: [EmailAddress]?
    public var replyTo: [EmailAddress]?
    public var subject: String?
    public var receivedAt: Date?
    public var preview: String?
    public var hasAttachment: Bool?
    public var messageId: [String]?
    public var references: [String]?
    public var textBody: [BodyPart]?
    public var htmlBody: [BodyPart]?
    public var attachments: [BodyPart]?
    public var bodyValues: [String: BodyValue]?

    public var isUnread: Bool { keywords["$seen"] != true }
    public var isFlagged: Bool { keywords["$flagged"] == true }
    public var isDraft: Bool { keywords["$draft"] == true }

    /// The HTML body, when the message has one.
    public var html: String? {
        htmlBody?.first(where: { $0.type == "text/html" }).flatMap { $0.partId.flatMap { bodyValues?[$0]?.value } }
    }

    /// The message as plain text (from its text part, or its HTML with the tags taken out).
    public var text: String {
        if let part = textBody?.first(where: { $0.type == "text/plain" }), let id = part.partId, let value = bodyValues?[id]?.value { return value }
        return html.map(plainText(fromHTML:)) ?? preview ?? ""
    }

    /// Files to show under the message (inline images used by the HTML are left out).
    public var files: [BodyPart] {
        let html = self.html ?? ""
        return (attachments ?? []).filter { part in
            guard part.disposition == "inline", let cid = part.cid else { return true }
            return !html.contains("cid:\(cid)")
        }
    }
}

/// A row of the message list: a conversation, shown by its newest message in the mailbox.
public struct Conversation: Hashable, Sendable, Identifiable {
    public var email: Email
    public var count: Int
    public var id: String { email.threadId }
}

public struct UploadedBlob: Codable, Hashable, Sendable {
    public var blobId: String
    public var type: String
    public var size: Int
}

extension JSONDecoder {
    /// JMAP dates are RFC 3339 (UTCDate), with or without fractions of a second.
    static let jmap: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date(text, strategy: .iso8601) { return date }
            if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a date: \(text)"))
        }
        return d
    }()
}

/// A UTCDate for JMAP, such as 2026-10-26T09:00:00Z.
func utcDate(_ date: Date) -> String {
    date.formatted(.iso8601)
}
