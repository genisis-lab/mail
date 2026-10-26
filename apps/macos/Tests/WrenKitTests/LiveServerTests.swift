import Foundation
import XCTest
import WrenKit

/// Runs the engine against a real Wren server with mail in its inbox (a test server: it sends, snoozes and deletes).
/// WREN_SERVER=http://localhost:8787 WREN_USER=you@example.com WREN_APP_PASSWORD=wren_… swift test
final class LiveServerTests: XCTestCase {
    func testEverythingTheAppDoes() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["WREN_SERVER"].flatMap(ServerAddress.url(from:)), let user = env["WREN_USER"], let password = env["WREN_APP_PASSWORD"] else {
            throw XCTSkip("Set WREN_SERVER, WREN_USER and WREN_APP_PASSWORD to run against a Wren server")
        }
        let client = JMAPClient(server: server, username: user, password: password)
        let account = try await client.connect().mailAccounts[0].id
        let boxes = try await client.mailboxes(account: account)
        let role = Dictionary(boxes.compactMap { b in b.role.map { ($0, b.id) } }, uniquingKeysWith: { a, _ in a })
        let folders = Set(role.values)
        let (inbox, archive, drafts, sent, trash) = (role["inbox"]!, role["archive"]!, role["drafts"]!, role["sent"]!, role["trash"]!)

        // Reading
        let page = try await client.conversations(account: account, mailbox: inbox, limit: 50)
        XCTAssertGreaterThan(page.total, 0)
        let conversation = page.list[0]
        let thread = try await client.conversation(account: account, threadId: conversation.id)
        XCTAssertEqual(thread.count, conversation.count)
        let email = thread.last!
        XCTAssertNotNil(email.html)
        XCTAssertFalse(email.text.isEmpty)
        XCTAssertTrue(email.isUnread)
        let found = try await client.conversations(account: account, mailbox: inbox, search: email.subject ?? "", limit: 50)
        XCTAssertTrue(found.list.contains { $0.id == conversation.id })
        for file in email.attachments ?? [] {
            let data = try await client.download(file, account: account)
            XCTAssertEqual(data.count, file.size)
        }

        // Changing
        try await client.update(account: account, [email.id: Patch.keyword("$seen", true)])
        try await client.update(account: account, [email.id: Patch.move(email, to: archive, folders: folders)])
        let archived = try await client.conversations(account: account, mailbox: archive, limit: 50)
        XCTAssertTrue(archived.list.contains { $0.id == conversation.id })
        try await client.update(account: account, [email.id: Patch.restore(email)])
        let members = try await client.members(account: account, threadIds: [conversation.id])
        XCTAssertEqual(members.first { $0.id == email.id }?.mailboxIds, email.mailboxIds)
        XCTAssertEqual(members.first { $0.id == email.id }?.isUnread, false)
        if let snoozed = role["snoozed"] {
            try await client.update(account: account, [email.id: Patch.snooze(email, until: Date().addingTimeInterval(3600), snoozedMailbox: snoozed, folders: folders)])
            let waiting = try await client.conversations(account: account, mailbox: snoozed, limit: 50)
            XCTAssertTrue(waiting.list.contains { $0.id == conversation.id })
            try await client.update(account: account, [email.id: Patch.move(email, to: inbox, folders: folders)])
        }

        // Writing: a reply with a file, saved, edited, then sent
        let identities = try await client.identities(account: account)
        let me = try XCTUnwrap(identities.first)
        let blob = try await client.upload(Data("hello".utf8), type: "text/plain", account: account)
        var reply = Draft.reply(to: email, all: true, account: account, identities: identities)
        reply.files.append(.init(blobId: blob.blobId, name: "hello.txt", type: blob.type, size: blob.size))
        let first = try await client.save(reply, from: me, draftsMailbox: drafts)
        reply.replaces = first
        reply.body = "Sounds good." + reply.body
        let second = try await client.save(reply, from: me, draftsMailbox: drafts)
        let saved = try await client.conversations(account: account, mailbox: drafts, limit: 50).list.map(\.email.id)
        XCTAssertTrue(saved.contains(second))
        XCTAssertFalse(saved.contains(first))
        try await client.submit(emailId: second, account: account, identity: me, recipients: reply.recipients, draftsMailbox: drafts, sentMailbox: sent)
        let after = try await client.conversation(account: account, threadId: conversation.id)
        let mine = try XCTUnwrap(after.first { $0.mailboxIds[sent] == true })
        XCTAssertEqual(mine.subject, reply.subject)
        XCTAssertFalse(mine.isDraft)
        XCTAssertEqual(mine.attachments?.map(\.name), ["hello.txt"])

        // A forward carries the original's files; a scheduled send waits in Sent
        var forward = Draft.forward(email, account: account, identities: identities)
        forward.to = "grace@example.com"
        let fwd = try await client.save(forward, from: me, draftsMailbox: drafts)
        try await client.submit(emailId: fwd, account: account, identity: me, recipients: forward.recipients, draftsMailbox: drafts, sentMailbox: sent)
        var later = Draft.new(account: account, identity: me, to: user)
        later.subject = "Later"
        let held = try await client.save(later, from: me, draftsMailbox: drafts)
        try await client.submit(emailId: held, account: account, identity: me, recipients: later.recipients, sendAt: Date().addingTimeInterval(86_400), draftsMailbox: drafts, sentMailbox: sent)
        let outbox = try await client.conversations(account: account, mailbox: sent, limit: 50).list
        XCTAssertTrue(outbox.contains { $0.email.subject == "Later" })
        let forwarded = try XCTUnwrap(outbox.first { $0.email.subject == forward.subject })
        let fwdEmail = try await client.conversation(account: account, threadId: forwarded.id).first { $0.subject == forward.subject }
        XCTAssertEqual(Set(fwdEmail?.attachments?.compactMap(\.name) ?? []), Set(email.attachments?.compactMap(\.name) ?? []))

        // Deleting: to the Trash, then for good
        try await client.update(account: account, [mine.id: Patch.move(mine, to: trash, folders: folders)])
        try await client.destroy(account: account, ids: [mine.id])
        let gone = try await client.members(account: account, threadIds: [conversation.id])
        XCTAssertFalse(gone.contains { $0.id == mine.id })
    }
}
