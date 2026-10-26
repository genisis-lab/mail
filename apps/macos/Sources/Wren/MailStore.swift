import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications
import WrenKit

struct MailboxRef: Hashable {
    var account: String
    var mailbox: String
}

struct NotConnected: LocalizedError {
    var errorDescription: String? { "Wren isn’t connected yet. Try again in a moment." }
}

/// Everything the windows show, and every change they make, for the signed-in person.
@MainActor
@Observable
final class MailStore {
    enum Phase { case starting, signedOut, signedIn }

    var phase = Phase.starting
    /// Shown on the sign-in screen, such as after the app password was revoked.
    var signInMessage: String?
    private(set) var client: JMAPClient?
    private(set) var accounts: [Account] = []
    private(set) var mailboxes: [String: [Mailbox]] = [:]
    private(set) var identities: [String: [Identity]] = [:]

    var selectedMailbox: MailboxRef?
    var selectedThreads: Set<String> = []
    var search = ""
    private(set) var conversations: [Conversation] = []
    private(set) var total = 0
    private(set) var isLoading = false
    /// The open conversation's messages, oldest first.
    private(set) var thread: [Email] = []
    private(set) var threadId: String?
    /// The open conversation's messages that were unread when it opened (reading marks them read; they stay unfolded).
    private(set) var unreadWhenOpened: Set<String> = []

    /// A connection problem, shown quietly under the sidebar until the connection is back.
    private(set) var problem: String?
    /// An action that failed.
    var alert: String?
    /// Conversations in the Trash waiting for "Delete Forever" to be confirmed.
    var confirmingDelete: Set<String>?

    @ObservationIgnored var undoManager: UndoManager?
    @ObservationIgnored private var limit = 50
    @ObservationIgnored private var listGeneration = 0
    @ObservationIgnored private var listening: Task<Void, Never>?
    /// Inbox messages already notified about (nil until the first look, so mail that was already there isn't announced).
    @ObservationIgnored private var announced: Set<String>?

    // MARK: Mailboxes

    func mailbox(_ ref: MailboxRef?) -> Mailbox? {
        guard let ref else { return nil }
        return mailboxes[ref.account]?.first { $0.id == ref.mailbox }
    }

    func mailbox(role: String, in account: String) -> Mailbox? {
        mailboxes[account]?.first { $0.role == role }
    }

    func labels(in account: String) -> [Mailbox] {
        mailboxes[account]?.filter { $0.role == nil } ?? []
    }

    private func folders(in account: String) -> Set<String> {
        Set((mailboxes[account] ?? []).filter { $0.role != nil }.map(\.id))
    }

    var currentRole: String? { mailbox(selectedMailbox)?.role }

    var currentAccount: Account? { accounts.first { $0.id == selectedMailbox?.account } }

    // MARK: Signing in

    func restore() {
        guard phase == .starting else { return }
        let defaults = UserDefaults.standard
        guard let server = defaults.string(forKey: "server").flatMap(URL.init(string:)), let username = defaults.string(forKey: "username"),
              let password = Keychain.read(username: username, server: server)
        else {
            phase = .signedOut
            return
        }
        begin(JMAPClient(server: server, username: username, password: password))
    }

