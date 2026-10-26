import Foundation
import Security

/// The app password lives in the login keychain, never in preferences.
enum Keychain {
    private static func query(_ username: String, _ server: URL) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Wren \(server.absoluteString)", kSecAttrAccount as String: username]
    }

    static func save(_ password: String, username: String, server: URL) throws {
        SecItemDelete(query(username, server) as CFDictionary)
        var item = query(username, server)
        item[kSecValueData as String] = Data(password.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Couldn’t save the app password in your keychain."])
        }
    }

    static func read(username: String, server: URL) -> String? {
        var q = query(username, server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(username: String, server: URL) {
        SecItemDelete(query(username, server) as CFDictionary)
    }
}
