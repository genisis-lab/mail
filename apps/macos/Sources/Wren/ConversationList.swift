import SwiftUI
import WrenKit

struct ConversationList: View {
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var store = store
        let showRecipients = store.currentRole == "sent" || store.currentRole == "drafts"
        List(selection: $store.selectedThreads) {
            ForEach(store.conversations) { conversation in
                ConversationRow(conversation: conversation, showRecipients: showRecipients)
                    .tag(conversation.id)
                    .swipeActions(edge: .leading) {
                        let unread = conversation.email.isUnread
                        Button {
                            Task { await store.setRead([conversation.id], unread) }
                        } label: {
                            Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await store.trash([conversation.id]) }
                        } label: {
                            Label("Trash", systemImage: "trash")
                        }
                        if !["archive", "drafts", "sent"].contains(store.currentRole ?? "") {
                            Button {
                                Task { await store.archive([conversation.id]) }
                            } label: {
                                Label("Archive", systemImage: "archivebox")
                            }
                            .tint(.indigo)
                        }
                    }
            }
            if store.conversations.count < store.total {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .onAppear { Task { await store.loadMore() } }
            }
        }
        .contextMenu(forSelectionType: String.self) { ids in
            MessageActions(ids: ids)
        } primaryAction: { ids in
            // Double-clicking a draft opens it to keep writing, as in Mail.
            if ids.count == 1, let draft = store.thread.last(where: { $0.isDraft && ids.contains($0.threadId) }), let d = store.editDraft(draft) {
                openWindow(id: "compose", value: d)
            }
        }
        .onDeleteCommand {
            let ids = store.selectedThreads
            Task { await store.trash(ids) }
        }
        .overlay {
            if store.conversations.isEmpty && !store.isLoading {
                if store.search.isEmpty {
                    ContentUnavailableView("No Messages", systemImage: "tray")
                } else {
                    ContentUnavailableView.search(text: store.search)
                }
            }
        }
        .navigationTitle(store.mailbox(store.selectedMailbox)?.name ?? "Wren")
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItem {
                Button {
                    if let d = store.newDraft() { openWindow(id: "compose", value: d) }
                } label: {
                    Label("New Message", systemImage: "square.and.pencil")
                }
                .help("New Message (⌘N)")
            }
        }
        .task(id: store.selectedMailbox) { await store.showMailbox() }
        .task(id: store.search) {
            // Search as you type, once typing pauses.
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { await store.loadList() }
        }
    }

    private var subtitle: String {
        if !store.search.isEmpty { return store.total == 1 ? "1 result" : "\(store.total.formatted()) results" }
        let unread = store.mailbox(store.selectedMailbox)?.unreadEmails ?? 0
        let all = store.total == 1 ? "1 conversation" : "\(store.total.formatted()) conversations"
        return unread > 0 && store.currentRole != "drafts" ? "\(all), \(unread.formatted()) unread" : all
    }
}

struct ConversationRow: View {
    let conversation: Conversation
    let showRecipients: Bool

    private var email: Email { conversation.email }

    private var who: String {
        let people = showRecipients ? (email.to ?? []) : (email.from ?? [])
        let names = people.map(\.displayName).joined(separator: ", ")
        return names.isEmpty ? (showRecipients ? "No Recipients" : "Unknown Sender") : names
    }

    private var subject: String {
        let s = email.subject ?? ""
        return s.isEmpty ? "(No Subject)" : s
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(.tint)
                .frame(width: 8, height: 8)
                .padding(.top, 5)
                .opacity(email.isUnread ? 1 : 0)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(who)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    if conversation.count > 1 {
                        Text(conversation.count.formatted())
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if email.isFlagged {
                        Image(systemName: "flag.fill").imageScale(.small).foregroundStyle(.orange)
                    }
                    if email.hasAttachment == true {
                        Image(systemName: "paperclip").imageScale(.small).foregroundStyle(.secondary)
                    }
                    Text(listDate(email.receivedAt))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(subject)
                    .font(.subheadline)
                    .lineLimit(1)
                Text(email.preview ?? "")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts: [String] = []
        if email.isUnread { parts.append("Unread") }
        if email.isFlagged { parts.append("Flagged") }
        parts.append((showRecipients ? "To " : "From ") + who)
        parts.append(subject)
        if conversation.count > 1 { parts.append("\(conversation.count) messages") }
        if email.hasAttachment == true { parts.append("Has attachments") }
        parts.append(listDate(email.receivedAt))
        if let preview = email.preview, !preview.isEmpty { parts.append(preview) }
        return parts.joined(separator: ", ")
    }
}

/// Today's mail shows the time; this week's the weekday; older mail the date.
func listDate(_ date: Date?, now: Date = .now, calendar: Calendar = .current) -> String {
    guard let date else { return "" }
    if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
    if calendar.isDateInYesterday(date) { return "Yesterday" }
    if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7, days >= 0 { return date.formatted(.dateTime.weekday(.wide)) }
    return date.formatted(date: .numeric, time: .omitted)
}

/// The actions for some conversations, in the list's context menu.
struct MessageActions: View {
    let ids: Set<String>
    @Environment(MailStore.self) private var store

    var body: some View {
        let role = store.currentRole ?? ""
        let rows = store.conversations.filter { ids.contains($0.id) }
        let anyUnread = rows.contains { $0.email.isUnread }
        Button(anyUnread ? "Mark as Read" : "Mark as Unread") { Task { await store.setRead(ids, anyUnread) } }
        Button(rows.allSatisfy(\.email.isFlagged) ? "Unflag" : "Flag") { Task { await store.toggleFlag(ids) } }
        Divider()
        if role == "snoozed" {
            Button("Move to Inbox") { Task { await store.moveToInbox(ids) } }
        }
        if !["archive", "drafts", "sent"].contains(role) {
            Button("Archive") { Task { await store.archive(ids) } }
        }
        Button(role == "trash" ? "Delete Forever…" : "Move to Trash") { Task { await store.trash(ids) } }
        if !["drafts", "sent"].contains(role) {
            Button(role == "junk" ? "Not Junk" : "Move to Junk") { Task { await store.junk(ids) } }
        }
        if store.canSnooze {
            Menu("Snooze") {
                ForEach(SnoozeTime.choices(), id: \.title) { choice in
                    Button(choice.title) { Task { await store.snooze(ids, until: choice.date) } }
                }
            }
        }
        if let account = store.selectedMailbox?.account, !store.labels(in: account).isEmpty {
            Menu("Labels") {
                ForEach(store.labels(in: account)) { label in
                    Toggle(label.name, isOn: Binding(
                        get: { store.hasLabel(label, ids) },
                        set: { on in Task { await store.setLabel(label, on, for: ids) } }
                    ))
                }
            }
        }
    }
}
