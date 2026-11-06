#!/bin/bash
# Gatekeeper-style checks on the signed, notarized, stapled installer.
set -euo pipefail
dmg=$1
mount=$(mktemp -d)
trap 'hdiutil detach "$mount" -quiet || true' EXIT
echo "== stapler validate (dmg)"
xcrun stapler validate "$dmg"
echo "== spctl (dmg)"
spctl -a -vv -t open --context context:primary-signature "$dmg"
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
app=$(ls -d "$mount"/*.app | head -n1)
echo "== installer window: Applications link and layout"
test -L "$mount/Applications" && test -f "$mount/.DS_Store" && echo "Applications link and layout present"
echo "== codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$app"
echo "== codesign details"
codesign -dv --verbose=4 "$app" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Timestamp|flags)" 
echo "== spctl (app)"
spctl -a -vv -t exec "$app"
