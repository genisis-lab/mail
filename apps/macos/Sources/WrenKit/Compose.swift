import Foundation

/// A message being written. Codable so a compose window can be restored.
public struct Draft: Codable, Hashable, Sendable, Identifiable {
    public struct File: Codable, Hashable, Sendable {
        public var blobId: String
        public var name: String
        public var type: String
        public var size: Int

        public init(blobId: String, name: String, type: String, size: Int) {
            self.blobId = blobId
            self.name = name
            self.type = type
            self.size = size
        }

        static func list(_ parts: [BodyPart]?) -> [File] {
            (parts ?? []).compactMap { p in p.blobId.map { File(blobId: $0, name: p.name ?? "attachment", type: p.type, size: p.size) } }
        }
    }

    public var id = UUID()
    public var accountId: String
    public var identityId: String?
    public var to = ""
    public var cc = ""
    public var bcc = ""
    public var subject = ""
    public var body = ""
    public var files: [File] = []
    public var inReplyTo: [String]?
    public var references: [String]?
    /// The saved draft this one was opened from, deleted when it's saved again or sent.
    public var replaces: String?

    public init(accountId: String, identityId: String? = nil) {
        self.accountId = accountId
        self.identityId = identityId
    }

    public var recipients: [EmailAddress] {
        get throws { try Addresses.parse(to) + Addresses.parse(cc) + Addresses.parse(bcc) }
    }

    /// The Email/set create object for this draft. Addresses that don't parse yet are left out rather than
    /// losing the draft (sending checks `recipients` first).
    public func emailObject(from identity: Identity, draftsMailbox: String) throws -> JSON {
        var o: [String: JSON] = [
            "mailboxIds": [draftsMailbox: true],
            "keywords": ["$draft": true, "$seen": true],
            "from": [try JSON(encoding: identity.address)],
            "to": try JSON(encoding: Addresses.parse(to, skippingInvalid: true)),
            "cc": try JSON(encoding: Addresses.parse(cc, skippingInvalid: true)),
            "bcc": try JSON(encoding: Addresses.parse(bcc, skippingInvalid: true)),
            "subject": .string(subject),
            "textBody": [["partId": "body", "type": "text/plain"]],
            "bodyValues": ["body": ["value": .string(body)]],
            "attachments": .array(files.map { ["blobId": .string($0.blobId), "name": .string($0.name), "type": .string($0.type), "disposition": "attachment"] }),
        ]
        if let inReplyTo { o["inReplyTo"] = .array(inReplyTo.map(JSON.string)) }
        if let references { o["references"] = .array(references.map(JSON.string)) }
        return .object(o)
    }

    /// A new message, with the signature below where you type.
    public static func new(account: String, identity: Identity?, to: String = "") -> Draft {
        var d = Draft(accountId: account, identityId: identity?.id)
        d.to = to
        d.body = signatureBlock(identity)
        return d
    }

    /// A reply to `email`, or a reply to everyone on it, from the identity it was sent to.
    public static func reply(to email: Email, all: Bool, account: String, identities: [Identity]) -> Draft {
        let mine = Set(identities.map { $0.email.lowercased() })
        let identity = Identity.best(for: email, among: identities)
        var d = Draft(accountId: account, identityId: identity?.id)
        let fromMe = email.from?.contains { mine.contains($0.email.lowercased()) } ?? false
        // Replying to your own message goes to the people you sent it to.
        let primary = fromMe ? (email.to ?? []) : (email.replyTo ?? email.from ?? [])
        d.to = primary.map(\.formatted).joined(separator: ", ")
        if all {
            var seen = mine.union(primary.map { $0.email.lowercased() })
            let others = ((fromMe ? [] : email.to ?? []) + (email.cc ?? [])).filter { seen.insert($0.email.lowercased()).inserted }
            d.cc = others.map(\.formatted).joined(separator: ", ")
        }
        d.subject = prefixed("Re:", email.subject)
        d.inReplyTo = email.messageId
        d.references = email.messageId.map { (email.references ?? []) + $0 }
        let who = email.from?.first?.displayName ?? "someone"
        let when = email.receivedAt.map { "On \($0.formatted(date: .abbreviated, time: .shortened)), " } ?? ""
        d.body = signatureBlock(identity) + "\n\n\(when)\(who) wrote:\n\n" + quote(email.text)
        return d
    }

    public static func forward(_ email: Email, account: String, identities: [Identity]) -> Draft {
        let identity = Identity.best(for: email, among: identities)
        var d = Draft(accountId: account, identityId: identity?.id)
        d.subject = prefixed("Fwd:", email.subject)
        var header = ["Begin forwarded message:", ""]
        if let from = email.from, !from.isEmpty { header.append("From: " + from.map(\.formatted).joined(separator: ", ")) }
        header.append("Subject: " + (email.subject ?? ""))
        if let date = email.receivedAt { header.append("Date: " + date.formatted(date: .long, time: .shortened)) }
        if let to = email.to, !to.isEmpty { header.append("To: " + to.map(\.formatted).joined(separator: ", ")) }
        d.body = signatureBlock(identity) + "\n\n" + header.joined(separator: "\n") + "\n\n" + email.text
        // Wren copies another message's attachments into the draft, so they're sent along without downloading them.
        d.files = File.list(email.attachments)
        return d
    }

