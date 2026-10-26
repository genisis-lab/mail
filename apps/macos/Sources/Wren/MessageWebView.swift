import AppKit
import SwiftUI
import WebKit
import WrenKit

/// An HTML message body, locked down: no scripts, no cookies or storage, nothing from the web unless you ask,
/// and links open in your browser. Inline images (cid:) come from Wren. It's as tall as its content.
/// Mail that sets no colors of its own follows light and dark mode; mail that does keeps the white page it was made for.
struct MessageWebView: NSViewRepresentable {
    let html: String
    let allowRemote: Bool
    let inline: [BodyPart]
    let download: @MainActor (BodyPart) async throws -> Data
    let openLink: (URL) -> Void
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> MessageWKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "cid")
        // The message's scripts are off; this one runs in the app's own script world and reports the height as it changes.
        config.userContentController.addUserScript(WKUserScript(source: Self.reportHeight, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        config.userContentController.add(context.coordinator, contentWorld: .defaultClient, name: "height")
        let view = MessageWKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        context.coordinator.load(into: view)
        return view
    }

    func updateNSView(_ view: MessageWKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(into: view)
    }

    private static let reportHeight = """
    (() => {
      const m = document.getElementById('wren-message');
      let last = 0;
      if (m) new ResizeObserver(() => {
        const h = Math.ceil(m.getBoundingClientRect().height);
        if (h > 0 && h !== last) { last = h; webkit.messageHandlers.height.postMessage(h); }
      }).observe(m);
    })();
    """

    /// Whether the message leaves colors to us (most personal mail), so it can be shown in the app's own colors.
    static func followsAppearance(_ html: String) -> Bool {
        html.range(of: #"(?i)(color|background)\s*[:=]|bgcolor"#, options: .regularExpression) == nil
    }

    /// The page around the message. The Content-Security-Policy is what keeps remote content out: email can add
    /// its own policies, but policies only ever add up, so it can't loosen this one.
    static func document(_ html: String, allowRemote: Bool) -> String {
        let policy = allowRemote
            ? "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'"
            : "default-src 'none'; img-src cid: data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'"
        // System colors; where one isn’t known, the plain color set before it stays.
        let adaptive = followsAppearance(html) ? """
            :root { color-scheme: light dark; }
            html, body { background: -apple-system-text-background; }
            body { color: -apple-system-label; }
            #wren-message { padding: 0; }
            blockquote { color: -apple-system-secondary-label; border-left-color: -apple-system-separator; }
            """ : ""
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <meta http-equiv="x-dns-prefetch-control" content="off">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        html, body { margin: 0; padding: 0; background: #fff; }
        body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; color: #1d1d1f; word-wrap: break-word; }
        #wren-message { display: flow-root; padding: 14px 16px; }
        #wren-message > :first-child { margin-top: 0; }
        #wren-message > :last-child { margin-bottom: 0; }
        img { max-width: 100%; height: auto; }
        pre { white-space: pre-wrap; }
        blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #c7c7cc; color: #555; }
        \(adaptive)
        </style></head><body><div id="wren-message">\(html)</div></body></html>
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKURLSchemeHandler, WKScriptMessageHandler {
        var parent: MessageWebView
        private var loaded: (html: String, allowRemote: Bool)?
        private var stopped = Set<ObjectIdentifier>()

        init(_ parent: MessageWebView) {
            self.parent = parent
        }

        /// Load the message, unless it's already showing as asked.
        func load(into view: WKWebView) {
            if let loaded, loaded.html == parent.html, loaded.allowRemote == parent.allowRemote { return }
            loaded = (parent.html, parent.allowRemote)
            view.loadHTMLString(MessageWebView.document(parent.html, allowRemote: parent.allowRemote), baseURL: nil)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let height = (message.body as? NSNumber)?.doubleValue { parent.height = CGFloat(height) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { parent.openLink(url) }
                return .cancel
            }
            // Only the message itself loads here: no redirects, refreshes or pages from the web.
            return navigationAction.request.url?.scheme == "about" ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
            let id = ObjectIdentifier(task)
            let cid = task.request.url.map { String($0.absoluteString.dropFirst("cid:".count)) }.map { $0.removingPercentEncoding ?? $0 }
            guard let url = task.request.url, let part = parent.inline.first(where: { $0.cid != nil && $0.cid == cid }) else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            Task {
                do {
                    let data = try await parent.download(part)
                    guard !stopped.contains(id) else { return }
                    task.didReceive(URLResponse(url: url, mimeType: part.type, expectedContentLength: data.count, textEncodingName: nil))
                    task.didReceive(data)
                    task.didFinish()
                } catch {
                    if !stopped.contains(id) { task.didFailWithError(error) }
                }
            }
        }

        func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
            stopped.insert(ObjectIdentifier(task))
        }
    }
}

/// Passes scrolling to the conversation around it.
final class MessageWKWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}
