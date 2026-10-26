import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WrenKit

struct ReaderPane: View {
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch store.selectedThreads.count {
            case 0: ContentUnavailableView("No Message Selected", systemImage: "envelope")
            case 1: ConversationView().id(store.threadId)
            default: ContentUnavailableView("\(store.selectedThreads.count) Conversations Selected", systemImage: "tray.full")
            }
        }
        .task(id: store.selectedThreads) {
            await store.open(store.selectedThreads.count == 1 ? store.selectedThreads.first : nil)
        }
        .toolbar { actions }
    }

    private func compose(_ draft: Draft?) {
        if let draft { openWindow(id: "compose", value: draft) }
    }

    private func act(_ action: @escaping (MailStore, Set<String>) async -> Void) {
        let ids = store.selectedThreads
        Task { await action(store, ids) }
    }

    @ToolbarContentBuilder
    private var actions: some ToolbarContent {
        let role = store.currentRole ?? ""
        let none = store.selectedThreads.isEmpty
        ToolbarItemGroup {
            Button { act { await $0.archive($1) } } label: { Label("Archive", systemImage: "archivebox") }
                .help("Archive")
                .disabled(none || ["archive", "drafts", "sent"].contains(role))
            Button { act { await $0.trash($1) } } label: { Label(role == "trash" ? "Delete Forever" : "Trash", systemImage: "trash") }
                .help(role == "trash" ? "Delete Forever" : "Move to Trash")
                .disabled(none)
            Button { act { await $0.junk($1) } } label: { Label(role == "junk" ? "Not Junk" : "Junk", systemImage: role == "junk" ? "tray.and.arrow.up" : "xmark.bin") }
                .help(role == "junk" ? "Not Junk" : "Move to Junk")
                .disabled(none || ["drafts", "sent"].contains(role))
        }
        ToolbarItemGroup {
            Button { compose(store.replyDraft(all: false)) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                .help("Reply")
                .disabled(store.replyTarget == nil)
            Button { compose(store.replyDraft(all: true)) } label: { Label("Reply All", systemImage: "arrowshape.turn.up.left.2") }
                .help("Reply All")
                .disabled(store.replyTarget == nil)
            Button { compose(store.forwardDraft()) } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
                .help("Forward")
                .disabled(store.replyTarget == nil)
        }
        ToolbarItemGroup {
            Button { act { await $0.toggleFlag($1) } } label: { Label("Flag", systemImage: "flag") }
                .help("Flag")
                .disabled(none)
            Menu {
                ForEach(SnoozeTime.choices(), id: \.title) { choice in
                    Button(choice.title) { act { await $0.snooze($1, until: choice.date) } }
                }
            } label: {
                Label("Snooze", systemImage: "moon.zzz")
            }
            .help("Snooze")
            .disabled(none || !store.canSnooze)
        }
    }
}

/// A conversation, oldest message first. Older read messages fold to one line; click to open them.
struct ConversationView: View {
    @Environment(MailStore.self) private var store
    @State private var opened: Set<String> = []

