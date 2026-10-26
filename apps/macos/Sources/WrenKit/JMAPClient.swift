import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum JMAPError: Error, LocalizedError, Equatable {
    case unauthorized(String?)
    case http(Int, String?)
    /// A method-level error (RFC 8620 3.6.2): its type and Wren's description.
    case method(String, String?)
    /// A record a /set call refused (notCreated, notUpdated, notDestroyed).
    case notSaved(String, String?)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .unauthorized(let detail): detail ?? "The email address or app password is wrong."
        case .http(404, _): "This server doesn’t offer mail apps. Check the address, and that an admin turned on mail apps in Wren."
        case .http(429, let detail): detail ?? "Too many attempts. Try again in a few minutes."
        case .http(let status, let detail): detail ?? "The server answered with an error (\(status))."
        case .method(let type, let detail): detail ?? "The server refused the request (\(type))."
        case .notSaved(let type, let detail): detail ?? "The change couldn’t be saved (\(type))."
        case .badResponse: "The server sent a reply Wren doesn’t understand."
        }
    }
}

public enum ServerAddress {
    /// The server's base URL from what someone typed ("mail.example.com", "https://mail.example.com/inbox").
    /// Only https, except on this Mac, so an app password never crosses the network in the clear.
    public static func url(from text: String) -> URL? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard var c = URLComponents(string: text), let host = c.host, !host.isEmpty, !host.contains(" ") else { return nil }
        let local = host == "localhost" || host == "127.0.0.1"
        guard c.scheme?.lowercased() == "https" || (c.scheme?.lowercased() == "http" && local) else { return nil }
        c.path = ""
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        return c.url
    }
}

/// The responses to one JMAP request, by call position. Throws on the first method error.
public struct Responses: Sendable {
    public let items: [(name: String, arguments: JSON, id: String)]

    init(_ body: JSON) throws {
        guard let list = body["methodResponses"]?.array else { throw JMAPError.badResponse }
        items = try list.map { item in
            guard let a = item.array, a.count == 3, let name = a[0].string, let id = a[2].string else { throw JMAPError.badResponse }
            if name == "error" { throw JMAPError.method(a[1]["type"]?.string ?? "serverFail", a[1]["description"]?.string) }
            return (name, a[1], id)
        }
    }

    /// The arguments of the response to call `index` (the first, when a call answers more than once).
    public subscript(index: Int) -> JSON {
        items.first { $0.id == String(index) }?.arguments ?? .null
    }
}

/// Throws the first record a /set call refused.
func checkSet(_ result: JSON, ignoringMissing: Bool = false) throws {
    for key in ["notCreated", "notUpdated", "notDestroyed"] {
        for error in (result[key]?.object ?? [:]).values {
            let type = error["type"]?.string ?? "serverFail"
            if ignoringMissing && type == "notFound" { continue }
            throw JMAPError.notSaved(type, error["description"]?.string)
        }
    }
}

/// Fill in an RFC 6570 level-1 URL template, such as the session's downloadUrl.
func expand(_ template: String, _ values: [String: String]) -> String {
    let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    var out = template
    for (key, value) in values {
        out = out.replacingOccurrences(of: "{\(key)}", with: value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")
    }
    return out
}

/// A JMAP client for one Wren sign-in (an email address and an app password).
public actor JMAPClient {
    public nonisolated let server: URL
    public nonisolated let username: String
    private let authorization: String
    private let http: URLSession
    public private(set) var session: Session?

    public init(server: URL, username: String, password: String, http: URLSession = URLSession(configuration: .ephemeral)) {
        self.server = server
        self.username = username
        self.authorization = "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
        self.http = http
    }

    /// Sign in: fetch the session, which lists the accounts and where to send requests.
    @discardableResult
    public func connect() async throws -> Session {
        let data = try await send(URLRequest(url: server.appendingPathComponent("jmap/session")))
        let session = try JSONDecoder.jmap.decode(Session.self, from: data)
        self.session = session
        return session
    }

    private func currentSession() async throws -> Session {
        if let session { return session }
        return try await connect()
    }

    private func send(_ request: URLRequest) async throws -> Data {
        var request = request
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        let (data, response) = try await http.data(for: request)
        try check(response, data)
        return data
    }

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let response = response as? HTTPURLResponse else { throw JMAPError.badResponse }
        guard (200..<300).contains(response.statusCode) else {
            let detail = (try? JSONDecoder().decode(JSON.self, from: data))?["detail"]?.string
            throw response.statusCode == 401 ? JMAPError.unauthorized(detail) : JMAPError.http(response.statusCode, detail)
        }
    }

    /// Make method calls in one request. Call `i` has the id "i", for result references.
    public func call(_ calls: [(String, JSON)]) async throws -> Responses {
        let session = try await currentSession()
        var using = [Capability.core, Capability.mail, Capability.submission]
        if session.capabilities[Capability.snooze] != nil { using.append(Capability.snooze) }
        let body: JSON = [
            "using": .array(using.map(JSON.string)),
            "methodCalls": .array(calls.enumerated().map { i, c in [.string(c.0), c.1, .string(String(i))] }),
        ]
        guard let url = URL(string: session.apiUrl) else { throw JMAPError.badResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await Responses(JSONDecoder().decode(JSON.self, from: send(request)))
    }

    public func upload(_ data: Data, type: String, account: String) async throws -> UploadedBlob {
        let session = try await currentSession()
        guard let url = URL(string: expand(session.uploadUrl, ["accountId": account])) else { throw JMAPError.badResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(type, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return try await JSONDecoder.jmap.decode(UploadedBlob.self, from: send(request))
    }

    public func download(_ part: BodyPart, account: String) async throws -> Data {
        let session = try await currentSession()
        guard let blobId = part.blobId else { throw JMAPError.badResponse }
        let link = expand(session.downloadUrl, ["accountId": account, "blobId": blobId, "name": part.name ?? "attachment", "type": part.type])
        guard let url = URL(string: link) else { throw JMAPError.badResponse }
        return try await send(URLRequest(url: url))
    }

    #if canImport(Darwin)
    /// Listen to the push stream and call `onChange` whenever something changes on the server
    /// (once right away, too). Returns when the server ends the stream, which Wren does every 15 minutes.
    public func listen(onChange: @escaping @Sendable () async -> Void) async throws {
        let session = try await currentSession()
        guard let template = session.eventSourceUrl, let url = URL(string: expand(template, ["types": "*", "closeafter": "no", "ping": "60"])) else { return }
        var request = URLRequest(url: url)
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Pings come every 60 seconds; longer than that without a byte means the connection is gone.
        request.timeoutInterval = 150
        let (bytes, response) = try await http.bytes(for: request)
        try check(response, Data())
        var event = ""
        for try await line in bytes.lines {
            if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("data:"), event == "state" { await onChange() }
        }
    }
    #endif
}
