import SwiftUI
import WrenKit

struct SettingsView: View {
    var body: some View {
        TabView {
            AccountSettings()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
            ViewingSettings()
                .tabItem { Label("Viewing", systemImage: "eye") }
        }
        .frame(width: 460)
    }
}

struct AccountSettings: View {
    @Environment(MailStore.self) private var store
    @State private var confirming = false

    var body: some View {
        Form {
            if let client = store.client {
                LabeledContent("Signed in as", value: client.username)
                LabeledContent("Server", value: client.server.absoluteString)
                if store.accounts.count > 1 {
                    LabeledContent("Shared mailboxes") {
                        Text(store.accounts.filter { !$0.isPersonal }.map(\.name).joined(separator: "\n"))
                            .multilineTextAlignment(.trailing)
                    }
                }
                Button("Sign Out…", role: .destructive) { confirming = true }
            } else {
                Text("Not signed in.").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Sign out of Wren?", isPresented: $confirming) {
            Button("Sign Out", role: .destructive) { store.signOut() }
        } message: {
            Text("The app password is removed from this Mac. Your mail stays on the server; drafts you haven’t saved are lost.")
        }
    }
}

struct ViewingSettings: View {
    @AppStorage("loadRemoteContent") private var loadRemoteContent = false

    var body: some View {
        Form {
            Toggle("Load remote content in messages", isOn: $loadRemoteContent)
            Text("Remote images and fonts can tell a sender when you opened their message and roughly where you are. When this is off, each message has a button to load them.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
}
