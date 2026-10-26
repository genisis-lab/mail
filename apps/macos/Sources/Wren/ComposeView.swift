import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WrenKit

/// A message window, as in Mail. Closing it with changes saves it to Drafts; the trash button throws it away.
struct ComposeView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// The window's value, kept up to date so a window restored after quitting comes back as it was.
    @Binding var value: Draft?
    @State private var draft: Draft
    /// The draft as opened or last saved, to tell whether closing should save it.
    @State private var saved: Draft
    @State private var showBcc: Bool
    @State private var busy = false
    @State private var uploading = 0
    @State private var error: String?
    @State private var picking = false
    @State private var scheduling = false
    @State private var sendAt = Date.now.addingTimeInterval(3600)
    /// Sent or deleted: nothing to save on close.
    @State private var done = false
    @FocusState private var focus: Field?

    enum Field: Hashable { case to, cc, bcc, subject, body }

    init(value: Binding<Draft?>) {
        _value = value
        let d = value.wrappedValue ?? Draft(accountId: "")
        _draft = State(initialValue: d)
        _saved = State(initialValue: d)
        _showBcc = State(initialValue: !d.bcc.isEmpty)
    }

    private var identities: [Identity] { store.identities[draft.accountId] ?? [] }

    private var canSend: Bool {
        !busy && uploading == 0 && ((try? draft.recipients.isEmpty) == false)
    }

    var body: some View {
        VStack(spacing: 0) {
            addressRow("To:", $draft.to, .to)
            Divider()
            addressRow("Cc:", $draft.cc, .cc)
            if showBcc {
                Divider()
                addressRow("Bcc:", $draft.bcc, .bcc)
            }
            Divider()
            row("Subject:") {
                TextField("Subject", text: $draft.subject)
                    .textFieldStyle(.plain)
                    .labelsHidden()
                    .focused($focus, equals: .subject)
            }
            if identities.count > 1 {
                Divider()
                row("From:") {
                    Picker("From", selection: $draft.identityId) {
                        ForEach(identities) { Text($0.address.formatted).tag(Optional($0.id)) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    Spacer()
                }
            }
            Divider()
            TextEditor(text: $draft.body)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .focused($focus, equals: .body)
                .accessibilityLabel("Message")
            if !draft.files.isEmpty || uploading > 0 {
                Divider()
                files
            }
            if let error {
                Divider()
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .navigationTitle(draft.subject.isEmpty ? "New Message" : draft.subject)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    send(at: nil)
                } label: {
                    if busy { ProgressView().controlSize(.small) } else { Label("Send", systemImage: "paperplane.fill") }
                }
                .help("Send (⇧⌘D)")
                .keyboardShortcut("d", modifiers: [.command, .shift])
                .disabled(!canSend)
                Menu {
                    ForEach(SnoozeTime.choices(), id: \.title) { choice in
                        Button("Send \(choice.title)") { send(at: choice.date) }
                    }
                    Divider()
                    Button("Send Later…") { scheduling = true }
                } label: {
                    Label("Send Later", systemImage: "clock")
                }
                .help("Send Later")
                .disabled(!canSend)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { picking = true } label: { Label("Attach", systemImage: "paperclip") }
                    .help("Attach Files (⇧⌘A)")
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                Button { discard() } label: { Label("Delete Draft", systemImage: "trash") }
                    .help("Delete Draft")
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { attach($0) }
        .sheet(isPresented: $scheduling) {
            ScheduleSheet(date: $sendAt) { send(at: sendAt) }
        }
        .disabled(busy)
        .onAppear {
            // A window opened or restored without a message to write starts a new one.
            if draft.accountId.isEmpty, let d = store.newDraft() {
                draft = d
                saved = d
            }
            focus = draft.to.isEmpty ? .to : .body
        }
        .onChange(of: draft) { value = draft }
        .onDisappear { saveOnClose() }
    }

    private func row<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 60, alignment: .trailing)
                .accessibilityHidden(true)
            content()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private func addressRow(_ label: String, _ text: Binding<String>, _ field: Field) -> some View {
        // Checked once you leave the field, so typing isn't interrupted.
        let problem: String? = focus == field ? nil : {
            do {
                _ = try Addresses.parse(text.wrappedValue)
                return nil
            } catch {
                return error.localizedDescription
            }
        }()
        return row(label) {
            TextField(String(label.dropLast()), text: text)
                .textFieldStyle(.plain)
                .labelsHidden()
                .focused($focus, equals: field)
            if let problem {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.red)
                    .help(problem)
                    .accessibilityLabel(problem)
            }
            if field == .cc && !showBcc {
                Button("Bcc") { showBcc = true; focus = .bcc }
                    .buttonStyle(.borderless)
                    .help("Add a Bcc field")
            }
        }
    }

    private var files: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(draft.files, id: \.blobId) { file in
                    HStack(spacing: 6) {
                        Image(nsImage: NSWorkspace.shared.icon(for: UTType(mimeType: file.type) ?? .data))
                            .resizable()
                            .frame(width: 16, height: 16)
                        Text(file.name).lineLimit(1)
                        Text(Int64(file.size).formatted(.byteCount(style: .file))).foregroundStyle(.secondary)
                        Button {
                            draft.files.removeAll { $0.blobId == file.blobId }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .font(.callout)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(.quaternary.opacity(0.6), in: Capsule())
                }
                if uploading > 0 { ProgressView().controlSize(.small) }
            }
            .padding(10)
        }
    }

    private func attach(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        let account = draft.accountId
        for url in urls {
            uploading += 1
            Task {
                do {
                    draft.files.append(try await store.upload(url, account: account))
                } catch {
                    self.error = "\(url.lastPathComponent): \(error.localizedDescription)"
                }
                uploading -= 1
            }
        }
    }

    private func send(at date: Date?) {
        do {
            guard try !draft.recipients.isEmpty else {
                error = "Add someone to send this to."
                return
            }
        } catch {
            self.error = error.localizedDescription
            return
        }
        busy = true
        error = nil
        Task {
            do {
                // Saved first, so a failed send leaves the message in Drafts instead of losing it.
                let id = try await store.save(draft)
                draft.replaces = id
                saved = draft
                try await store.send(draft, savedAs: id, at: date)
                done = true
                dismiss()
            } catch {
                self.error = error.localizedDescription + (draft.replaces == nil ? "" : " The message is in Drafts.")
            }
            busy = false
        }
    }

    private func discard() {
        done = true
        let d = draft
        Task { await store.discard(d) }
        dismiss()
    }

    private func saveOnClose() {
        let d = draft
        let empty = [d.to, d.cc, d.bcc, d.subject, d.body].allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } && d.files.isEmpty
        guard !done, d != saved, !empty else { return }
        Task {
            do {
                _ = try await store.save(d)
            } catch {
                store.alert = "Your draft couldn’t be saved: \(error.localizedDescription)"
            }
        }
    }
}

struct ScheduleSheet: View {
    @Binding var date: Date
    let schedule: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Send Later").font(.headline)
            DatePicker("Send at", selection: $date, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.graphical)
                .labelsHidden()
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Schedule") {
                    dismiss()
                    schedule()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 320)
    }
}
