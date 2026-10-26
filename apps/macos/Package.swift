// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Wren",
    platforms: [.macOS(.v14)],
    targets: [
        // The mail engine: JMAP client, models and compose helpers. Foundation only, so it builds and tests on Linux too.
        .target(name: "WrenKit"),
        .testTarget(name: "WrenKitTests", dependencies: ["WrenKit"]),
    ]
)

// The app itself (SwiftUI, AppKit, WebKit) only builds on a Mac.
#if os(macOS)
package.targets.append(.executableTarget(name: "Wren", dependencies: ["WrenKit"]))
#endif
