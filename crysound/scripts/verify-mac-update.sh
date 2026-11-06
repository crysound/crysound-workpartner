#!/bin/bash
# Verify the final archive, not the unsigned staging app. Run on Apple Silicon macOS after signing.
set -euo pipefail
zip=$1
version=$2
url=$3
root=$(cd "$(dirname "$0")/../.." && pwd)
node "$root/crysound/scripts/mac-update-release.mjs" validate "$version" "$url"
node "$root/crysound/scripts/mac-update-release.mjs" verify "$zip" "$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ditto -x -k "$zip" "$work"
set -- "$work"/*.app
[ "$#" -eq 1 ] && [ -d "$1" ]
app=$1
actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
[ "$actual_version" = "$version" ]
codesign --verify --deep --strict "$app"
details=$(codesign -dv --verbose=4 "$app" 2>&1)
grep -q '^Authority=Developer ID Application:' <<< "$details"
xcrun stapler validate "$app"
spctl -a -vv -t exec "$app"
node --input-type=module - "$app" "$url" <<'JS'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const [appPath, source] = process.argv.slice(2)
const url = new URL(source)
if (!url.pathname.endsWith('/')) url.pathname += '/'
const config = JSON.parse(await readFile(join(appPath, 'Contents/Resources/app-update.yml'), 'utf8'))
assert.deepEqual(config, {
  provider: 'generic', url: url.href, channel: 'latest', updaterCacheDirName: 'crysound-workpartner-updater',
})
JS
echo "Signed update ZIP, app version, generic feed, and SHA-512 verified"
