#!/bin/bash
# Run the packaged app's own first-run workspace preparation (the same code the app runs before starting the Host)
# in a throwaway home, then check the five plugins, their patches, the default bundles, and the seed configuration.
set -euo pipefail
dmg=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
mount=$(mktemp -d)
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
trap 'hdiutil detach "$mount" -quiet || true' EXIT
app=$(ls -d "$mount"/*.app | head -n1)
home=$(mktemp -d)
export CRYSOUND_LLM_BASE=https://partner.example.test/_zp/llm/v1
export DSH_HOME="$home/dsh" SMOKE_APP="$app" SMOKE_USERDATA="$home/userdata"
cd "$root/apps/desktop"
node --import tsx scripts/crysound-smoke-workspace.ts
