#!/bin/bash
# Mount the installer and check names, identifiers, company assets, and the absence of DeepSeek update/telemetry wiring.
set -euo pipefail
dmg=$1
mount=$(mktemp -d)
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
trap 'hdiutil detach "$mount" -quiet || true' EXIT
app=$(ls -d "$mount"/*.app | head -n1)
plist="$app/Contents/Info.plist"
res="$app/Contents/Resources"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1: $2"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
has() { if [ -e "$1" ]; then echo "ok    present: ${1#$app/}"; else echo "FAIL  missing: ${1#$app/}"; fail=1; fi; }

echo "app: $(basename "$app")"
check CFBundleName "$(plutil -extract CFBundleName raw "$plist")" "CRYSOUND WorkPartner"
check CFBundleDisplayName "$(plutil -extract CFBundleDisplayName raw "$plist")" "兆华工作伙伴"
check CFBundleIdentifier "$(plutil -extract CFBundleIdentifier raw "$plist")" "com.crysound.workpartner"
check URLScheme "$(plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 raw "$plist")" "crysound-workpartner"
check zh_CN-name "$(grep -o '兆华工作伙伴' "$res/zh_CN.lproj/InfoPlist.strings" | head -n1)" "兆华工作伙伴"
if grep -q "DeepSeek" "$plist"; then echo "FAIL  Info.plist mentions DeepSeek"; fail=1; else echo "ok    Info.plist has no DeepSeek text"; fi

for f in brand/brand.css brand/brand.js brand/welcome.js brand/zp-mark.svg config/plugins.json config/partner.patch.yml config/plugin-patches.mjs host-hook.mjs; do has "$res/crysound/$f"; done
has "$res/icon.png"
tpl="$res/crysound/plugin-template"
has "$tpl/package.json"
has "$tpl/pnpm-lock.yaml"
for plugin in $(node -e 'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plugins) console.log(p.name)' "$res/crysound/config/plugins.json"); do has "$tpl/modules/$plugin/package.json"; done
echo "info  plugin template: $(du -sh "$tpl" | cut -f1), $(find "$tpl" -type f | wc -l | tr -d ' ') files, $(find "$tpl" -type f \( -name '*.node' -o -name '*.dylib' \) | wc -l | tr -d ' ') native libraries"
has "$res/runtime/cli/bin/dsh"
if [ -e "$res/app-update.yml" ]; then echo "FAIL  app-update.yml present (update feed configured)"; fail=1; else echo "ok    no app-update.yml (updates off)"; fi
grep -q "partner.corp.crysound.com/_zp/llm/v1" "$res/crysound/config/partner.patch.yml" && echo "ok    seed points at company gateway" || { echo "FAIL  seed baseURL"; fail=1; }

asar="$res/app.asar"
has "$asar"
tools=$(mktemp -d)
npm install --prefix "$tools" --silent @electron/asar@3
asarcli="$tools/node_modules/.bin/asar"
list=$("$asarcli" list "$asar")
grep -q "^/dsh/node_modules/@deepseek-ai/dsh/package.json$" <<<"$list" && echo "ok    dsh runtime inside app.asar" || { echo "FAIL  dsh runtime missing"; fail=1; }
grep -q "^/lib/main.js$" <<<"$list" && echo "ok    lib/main.js" || { echo "FAIL  lib/main.js"; fail=1; }
tmp=$(mktemp -d)
(cd "$tmp" && "$asarcli" extract-file "$asar" lib/main.js) >/dev/null 2>&1 || true
if [ -f "$tmp/main.js" ]; then
  grep -q "crysound-workpartner" "$tmp/main.js" && echo "ok    main.js registers crysound-workpartner:// protocol" || { echo "FAIL  protocol string"; fail=1; }
  grep -q "desktop-login\|partner.corp.crysound.com" "$tmp/main.js" && echo "ok    main.js carries company login" || { echo "FAIL  login string"; fail=1; }
fi
exit $fail
