#!/bin/sh
# Build the universal (arm64 + x86_64) helper into bin/dsh-airpods-helper with an embedded Info.plist.
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin .build
cat > .build/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.dshub.airpods-helper</string>
  <key>CFBundleName</key><string>DSH AirPods</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>Detect when your AirPods case opens and show their battery.</string>
  <key>NSMicrophoneUsageDescription</key><string>Hear what you say after you press your AirPods.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Turn what you say into text on this Mac.</string>
  <key>NSMotionUsageDescription</key><string>Nod or shake your head to answer DSH.</string>
</dict></plist>
PLIST
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" -module-name AirPodsHelper \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker .build/Info.plist \
    swift/*.swift -o ".build/helper-$arch"
done
# A real app bundle: Speech recognition (and other TCC services) require a bundle identity, an embedded plist is not enough.
APP="bin/DSH AirPods.app"
rm -rf "$APP" bin/dsh-airpods-helper
mkdir -p "$APP/Contents/MacOS"
lipo -create .build/helper-arm64 .build/helper-x86_64 -output "$APP/Contents/MacOS/dsh-airpods-helper"
sed -e 's#<dict>#<dict>\
  <key>CFBundleExecutable</key><string>dsh-airpods-helper</string>\
  <key>CFBundlePackageType</key><string>APPL</string>\
  <key>CFBundleShortVersionString</key><string>1.0</string>\
  <key>CFBundleVersion</key><string>1</string>\
  <key>LSUIElement</key><true/>\
  <key>LSMinimumSystemVersion</key><string>13.0</string>#' .build/Info.plist > "$APP/Contents/Info.plist"
# A stable identity keeps macOS permission grants across rebuilds (see dev-signing.sh); ad-hoc is the fallback.
IDENTITY="${DSH_AIRPODS_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && sh scripts/dev-signing.sh >/dev/null 2>&1; then IDENTITY="DSH AirPods Dev"; fi
codesign --force --sign "${IDENTITY:--}" --identifier com.dshub.airpods-helper "$APP"
echo "built $APP"
