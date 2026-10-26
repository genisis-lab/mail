import SwiftUI
import WrenKit

/// Mailboxes, conversations and the reader, side by side, as in Mail.
struct MainView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
        } content: {
            ConversationList()
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 560)
        } detail: {
            ReaderPane()
        }
        .searchable(text: $store.search, placement: .toolbar, prompt: "Search")
        .onAppear { store.undoManager = undoManager }
        .alert("Something went wrong", isPresented: Binding(get: { store.alert != nil }, set: { if !$0 { store.alert = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.alert ?? "")
        }
        .confirmationDialog(
            "Delete these conversations forever?",
            isPresented: Binding(get: { store.confirmingDelete != nil }, set: { if !$0 { store.confirmingDelete = nil } }),
            titleVisibility: .visible,
            presenting: store.confirmingDelete
        ) { ids in
            Button("Delete Forever", role: .destructive) { Task { await store.deleteForever(ids) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("You can’t undo this.")
        }
    }
}

struct Sidebar: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List(selection: $store.selectedMailbox) {
            ForEach(store.accounts) { account in
                let boxes = store.mailboxes[account.id] ?? []
                Section(account.isPersonal ? "Mailboxes" : account.name) {
                    ForEach(boxes.filter { $0.role != nil }) { box in
                        MailboxRow(mailbox: box).tag(MailboxRef(account: account.id, mailbox: box.id))
                    }
                }
                let labels = boxes.filter { $0.role == nil }
                if !labels.isEmpty {
                    Section(account.isPersonal ? "Labels" : "\(account.name) Labels") {
                        ForEach(labels) { box in
                            MailboxRow(mailbox: box).tag(MailboxRef(account: account.id, mailbox: box.id))
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if let problem = store.problem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
        }
    }
}

struct MailboxRow: View {
    let mailbox: Mailbox

    var body: some View {
        Label(mailbox.name, systemImage: icon)
            .badge(count)
    }

    /// Unread counts where they help; Drafts shows how many there are, as Mail does.
    private var count: Int {
        switch mailbox.role {
        case "drafts": mailbox.totalEmails
        case "sent", "archive", "trash": 0
        default: mailbox.unreadEmails
        }
    }

    private var icon: String {
        switch mailbox.role {
        case "inbox": "tray"
        case "archive": "archivebox"
        case "drafts": "doc"
        case "sent": "paperplane"
        case "junk": "xmark.bin"
        case "trash": "trash"
        case "snoozed": "moon.zzz"
        case nil: "tag"
        default: "folder"
        }
    }
}
