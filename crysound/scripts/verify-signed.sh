#!/bin/bash
# Gatekeeper-style checks on the signed, notarized, stapled installer.
set -euo pipefail
dmg=$1
mount=$(mktemp -d)
trap 'hdiutil detach "$mount" -quiet || true' EXIT
echo "== stapler validate (dmg)"
# Validation reads the ticket from Apple's CloudKit, which drops connections now and then.
for attempt in 1 2 3 4; do
  if xcrun stapler validate "$dmg"; then break; fi
  [ "$attempt" = 4 ] && exit 1
  sleep $((attempt * 20))
done
echo "== spctl (dmg)"
spctl -a -vv -t open --context context:primary-signature "$dmg"
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
app=$(ls -d "$mount"/*.app | head -n1)
echo "== codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$app"
echo "== bundled plugin template: every Mach-O file is signed"
template="$app/Contents/Resources/crysound/plugin-template"
test -d "$template"
checked=0
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q "Mach-O"; then codesign --verify --strict "$file"; checked=$((checked + 1)); fi
done < <(find "$template" -type f -print0)
echo "verified $checked Mach-O files in the plugin template"
echo "== codesign details"
codesign -dv --verbose=4 "$app" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Timestamp|flags)" 
echo "== spctl (app)"
spctl -a -vv -t exec "$app"
