#!/bin/bash
# Re-sign the unsigned installer's app with the Developer ID Application certificate (hardened runtime, upstream
# entitlements), notarize the new dmg with notarytool (Apple ID + app-specific password), and staple it.
# Needs CSC_LINK (base64 .p12), CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
set -euo pipefail
dmg=$1
out=$2
root=$(cd "$(dirname "$0")/../.." && pwd)
entitlements="$root/apps/desktop/scripts/macos-entitlements.plist"
mkdir -p "$out"
work=$(mktemp -d)
keychain="$work/signing.keychain-db"
password=$(uuidgen)
cleanup() { security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
base64 --decode <<<"$CSC_LINK" > "$work/certificate.p12"
security import "$work/certificate.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -A -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
identity=$(security find-identity -v -p codesigning "$keychain" | awk -F'"' '/Developer ID Application/ {print $2; exit}')
test -n "$identity"
case "$identity" in *"($APPLE_TEAM_ID)") ;; *) echo "signing identity does not belong to team $APPLE_TEAM_ID"; exit 1;; esac
echo "signing identity: $identity"

mount="$work/mount"
mkdir -p "$mount"
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
app=$(ls -d "$mount"/*.app | head -n1)
name=$(basename "$app")
ditto "$app" "$work/$name"
hdiutil detach "$mount" -quiet
target="$work/$name"

sign() { codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" --keychain "$keychain" "$@"; }

# Innermost code first: every Mach-O file, then frameworks and helper apps (deepest first), then the app.
count=0
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q "Mach-O"; then sign "$file"; count=$((count + 1)); fi
done < <(find "$target" -type f -print0)
echo "signed $count Mach-O files"
find "$target" -type d \( -name '*.framework' -o -name '*.app' \) ! -path "$target" | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2- |
  while IFS= read -r bundle; do sign "$bundle"; done
sign "$target"
codesign --verify --deep --strict "$target"

signed="$out/$(basename "$dmg" | sed 's/-unsigned//')"
hdiutil create -volname "${name%.app}" -srcfolder "$target" -ov -format ULMO "$signed" >/dev/null
codesign --force --timestamp --sign "$identity" --keychain "$keychain" "$signed"

result="$work/notarize.txt"
xcrun notarytool submit "$signed" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait 2>&1 | tee "$result"
if ! grep -q "status: Accepted" "$result"; then
  id=$(awk '/^ *id:/ {print $2; exit}' "$result")
  [ -n "$id" ] && xcrun notarytool log "$id" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
  echo "notarization was not accepted"
  exit 1
fi
xcrun stapler staple "$signed"
ls -lh "$signed"