    /// Opening a saved draft to keep writing it.
    public static func editing(_ email: Email, account: String, identities: [Identity]) -> Draft {
        var d = Draft(accountId: account, identityId: Identity.best(for: email, among: identities)?.id)
        d.to = (email.to ?? []).map(\.formatted).joined(separator: ", ")
        d.cc = (email.cc ?? []).map(\.formatted).joined(separator: ", ")
        d.bcc = (email.bcc ?? []).map(\.formatted).joined(separator: ", ")
        d.subject = email.subject ?? ""
        d.body = email.text
        d.files = File.list(email.attachments)
        d.replaces = email.id
        return d
    }

    private static func signatureBlock(_ identity: Identity?) -> String {
        guard let sig = identity?.textSignature?.trimmingCharacters(in: .whitespacesAndNewlines), !sig.isEmpty else { return "" }
        return "\n\n" + sig
    }

    static func prefixed(_ prefix: String, _ subject: String?) -> String {
        let s = (subject ?? "").trimmingCharacters(in: .whitespaces)
        return s.lowercased().hasPrefix(prefix.lowercased()) ? s : "\(prefix) \(s)"
    }

    static func quote(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasPrefix(">") ? ">\($0)" : "> \($0)" }.joined(separator: "\n")
    }
}

extension Identity {
    /// The identity a message was sent to, so a reply goes out from the same address; otherwise the first.
    public static func best(for email: Email, among identities: [Identity]) -> Identity? {
        let addressed = Set(((email.to ?? []) + (email.cc ?? []) + (email.from ?? [])).map { $0.email.lowercased() })
        return identities.first { addressed.contains($0.email.lowercased()) } ?? identities.first
    }
}

public enum Addresses {
    public struct Invalid: Error, LocalizedError, Equatable {
        public var text: String
        public var errorDescription: String? { "“\(text)” isn’t an email address." }
    }

    /// Addresses as typed into a To field: `Ada <ada@example.com>, bob@example.com; "Hopper, Grace" <grace@example.com>`.
    public static func parse(_ text: String, skippingInvalid: Bool = false) throws -> [EmailAddress] {
        var pieces: [String] = []
        var current = ""
        var quoted = false
        var angled = false
        for ch in text {
            if ch == "\"" { quoted.toggle() }
            else if !quoted && ch == "<" { angled = true }
            else if !quoted && ch == ">" { angled = false }
            else if !quoted && !angled && (ch == "," || ch == ";" || ch == "\n") {
                pieces.append(current)
                current = ""
                continue
            }
            current.append(ch)
        }
        pieces.append(current)
        return try pieces.compactMap { piece -> EmailAddress? in
            let piece = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            if piece.isEmpty { return nil }
            var name: String?
            var email = piece
            if let open = piece.lastIndex(of: "<"), let close = piece.lastIndex(of: ">"), open < close {
                email = String(piece[piece.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
                let n = piece[..<open].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                name = n.isEmpty ? nil : n
            }
            guard isEmail(email) else {
                if skippingInvalid { return nil }
                throw Invalid(text: piece)
            }
            return EmailAddress(name: name, email: email)
        }
    }

    static func isEmail(_ s: String) -> Bool {
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        let bad = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "<>\"(),;:[]\\"))
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
            && s.unicodeScalars.allSatisfy { !bad.contains($0) }
    }
}

/// HTML as readable plain text, for quoting a reply and for messages without a text part.
public func plainText(fromHTML html: String) -> String {
    var s = html
    for (pattern, replacement) in [
        ("(?is)<(head|style|script|title)\\b.*?</\\1\\s*>", ""),
        ("(?i)<br\\s*/?>", "\n"),
        ("(?i)</(p|div|tr|li|h[1-6]|blockquote|table)\\s*>", "\n"),
        ("(?i)<li\\b[^>]*>", "• "),
        ("(?s)<!--.*?-->", ""),
        ("(?s)<[^>]+>", ""),
    ] {
        s = s.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    for (entity, ch) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
        s = s.replacingOccurrences(of: entity, with: ch)
    }
    s = s.replacingOccurrences(of: "[ \\t]+\\n", with: "\n", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The times Mail-style menus offer for snoozing and for sending later.
public struct SnoozeTime: Sendable {
    public var title: String
    public var date: Date

    public static func choices(now: Date = .now, calendar: Calendar = .current) -> [SnoozeTime] {
        func at(_ hour: Int, daysAhead: Int) -> Date {
            let day = calendar.date(byAdding: .day, value: daysAhead, to: calendar.startOfDay(for: now))!
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)!
        }
        var list: [SnoozeTime] = []
        let tonight = at(21, daysAhead: 0)
        if tonight.timeIntervalSince(now) > 30 * 60 { list.append(SnoozeTime(title: "Tonight at \(tonight.formatted(date: .omitted, time: .shortened))", date: tonight)) }
        let tomorrow = at(8, daysAhead: 1)
        list.append(SnoozeTime(title: "Tomorrow at \(tomorrow.formatted(date: .omitted, time: .shortened))", date: tomorrow))
        // The coming Monday morning (a week on, if today is Monday).
        let weekday = calendar.component(.weekday, from: now)
        let untilMonday = (9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7
        let monday = at(8, daysAhead: untilMonday)
        list.append(SnoozeTime(title: "Next Week (\(monday.formatted(.dateTime.weekday(.abbreviated).hour().minute())))", date: monday))
        return list
    }
}
