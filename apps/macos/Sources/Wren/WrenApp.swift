import AppKit
import SwiftUI
import WrenKit

@main
struct WrenApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = MailStore()

    var body: some Scene {
        Window("Wren", id: "main") {
            RootView()
                .environment(store)
        }
        .defaultSize(width: 1100, height: 700)
        .commands { MailCommands(store: store) }

        WindowGroup("New Message", id: "compose", for: Draft.self) { $draft in
            ComposeView(value: $draft)
                .environment(store)
        }
        .defaultSize(width: 640, height: 560)

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // A bare `swift run` binary starts as a background process; make it a regular app with a Dock icon.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }
}

struct RootView: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        Group {
            switch store.phase {
            case .starting: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signedOut: SignInView()
            case .signedIn: MainView()
            }
        }
        .onAppear { store.restore() }
    }
}

struct MailCommands: Commands {
    let store: MailStore
    @Environment(\.openWindow) private var openWindow

    private var selection: Set<String> { store.selectedThreads }
    private var signedIn: Bool { store.phase == .signedIn }

    private func act(_ action: @escaping (MailStore, Set<String>) async -> Void) {
        let ids = selection
        Task { await action(store, ids) }
    }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message") { if let d = store.newDraft() { openWindow(id: "compose", value: d) } }
                .keyboardShortcut("n")
                .disabled(!signedIn)
        }
        CommandMenu("Mailbox") {
            Button("Get New Mail") { Task { await store.refresh() } }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(!signedIn)
        }
        CommandMenu("Message") {
            Button("Reply") { if let d = store.replyDraft(all: false) { openWindow(id: "compose", value: d) } }
                .keyboardShortcut("r")
                .disabled(store.replyTarget == nil)
            Button("Reply All") { if let d = store.replyDraft(all: true) { openWindow(id: "compose", value: d) } }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(store.replyTarget == nil)
            Button("Forward") { if let d = store.forwardDraft() { openWindow(id: "compose", value: d) } }
                .keyboardShortcut("f", modifiers: [.command, .shift])
                .disabled(store.replyTarget == nil)
            Divider()
            Button("Archive") { act { await $0.archive($1) } }
                .keyboardShortcut("a", modifiers: [.command, .control])
                .disabled(selection.isEmpty || ["archive", "drafts", "sent"].contains(store.currentRole ?? ""))
            Button(store.currentRole == "trash" ? "Delete Forever…" : "Move to Trash") { act { await $0.trash($1) } }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(selection.isEmpty)
            Button(store.currentRole == "junk" ? "Not Junk" : "Move to Junk") { act { await $0.junk($1) } }
                .keyboardShortcut("j", modifiers: [.command, .shift])
                .disabled(selection.isEmpty || ["drafts", "sent"].contains(store.currentRole ?? ""))
            Divider()
            Button("Mark as Read") { act { await $0.setRead($1, true) } }
                .disabled(selection.isEmpty)
            Button("Mark as Unread") { act { await $0.setRead($1, false) } }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                .disabled(selection.isEmpty)
            Button("Flag") { act { await $0.toggleFlag($1) } }
                .keyboardShortcut("l", modifiers: [.command, .shift])
                .disabled(selection.isEmpty)
            Menu("Snooze") {
                ForEach(SnoozeTime.choices(), id: \.title) { choice in
                    Button(choice.title) { act { await $0.snooze($1, until: choice.date) } }
                }
            }
            .disabled(selection.isEmpty || !store.canSnooze)
        }
    }
}
