import Foundation
import XCTest
@testable import WrenKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class WrenKitTests: XCTestCase {
    func testJSONRoundTripsAndKeepsIntegersWhole() throws {
        let value: JSON = ["limit": 50, "ratio": 0.5, "on": true, "none": nil, "list": ["a", 1]]
        let text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        XCTAssertTrue(text.contains("\"limit\":50"), text)
        XCTAssertFalse(text.contains("50.0"), text)
        XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: Data(text.utf8)), value)
        XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: Data("[true, 1]".utf8)), [true, 1])
    }

    func testServerAddressNeedsHTTPSExceptOnThisMac() {
        XCTAssertEqual(ServerAddress.url(from: " mail.example.com ")?.absoluteString, "https://mail.example.com")
        XCTAssertEqual(ServerAddress.url(from: "https://mail.example.com/inbox?x=1")?.absoluteString, "https://mail.example.com")
        XCTAssertEqual(ServerAddress.url(from: "http://localhost:8787")?.absoluteString, "http://localhost:8787")
        XCTAssertNil(ServerAddress.url(from: "http://mail.example.com"))
        XCTAssertNil(ServerAddress.url(from: "ftp://mail.example.com"))
        XCTAssertNil(ServerAddress.url(from: ""))
    }

    func testAddressesParseNamesQuotesAndSeparators() throws {
        let list = try Addresses.parse("Ada <ada@example.com>, bob@example.org; \"Hopper, Grace\" <grace@navy.mil>\n")
        XCTAssertEqual(list, [
            EmailAddress(name: "Ada", email: "ada@example.com"),
            EmailAddress(email: "bob@example.org"),
            EmailAddress(name: "Hopper, Grace", email: "grace@navy.mil"),
        ])
        XCTAssertEqual(try Addresses.parse(" , "), [])
        XCTAssertThrowsError(try Addresses.parse("ada@example.com, not an address")) { error in
            XCTAssertEqual(error as? Addresses.Invalid, Addresses.Invalid(text: "not an address"))
        }
        XCTAssertThrowsError(try Addresses.parse("ada@localhost"))
        XCTAssertEqual(EmailAddress(name: "Hopper, Grace", email: "g@navy.mil").formatted, "\"Hopper, Grace\" <g@navy.mil>")
        XCTAssertEqual(try Addresses.parse(EmailAddress(name: "Hopper, Grace", email: "g@navy.mil").formatted).first?.name, "Hopper, Grace")
    }

    func testTemplatesAreFilledSafely() {
        XCTAssertEqual(
            expand("https://x/jmap/download/{accountId}/{blobId}/{name}?accept={type}", ["accountId": "u1", "blobId": "A7", "name": "Q3 plan/final.pdf", "type": "application/pdf"]),
            "https://x/jmap/download/u1/A7/Q3%20plan%2Ffinal.pdf?accept=application%2Fpdf"
        )
    }

    func testReplyAllSkipsMeAndThreads() {
        let me = Identity(id: "I1", name: "Ada", email: "ada@wren.test", textSignature: "Ada\nWren")
        let email = Email(
            id: "M1", threadId: "T1", mailboxIds: ["inbox": true], keywords: [:],
            from: [EmailAddress(name: "Grace", email: "grace@example.com")],
            to: [EmailAddress(name: "Ada", email: "ADA@wren.test"), EmailAddress(email: "bob@example.com")],
            cc: [EmailAddress(email: "grace@example.com"), EmailAddress(email: "carol@example.com")],
            subject: "Lunch?", receivedAt: Date(timeIntervalSince1970: 0), messageId: ["m1@example.com"], references: ["m0@example.com"],
            textBody: [BodyPart(partId: "t", size: 5, type: "text/plain")], bodyValues: ["t": BodyValue(value: "Noon?\n> earlier")]
        )
        let d = Draft.reply(to: email, all: true, account: "u1", identities: [me])
        XCTAssertEqual(d.to, "Grace <grace@example.com>")
        XCTAssertEqual(d.cc, "bob@example.com, carol@example.com")
        XCTAssertEqual(d.subject, "Re: Lunch?")
        XCTAssertEqual(d.identityId, "I1")
        XCTAssertEqual(d.inReplyTo, ["m1@example.com"])
        XCTAssertEqual(d.references, ["m0@example.com", "m1@example.com"])
        XCTAssertTrue(d.body.hasPrefix("\n\nAda\nWren\n\n"), d.body)
        XCTAssertTrue(d.body.hasSuffix("Grace wrote:\n\n> Noon?\n>> earlier"), d.body)
        XCTAssertEqual(Draft.reply(to: email, all: false, account: "u1", identities: [me]).cc, "")
        XCTAssertEqual(Draft.prefixed("Re:", "RE: Lunch?"), "RE: Lunch?")

        // Replying to your own sent message goes to its recipients.
        var sent = email
        sent.from = [EmailAddress(email: "ada@wren.test")]
        XCTAssertEqual(Draft.reply(to: sent, all: false, account: "u1", identities: [me]).to, "Ada <ADA@wren.test>, bob@example.com")
    }

    func testDraftBecomesAnEmailSetCreate() throws {
        var d = Draft(accountId: "u1", identityId: "I1")
        d.to = "Grace <grace@example.com>"
        d.subject = "Hi"
        d.body = "Hello"
        d.files = [.init(blobId: "A3", name: "a.txt", type: "text/plain", size: 2)]
        let o = try d.emailObject(from: Identity(id: "I1", name: "Ada", email: "ada@wren.test"), draftsMailbox: "drafts")
        XCTAssertEqual(o["mailboxIds"], ["drafts": true])
        XCTAssertEqual(o["from"], [["name": "Ada", "email": "ada@wren.test"]])
        XCTAssertEqual(o["to"], [["name": "Grace", "email": "grace@example.com"]])
        XCTAssertEqual(o["bodyValues"]?["body"]?["value"], "Hello")
        XCTAssertEqual(o["attachments"]?.array?.first?["blobId"], "A3")
        // A draft saves even with an address that's still being typed; sending checks first.
        d.cc = "nope, bob@example.org"
        XCTAssertEqual(try d.emailObject(from: Identity(id: "I1", name: "Ada", email: "ada@wren.test"), draftsMailbox: "drafts")["cc"], [["email": "bob@example.org"]])
        XCTAssertThrowsError(try d.recipients)
    }

    func testMovesKeepLabelsAndReplaceTheFolder() {
        let email = Email(id: "M1", threadId: "T1", mailboxIds: ["inbox": true, "L1C2": true], keywords: [:])
        let folders: Set<String> = ["inbox", "archive", "trash", "snoozed"]
        XCTAssertEqual(Patch.move(email, to: "archive", folders: folders), ["mailboxIds": ["archive": true, "L1C2": true]])
        XCTAssertEqual(Patch.restore(email), ["mailboxIds": ["inbox": true, "L1C2": true]])
        XCTAssertEqual(Patch.keyword("$seen", false), ["keywords/$seen": nil])
        let snooze = Patch.snooze(email, until: Date(timeIntervalSince1970: 86_400), snoozedMailbox: "snoozed", folders: folders)
        XCTAssertEqual(snooze, ["mailboxIds": ["snoozed": true, "L1C2": true], "snoozed": ["until": "1970-01-02T00:00:00Z"]])
    }

    func testSnoozeTimes() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = { (text: String) in try! Date(text, strategy: .iso8601) }
        // A Tuesday morning: tonight, tomorrow morning, and next Monday.
        XCTAssertEqual(SnoozeTime.choices(now: date("2026-10-27T10:00:00Z"), calendar: calendar).map(\.date), [
            date("2026-10-27T21:00:00Z"), date("2026-10-28T08:00:00Z"), date("2026-11-02T08:00:00Z"),
        ])
        // Late on a Monday: no "tonight", and next week means the Monday after.
        XCTAssertEqual(SnoozeTime.choices(now: date("2026-11-02T22:00:00Z"), calendar: calendar).map(\.date), [
            date("2026-11-03T08:00:00Z"), date("2026-11-09T08:00:00Z"),
        ])
    }

    func testHTMLBecomesReadableText() {
        let html = "<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Ada,</p><p>Line one<br>Line two</p><ul><li>A</li><li>B &amp; C</li></ul></body></html>"
        XCTAssertEqual(plainText(fromHTML: html), "Hi Ada,\nLine one\nLine two\n• A\n• B & C")
    }

    func testInlineImagesAreNotListedAsFiles() {
        var email = Email(id: "M1", threadId: "T1", mailboxIds: [:], keywords: [:])
        email.htmlBody = [BodyPart(partId: "h", size: 1, type: "text/html")]
        email.bodyValues = ["h": BodyValue(value: "<img src=\"cid:logo@x\">")]
        email.attachments = [
            BodyPart(partId: "a1", blobId: "A1", size: 1, name: "logo.png", type: "image/png", disposition: "inline", cid: "logo@x"),
            BodyPart(partId: "a2", blobId: "A2", size: 1, name: "plan.pdf", type: "application/pdf", disposition: "attachment"),
        ]
        XCTAssertEqual(email.files.map(\.name), ["plan.pdf"])
        XCTAssertEqual(email.text, "")
    }

    func testMethodErrorsAndSetErrorsThrow() throws {
        let body: JSON = ["methodResponses": [["error", ["type": "invalidArguments", "description": "Nope"], "0"]]]
        XCTAssertThrowsError(try Responses(body)) { XCTAssertEqual($0 as? JMAPError, .method("invalidArguments", "Nope")) }
        XCTAssertThrowsError(try checkSet(["notUpdated": ["M1": ["type": "forbidden", "description": "On legal hold"]]])) {
            XCTAssertEqual($0.localizedDescription, "On legal hold")
        }
        XCTAssertNoThrow(try checkSet(["notDestroyed": ["M1": ["type": "notFound"]]], ignoringMissing: true))
    }

    func testConversationsAreOneRequest() async throws {
        let client = JMAPClient(server: URL(string: "https://mail.test")!, username: "ada@wren.test", password: "wren_app", http: Mock.session)
        Mock.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Basic " + Data("ada@wren.test:wren_app".utf8).base64EncodedString())
            if request.url?.path == "/jmap/session" {
                return [
                    "apiUrl": "https://mail.test/jmap/api", "downloadUrl": "", "uploadUrl": "", "username": "ada@wren.test",
                    "capabilities": [Capability.core: [:], Capability.mail: [:], Capability.snooze: [:]],
                    "accounts": [
                        "u2": ["name": "team@wren.test", "isPersonal": false, "accountCapabilities": [Capability.mail: [:]]],
                        "u1": ["name": "ada@wren.test", "isPersonal": true, "accountCapabilities": [Capability.mail: [:], Capability.snooze: [:]]],
                    ],
                ]
            }
            let body = try JSONDecoder().decode(JSON.self, from: Mock.body(of: request))
            XCTAssertEqual(body["using"], [.string(Capability.core), .string(Capability.mail), .string(Capability.submission), .string(Capability.snooze)])
            let calls = body["methodCalls"]?.array ?? []
            XCTAssertEqual(calls.map { $0.array?[0] }, ["Email/query", "Email/get", "Thread/get"])
            XCTAssertEqual(calls[0].array?[1]["filter"], ["inMailbox": "inbox", "text": "lunch"])
            XCTAssertEqual(calls[2].array?[1]["#ids"]?["path"], "/list/*/threadId")
            return ["methodResponses": [
                ["Email/query", ["ids": ["M1"], "total": 7], "0"],
                ["Email/get", ["list": [[
                    "id": "M1", "threadId": "T1", "mailboxIds": ["inbox": true], "keywords": ["$seen": true],
                    "from": [["name": nil, "email": "grace@example.com"]], "subject": "Lunch", "receivedAt": "2026-10-26T09:30:00Z",
                ]]], "1"],
                ["Thread/get", ["list": [["id": "T1", "emailIds": ["M0", "M1"]]]], "2"],
            ]]
        }
        let session = try await client.connect()
        XCTAssertEqual(session.mailAccounts.map(\.id), ["u1", "u2"])
        XCTAssertEqual(session.mailAccounts.map(\.canSnooze), [true, false])
        let page = try await client.conversations(account: "u1", mailbox: "inbox", search: " lunch ", limit: 50)
        XCTAssertEqual(page.total, 7)
        XCTAssertEqual(page.list.first?.count, 2)
        XCTAssertEqual(page.list.first?.email.receivedAt, Date(timeIntervalSince1970: 1_793_007_000))
        XCTAssertEqual(page.list.first?.email.isUnread, false)
    }

    func testWrongPasswordReadsWell() async {
        let client = JMAPClient(server: URL(string: "https://mail.test")!, username: "ada@wren.test", password: "nope", http: Mock.session)
        Mock.handler = { _ in Mock.Reply(status: 401, json: ["detail": "Sign in with your email address and an app password from Wren’s Settings"]) }
        do {
            try await client.connect()
            XCTFail("signed in")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Sign in with your email address and an app password from Wren’s Settings")
        }
    }
}

/// Answers the client's requests in tests.
final class Mock: URLProtocol {
    struct Reply: ExpressibleByDictionaryLiteral {
        var status = 200
        var json: JSON
        init(status: Int, json: JSON) {
            self.status = status
            self.json = json
        }
        init(dictionaryLiteral elements: (String, JSON)...) {
            json = .object(Dictionary(elements, uniquingKeysWith: { $1 }))
        }
    }

    nonisolated(unsafe) static var handler: (URLRequest) throws -> Reply = { _ in [:] }

    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Mock.self]
        return URLSession(configuration: config)
    }()

    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        do {
            let reply = try Mock.handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONEncoder().encode(reply.json))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
}