    func signIn(server: URL, username: String, password: String) async throws {
        let client = JMAPClient(server: server, username: username, password: password)
        try await client.connect()
        try Keychain.save(password, username: username, server: server)
        UserDefaults.standard.set(server.absoluteString, forKey: "server")
        UserDefaults.standard.set(username, forKey: "username")
        signInMessage = nil
        begin(client)
        // The moment to ask: they've just set up their mail.
        if Self.canNotify { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
    }

    /// Forget the app password (the server and address stay, to fill in the sign-in form).
    func signOut(message: String? = nil) {
        listening?.cancel()
        if let client { Keychain.delete(username: client.username, server: client.server) }
        client = nil
        accounts = []
        mailboxes = [:]
        identities = [:]
        selectedMailbox = nil
        selectedThreads = []
        conversations = []
        total = 0
        thread = []
        threadId = nil
        search = ""
        problem = nil
        announced = nil
        undoManager?.removeAllActions()
        NSApp.dockTile.badgeLabel = nil
        signInMessage = message
        phase = .signedOut
    }

    private func begin(_ client: JMAPClient) {
        self.client = client
        phase = .signedIn
        listening?.cancel()
        listening = Task { [weak self] in await self?.listen(client) }
    }

    /// Stay up to date: refresh whenever Wren says something changed, and reconnect when the stream ends or drops.
    private func listen(_ client: JMAPClient) async {
        var delay = 2.0
        while !Task.isCancelled {
            do {
                // Each connection fetches the session again, so shared mailboxes that come and go show up.
                let session = try await client.connect()
                accounts = session.mailAccounts
                for account in accounts { identities[account.id] = try await client.identities(account: account.id) }
                delay = 2
                // Wren sends the current state as soon as the stream opens, so this also loads everything.
                try await client.listen { [weak self] in await self?.refresh() }
            } catch JMAPError.unauthorized(_) {
                signOut(message: "Wren didn’t accept the app password. If it was revoked, create a new one in Wren and sign in again.")
                return
            } catch {
                if Task.isCancelled { return }
                problem = error.localizedDescription
            }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 60)
        }
    }

    // MARK: Loading

