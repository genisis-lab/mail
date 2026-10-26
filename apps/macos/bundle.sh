#!/bin/sh
# Build Wren.app (needs macOS 14 or later and Xcode 16 or later).
#   ./bundle.sh                                              signed for this Mac only
#   SIGN_IDENTITY="Developer ID Application: …" ./bundle.sh  signed to share (then notarize; see README.md)
set -eu
cd "$(dirname "$0")"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Wren"
APP=build/Wren.app
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../../package.json)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/Wren"
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION:-0.0.0}" "$APP/Contents/Info.plist"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP"
fi
echo "Built $APP"
