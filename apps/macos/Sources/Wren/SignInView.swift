import SwiftUI
import WrenKit

struct SignInView: View {
    @Environment(MailStore.self) private var store
    @AppStorage("server") private var server = ""
    @AppStorage("username") private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    private var ready: Bool { !server.isEmpty && !username.isEmpty && !password.isEmpty && !busy }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bird.fill")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Sign in to Wren")
                .font(.title.weight(.semibold))
            Text("Use an app password, not your account password. Create one in Wren on the web, under Settings → Security → Mail apps.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)

            Form {
                TextField("Server", text: $server, prompt: Text("mail.example.com"))
                TextField("Email", text: $username, prompt: Text("you@example.com"))
                    .textContentType(.username)
                SecureField("App password", text: $password)
                    .textContentType(.password)
            }
            .formStyle(.grouped)
            .frame(width: 420)
            .fixedSize(horizontal: false, vertical: true)
            .disabled(busy)
            .onSubmit { if ready { signIn() } }

            if let message = error ?? store.signInMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .frame(maxWidth: 400)
                    .multilineTextAlignment(.center)
            }

            Button {
                signIn()
            } label: {
                if busy { ProgressView().controlSize(.small) } else { Text("Sign In") }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(!ready)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func signIn() {
        guard let url = ServerAddress.url(from: server) else {
            error = "Enter your Wren server’s address, such as mail.example.com. It has to use https."
            return
        }
        error = nil
        busy = true
        Task {
            do {
                try await store.signIn(server: url, username: username.trimmingCharacters(in: .whitespaces).lowercased(), password: password.trimmingCharacters(in: .whitespacesAndNewlines))
                password = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