    func refresh() async {
        guard let client else { return }
        do {
            for account in accounts { mailboxes[account.id] = try await client.mailboxes(account: account.id) }
            if selectedMailbox != nil, mailbox(selectedMailbox) == nil { selectedMailbox = nil }
            if selectedMailbox == nil, let account = accounts.first, let inbox = mailbox(role: "inbox", in: account.id) {
                // The message list loads it when the selection changes.
                selectedMailbox = MailboxRef(account: account.id, mailbox: inbox.id)
            } else {
                await loadList()
            }
            if let threadId { await loadThread(threadId) }
            problem = nil
            updateDockBadge()
            await notifyNewMail()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Show the selected mailbox from the top.
    func showMailbox() async {
        selectedThreads = []
        conversations = []
        total = 0
        limit = 50
        await loadList()
    }

    func loadList() async {
        guard let client, let ref = selectedMailbox else { return }
        listGeneration += 1
        let generation = listGeneration
        isLoading = true
        defer { if generation == listGeneration { isLoading = false } }
        do {
            let page = try await client.conversations(account: ref.account, mailbox: ref.mailbox, search: search, limit: limit)
            // A newer load (another mailbox, a longer search) has started since.
            guard generation == listGeneration else { return }
            conversations = page.list
            total = page.total
        } catch {
            if generation == listGeneration { problem = error.localizedDescription }
        }
    }

    func loadMore() async {
        guard conversations.count < total, !isLoading else { return }
        limit += 50
        await loadList()
    }

    /// Open a conversation in the reader (nil closes it). Reading marks it read, as in Mail.
    func open(_ id: String?) async {
        threadId = id
        guard let id else {
            thread = []
            return
        }
        if thread.first?.threadId != id {
            thread = []
            unreadWhenOpened = []
        }
        await loadThread(id)
        let unread = thread.filter(\.isUnread)
        unreadWhenOpened.formUnion(unread.map(\.id))
        if !unread.isEmpty { await markRead(unread) }
    }

    private func loadThread(_ id: String) async {
        guard let client, let ref = selectedMailbox else { return }
        do {
            let emails = try await client.conversation(account: ref.account, threadId: id)
            guard threadId == id else { return }
            // Messages in the Trash stay out of view, unless you're looking at the Trash.
            let trash = mailbox(role: "trash", in: ref.account)?.id
            let showTrash = currentRole == "trash"
            thread = emails.filter { email in showTrash || trash.map { email.mailboxIds[$0] != true } ?? true }
        } catch {
            if threadId == id { problem = error.localizedDescription }
        }
    }

    // MARK: Changing mail

    /// The messages an action on these conversations applies to: the ones in the mailbox you're looking at.
    private func targets(_ ids: Set<String>) async throws -> [Email] {
        guard let client, let ref = selectedMailbox else { throw NotConnected() }
        return try await client.members(account: ref.account, threadIds: Array(ids)).filter { $0.mailboxIds[ref.mailbox] == true }
    }

    private func update(_ emails: [Email], _ patch: (Email) -> JSON) async throws {
        guard let client, let ref = selectedMailbox else { throw NotConnected() }
        try await client.update(account: ref.account, Dictionary(emails.map { ($0.id, patch($0)) }, uniquingKeysWith: { a, _ in a }))
    }

    func archive(_ ids: Set<String>) async {
        await move(ids, to: "archive", actionName: "Archive")
    }

    /// To the Trash; in the Trash, delete for good after asking.
    func trash(_ ids: Set<String>) async {
        if currentRole == "trash" { confirmingDelete = ids } else { await move(ids, to: "trash", actionName: "Move to Trash") }
    }

    /// To Spam; in Spam, back to the Inbox. Wren learns from both.
    func junk(_ ids: Set<String>) async {
        if currentRole == "junk" { await move(ids, to: "inbox", actionName: "Not Junk") } else { await move(ids, to: "junk", actionName: "Move to Junk") }
    }

    func moveToInbox(_ ids: Set<String>) async {
        await move(ids, to: "inbox", actionName: "Move to Inbox")
    }

    private func move(_ ids: Set<String>, to role: String, actionName: String) async {
        guard let ref = selectedMailbox, let target = mailbox(role: role, in: ref.account), target.id != ref.mailbox, !ids.isEmpty else { return }
        let folders = folders(in: ref.account)
        removeFromList(ids)
        do {
            let emails = try await targets(ids)
            try await update(emails) { Patch.move($0, to: target.id, folders: folders) }
            undoManager?.registerUndo(withTarget: self) { store in
                Task { await store.putBack(emails, account: ref.account) }
            }
            undoManager?.setActionName(actionName)
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    /// Undo a move: back where each message was (snoozed ones come back to the Inbox).
    private func putBack(_ emails: [Email], account: String) async {
        guard let client, let inbox = mailbox(role: "inbox", in: account) else { return }
        let folders = folders(in: account)
        let snoozed = mailbox(role: "snoozed", in: account)?.id
        do {
            try await client.update(account: account, Dictionary(emails.map { e in
                let wasSnoozed = snoozed.map { e.mailboxIds[$0] == true } ?? false
                return (e.id, wasSnoozed ? Patch.move(e, to: inbox.id, folders: folders) : Patch.restore(e))
            }, uniquingKeysWith: { a, _ in a }))
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    func deleteForever(_ ids: Set<String>) async {
        guard let client, let ref = selectedMailbox else { return }
        removeFromList(ids)
        do {
            try await client.destroy(account: ref.account, ids: targets(ids).map(\.id))
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    func setRead(_ ids: Set<String>, _ read: Bool) async {
        updateRows(ids) { $0.keywords["$seen"] = read ? true : nil }
        do {
            let emails = try await targets(ids)
            // Marking unread marks the newest message, as Mail does; marking read covers the whole conversation.
            let chosen = read ? emails.filter(\.isUnread) : Dictionary(grouping: emails, by: \.threadId).values.compactMap { $0.max { ($0.receivedAt ?? .distantPast) < ($1.receivedAt ?? .distantPast) } }
            try await update(chosen) { _ in Patch.keyword("$seen", read) }
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    private func markRead(_ emails: [Email]) async {
        let ids = Set(emails.map(\.id))
        updateRows(Set(emails.map(\.threadId))) { $0.keywords["$seen"] = true }
        for i in thread.indices where ids.contains(thread[i].id) { thread[i].keywords["$seen"] = true }
        do {
            try await update(emails) { _ in Patch.keyword("$seen", true) }
        } catch {
            problem = error.localizedDescription
        }
    }

    func toggleFlag(_ ids: Set<String>) async {
        let rows = conversations.filter { ids.contains($0.id) }
        let flag = !rows.allSatisfy(\.email.isFlagged)
        updateRows(ids) { $0.keywords["$flagged"] = flag ? true : nil }
        do {
            try await update(rows.map(\.email)) { _ in Patch.keyword("$flagged", flag) }
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    /// Snoozing is for the Inbox and Archive, in accounts whose server supports it.
    var canSnooze: Bool { currentAccount?.canSnooze == true && (currentRole == "inbox" || currentRole == "archive") }

    func snooze(_ ids: Set<String>, until: Date) async {
        guard let ref = selectedMailbox, let snoozed = mailbox(role: "snoozed", in: ref.account) else { return }
        let folders = folders(in: ref.account)
        removeFromList(ids)
        do {
            try await update(targets(ids)) { Patch.snooze($0, until: until, snoozedMailbox: snoozed.id, folders: folders) }
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    func hasLabel(_ label: Mailbox, _ ids: Set<String>) -> Bool {
        let rows = conversations.filter { ids.contains($0.id) }
        return !rows.isEmpty && rows.allSatisfy { $0.email.mailboxIds[label.id] == true }
    }

    func setLabel(_ label: Mailbox, _ on: Bool, for ids: Set<String>) async {
        if !on && label.id == selectedMailbox?.mailbox { removeFromList(ids) }
        do {
            try await update(targets(ids)) { _ in Patch.label(label.id, on) }
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    private func updateRows(_ ids: Set<String>, _ change: (inout Email) -> Void) {
        for i in conversations.indices where ids.contains(conversations[i].id) { change(&conversations[i].email) }
    }

    /// Take rows out of the list right away; when the selection goes with them, select the next one, as Mail does.
    private func removeFromList(_ ids: Set<String>) {
        var next: String?
        if !selectedThreads.isEmpty, selectedThreads.isSubset(of: ids), let last = conversations.lastIndex(where: { ids.contains($0.id) }) {
            next = conversations[(last + 1)...].first { !ids.contains($0.id) }?.id ?? conversations[..<last].last { !ids.contains($0.id) }?.id
        }
        withAnimation(Self.motion) { conversations.removeAll { ids.contains($0.id) } }
        total = max(0, total - ids.count)
        selectedThreads.subtract(ids)
        if selectedThreads.isEmpty, let next { selectedThreads = [next] }
    }

    /// A critically damped spring, or none when Reduce Motion is on.
    static var motion: Animation? {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? nil : .smooth(duration: 0.3)
    }

    // MARK: Writing

    var replyTarget: Email? { thread.last { !$0.isDraft } }

    /// Reply and Forward go with the selection, as the other actions do, and answer the newest message once it's loaded.
    var canReply: Bool { selectedThreads.count == 1 && currentRole != "drafts" }

    func newDraft(to: String = "") -> Draft? {
        guard let account = selectedMailbox?.account ?? accounts.first?.id else { return nil }
        return .new(account: account, identity: identities[account]?.first, to: to)
    }

    func replyDraft(to email: Email? = nil, all: Bool) -> Draft? {
        guard let account = selectedMailbox?.account, let email = email ?? replyTarget else { return nil }
        return .reply(to: email, all: all, account: account, identities: identities[account] ?? [])
    }

    func forwardDraft(of email: Email? = nil) -> Draft? {
        guard let account = selectedMailbox?.account, let email = email ?? replyTarget else { return nil }
        return .forward(email, account: account, identities: identities[account] ?? [])
    }

    func editDraft(_ email: Email) -> Draft? {
        guard let account = selectedMailbox?.account else { return nil }
        return .editing(email, account: account, identities: identities[account] ?? [])
    }

    func identity(for draft: Draft) -> Identity? {
        let list = identities[draft.accountId] ?? []
        return list.first { $0.id == draft.identityId } ?? list.first
    }

    /// Save into Drafts (replacing the draft it came from) and return the new draft's id.
    func save(_ draft: Draft) async throws -> String {
        guard let client, let identity = identity(for: draft), let drafts = mailbox(role: "drafts", in: draft.accountId) else { throw NotConnected() }
        let id = try await client.save(draft, from: identity, draftsMailbox: drafts.id)
        await refresh()
        return id
    }

    func send(_ draft: Draft, savedAs emailId: String, at date: Date? = nil) async throws {
        guard let client, let identity = identity(for: draft), let drafts = mailbox(role: "drafts", in: draft.accountId),
              let sent = mailbox(role: "sent", in: draft.accountId)
        else { throw NotConnected() }
        try await client.submit(emailId: emailId, account: draft.accountId, identity: identity, recipients: draft.recipients, sendAt: date, draftsMailbox: drafts.id, sentMailbox: sent.id)
        await refresh()
    }

    /// Throw away a draft that was saved before.
    func discard(_ draft: Draft) async {
        guard let id = draft.replaces else { return }
        do {
            try await client?.destroy(account: draft.accountId, ids: [id])
        } catch {
            alert = error.localizedDescription
        }
        await refresh()
    }

    func upload(_ url: URL, account: String) async throws -> Draft.File {
        guard let client else { throw NotConnected() }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let blob = try await client.upload(data, type: type, account: account)
        return Draft.File(blobId: blob.blobId, name: url.lastPathComponent, type: blob.type, size: blob.size)
    }

    // MARK: Attachments

    func download(_ part: BodyPart) async throws -> Data {
        guard let client, let ref = selectedMailbox else { throw NotConnected() }
        return try await client.download(part, account: ref.account)
    }

    private static func fileName(_ part: BodyPart) -> String {
        let name = (part.name ?? "").replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Attachment" : name
    }

    /// Open with its app. Files the app writes are quarantined (LSFileQuarantineEnabled), so Gatekeeper checks them first.
    func openAttachment(_ part: BodyPart) async {
        do {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Wren").appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(Self.fileName(part))
            try await download(part).write(to: url)
            NSWorkspace.shared.open(url)
        } catch {
            alert = error.localizedDescription
        }
    }

    func saveAttachment(_ part: BodyPart) async {
        do {
            let data = try await download(part)
            let downloads = try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let name = Self.fileName(part) as NSString
            var url = downloads.appendingPathComponent(name as String)
            var n = 2
            while FileManager.default.fileExists(atPath: url.path) {
                let numbered = name.pathExtension.isEmpty ? "\(name) \(n)" : "\(name.deletingPathExtension) \(n).\(name.pathExtension)"
                url = downloads.appendingPathComponent(numbered)
                n += 1
            }
            try data.write(to: url, options: .withoutOverwriting)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            alert = error.localizedDescription
        }
    }

    // MARK: Dock and notifications

    private func updateDockBadge() {
        guard let account = accounts.first(where: \.isPersonal), let inbox = mailbox(role: "inbox", in: account.id) else { return }
        NSApp.dockTile.badgeLabel = inbox.unreadEmails > 0 ? String(inbox.unreadEmails) : nil
    }

    /// Notifications need an app bundle (not a bare `swift run` binary).
    static var canNotify: Bool { Bundle.main.bundleIdentifier != nil }

    /// A notification for each new unread message in your Inbox.
    private func notifyNewMail() async {
        guard Self.canNotify, let client, let account = accounts.first(where: \.isPersonal), let inbox = mailbox(role: "inbox", in: account.id),
              let page = try? await client.conversations(account: account.id, mailbox: inbox.id, limit: 20)
        else { return }
        let unread = page.list.map(\.email).filter(\.isUnread)
        let known = announced
        announced = (known ?? []).union(unread.map(\.id))
        guard let known else { return }
        for email in unread where !known.contains(email.id) {
            let content = UNMutableNotificationContent()
            content.title = email.from?.first?.displayName ?? "New Message"
            content.subtitle = email.subject ?? ""
            content.body = email.preview ?? ""
            content.sound = .default
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: email.id, content: content, trigger: nil))
        }
    }
}
