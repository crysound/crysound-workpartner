#!/bin/bash
# Reserved: re-sign the unsigned installer's app with a Developer ID certificate, notarize, staple, and write a new dmg.
# Needs CSC_LINK (base64 .p12), CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID. Not exercised yet.
set -euo pipefail
dmg=$1
out=$2
root=$(cd "$(dirname "$0")/../.." && pwd)
entitlements="$root/apps/desktop/scripts/macos-entitlements.plist"
mkdir -p "$out"
work=$(mktemp -d)
keychain="$work/signing.keychain-db"
password=$(uuidgen)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
echo "$CSC_LINK" | base64 --decode > "$work/certificate.p12"
security import "$work/certificate.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" login.keychain-db
identity=$(security find-identity -v -p codesigning "$keychain" | awk -F'"' '/Developer ID Application/ {print $2; exit}')
test -n "$identity"

mount="$work/mount"
mkdir -p "$mount"
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
app=$(ls -d "$mount"/*.app | head -n1)
name=$(basename "$app")
ditto "$app" "$work/$name"
hdiutil detach "$mount" -quiet
target="$work/$name"

# Innermost code first: every Mach-O file, then bundles, then the app.
find "$target" -type f -print0 | while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q "Mach-O"; then
    codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" --keychain "$keychain" "$file"
  fi
done
find "$target" -name '*.framework' -o -name '*.app' -not -path "$target" | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2- | while IFS= read -r bundle; do
  codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" --keychain "$keychain" "$bundle"
done
codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" --keychain "$keychain" "$target"
codesign --verify --deep --strict "$target"

signed="$out/$(basename "$dmg" | sed 's/-unsigned//')"
hdiutil create -volname "$(basename "$name" .app)" -srcfolder "$target" -ov -format ULMO "$signed"
codesign --force --timestamp --sign "$identity" --keychain "$keychain" "$signed"
xcrun notarytool submit "$signed" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$signed"
spctl --assess --type open --context context:primary-signature "$signed" || true
security delete-keychain "$keychain"
