import AppKit
import SwiftUI
import WrenKit

/// Screenshot run for CI only (this file lives on a throwaway branch): walks through the app's screens and saves each window.
struct Demo: ViewModifier {
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    private let env = ProcessInfo.processInfo.environment

    func body(content: Content) -> some View {
        content.task {
            guard let out = env["WREN_DEMO_OUT"] else { return }
            await run(URL(fileURLWithPath: out))
        }
    }

    private func wait(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }

    private func until(_ condition: () -> Bool) async {
        var tries = 0
        while !condition() && tries < 150 {
            await wait(0.2)
            tries += 1
        }
    }

    private func shoot(_ name: String, in dir: URL) {
        let tag = env["WREN_DEMO_TAG"] ?? "light"
        let windows = NSApp.windows.filter { $0.isVisible && $0.frame.width > 200 }
        for (i, window) in windows.enumerated() {
            guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution])
            else { print("demo: no image for window \(i)"); continue }
            let file = dir.appending(path: "\(tag)-\(name)-\(i).png")
            try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: file)
            print("demo: wrote \(file.lastPathComponent) (\(window.title))")
        }
        let screen = Process()
        screen.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        screen.arguments = ["-x", dir.appending(path: "\(tag)-\(name)-screen.png").path]
        try? screen.run()
        screen.waitUntilExit()
    }

    private func select(_ match: (Conversation) -> Bool) async {
        guard let c = store.conversations.first(where: match) else { print("demo: no conversation"); return }
        store.selectedThreads = [c.id]
        await until { store.thread.first?.threadId == c.id }
        await wait(2.5)
    }

    private func run(_ dir: URL) async {
        if env["WREN_DEMO_DARK"] == "1" { NSApp.appearance = NSAppearance(named: .darkAqua) }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSApp.windows.first?.setFrame(NSRect(x: 40, y: 80, width: 1200, height: 760), display: true)
        await until { store.phase != .starting }
        await wait(1.5)
        shoot("1-signin", in: dir)

        guard let server = env["WREN_DEMO_SERVER"].flatMap(URL.init(string:)), let user = env["WREN_DEMO_USER"], let password = env["WREN_DEMO_PASSWORD"]
        else { exit(1) }
        store.begin(JMAPClient(server: server, username: user, password: password))
        await until { !store.conversations.isEmpty }
        await wait(1.5)
        shoot("2-inbox", in: dir)

        await select { $0.count > 1 }
        shoot("3-thread", in: dir)
        let menu = NSApp.mainMenu?.items.first { $0.title == "Message" }?.submenu
        menu?.update()
        let states = (menu?.items ?? []).map { "\($0.title): \($0.isEnabled)" }.joined(separator: "\n")
        try? states.write(to: dir.appending(path: "\(env["WREN_DEMO_TAG"] ?? "light")-menu.txt"), atomically: true, encoding: .utf8)
        await select { $0.email.subject?.contains("variable") == true }
        shoot("4-html", in: dir)
        await select { $0.email.subject?.contains("Quarterly") == true }
        shoot("5-attachment", in: dir)

        await select { $0.count > 1 }
        if let draft = store.replyDraft(all: true) { openWindow(id: "compose", value: draft) }
        await wait(2.5)
        shoot("6-compose", in: dir)

        openSettings()
        await wait(2)
        shoot("7-settings", in: dir)
        exit(0)
    }
}