    var body: some View {
        let thread = store.thread
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let last = thread.last {
                    Text((last.subject ?? "").isEmpty ? "(No Subject)" : last.subject!)
                        .font(.title2.weight(.semibold))
                        .textSelection(.enabled)
                        .padding(.horizontal, 20)
                        .padding(.top, 20)
                        .padding(.bottom, 4)
                }
                ForEach(thread) { email in
                    let expanded = email.id == thread.last?.id || opened.contains(email.id) || store.unreadWhenOpened.contains(email.id)
                    MessageView(email: email, expanded: expanded) {
                        if opened.contains(email.id) { opened.remove(email.id) } else { opened.insert(email.id) }
                    }
                    if email.id != thread.last?.id { Divider().padding(.leading, 66) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .overlay {
            if thread.isEmpty { ProgressView() }
        }
    }
}

struct MessageView: View {
    let email: Email
    let expanded: Bool
    let toggle: () -> Void
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @AppStorage("loadRemoteContent") private var loadRemoteAlways = false
    @State private var loadRemote = false

    private var sender: EmailAddress? { email.from?.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                header
                if expanded { messageMenu }
            }

            if expanded {
                if email.isDraft, let draft = store.editDraft(email) {
                    Button("Edit Draft") { openWindow(id: "compose", value: draft) }
                }
                let allowRemote = loadRemote || loadRemoteAlways
                if let html = email.html, !allowRemote, hasRemoteContent(html) {
                    HStack {
                        Label("Remote content is hidden to protect your privacy.", systemImage: "eye.slash")
                        Spacer()
                        Button("Load Remote Content") { loadRemote = true }
                    }
                    .font(.callout)
                    .padding(10)
                    .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                }
                MessageBody(email: email, allowRemote: allowRemote)
                if !email.files.isEmpty { AttachmentList(files: email.files) }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    /// Who, when and to whom; click to fold or open the message.
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(address: sender)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(sender?.displayName ?? "Unknown Sender")
                        .font(.headline)
                    if email.isDraft {
                        Text("Draft").font(.caption.weight(.medium)).foregroundStyle(.red)
                    }
                    Spacer()
                    Text(email.receivedAt?.formatted(date: .abbreviated, time: .shortened) ?? "")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if expanded {
                    // The address itself, not just the name, so a lookalike sender is easy to spot.
                    if let address = sender?.email, address != sender?.displayName {
                        Text(address).font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    recipients("To", email.to)
                    recipients("Cc", email.cc)
                } else {
                    Text(email.preview ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { toggle() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(expanded ? "Folds this message" : "Shows this message")
    }

    @ViewBuilder
    private func recipients(_ label: String, _ list: [EmailAddress]?) -> some View {
        if let list, !list.isEmpty {
            Text("\(label): " + list.map(\.displayName).joined(separator: ", "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .textSelection(.enabled)
                .help(list.map(\.formatted).joined(separator: ", "))
        }
    }

    /// Reply, Reply All and Forward for this message (the toolbar's act on the newest).
    private var messageMenu: some View {
        Menu {
            Button("Reply") { if let d = store.replyDraft(to: email, all: false) { openWindow(id: "compose", value: d) } }
            Button("Reply All") { if let d = store.replyDraft(to: email, all: true) { openWindow(id: "compose", value: d) } }
            Button("Forward") { if let d = store.forwardDraft(of: email) { openWindow(id: "compose", value: d) } }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Message actions")
    }
}

/// Whether an HTML body loads anything from the web (images, styles, fonts).
func hasRemoteContent(_ html: String) -> Bool {
    html.range(of: #"(?i)(\bsrc|\bsrcset|\bbackground|<link\b[^>]*\bhref)\s*=\s*["']?\s*(https?:)?//|url\(\s*["']?\s*(https?:)?//"#, options: .regularExpression) != nil
}

struct MessageBody: View {
    let email: Email
    let allowRemote: Bool
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var height: CGFloat = 80

    var body: some View {
        if let html = email.html {
            MessageWebView(html: html, allowRemote: allowRemote, inline: email.attachments ?? [], download: store.download, openLink: open, height: $height)
                .frame(height: height)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("Message")
        } else {
            Text(linked(email.text))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Links open in the browser; email addresses start a message here.
    private func open(_ url: URL) {
        if url.scheme?.lowercased() == "mailto" {
            let to = (url.absoluteString.dropFirst(7).split(separator: "?").first).map { String($0).removingPercentEncoding ?? String($0) } ?? ""
            if let d = store.newDraft(to: to) { openWindow(id: "compose", value: d) }
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    private func linked(_ text: String) -> AttributedString {
        var s = AttributedString(text)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return s }
        for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            if let url = match.url, let range = Range(match.range, in: s) { s[range].link = url }
        }
        return s
    }
}

struct Avatar: View {
    let address: EmailAddress?
    private static let colors: [Color] = [.blue, .indigo, .purple, .pink, .red, .orange, .green, .teal, .cyan, .brown]

    var body: some View {
        let name = address?.displayName ?? "?"
        let initials = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        // A stable color per address (hashValue changes between launches).
        let index = (address?.email.lowercased().unicodeScalars.reduce(0) { $0 + Int($1.value) } ?? 0) % Self.colors.count
        Circle()
            .fill(Self.colors[index].gradient)
            .frame(width: 36, height: 36)
            .overlay {
                Text(initials.isEmpty ? "?" : initials)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}

struct AttachmentList: View {
    let files: [BodyPart]
    @Environment(MailStore.self) private var store

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
            ForEach(files, id: \.self) { file in
                let name = file.name ?? "Attachment"
                Button {
                    Task { await store.openAttachment(file) }
                } label: {
                    HStack(spacing: 8) {
                        Image(nsImage: NSWorkspace.shared.icon(for: UTType(mimeType: file.type) ?? .data))
                            .resizable()
                            .frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name).lineLimit(1).truncationMode(.middle)
                            Text(Int64(file.size).formatted(.byteCount(style: .file)))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .help("Open \(name)")
                .contextMenu {
                    Button("Open") { Task { await store.openAttachment(file) } }
                    Button("Save to Downloads") { Task { await store.saveAttachment(file) } }
                }
            }
        }
    }
}
