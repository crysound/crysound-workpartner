#!/bin/sh
# Run in a disposable existing image with /repo read-only; no model credentials.
set -eu
export DSH_HOME="$(mktemp -d)" DSH_TELEMETRY_DISABLED=1
cd "$(mktemp -d)"
dsh --profile web --dump-config >/dev/null
node - <<'JS'
const fs = require('node:fs');
fs.writeFileSync(process.env.DSH_HOME + '/profiles/web/cordis.patch.yml', `
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: locale
  config:
    preference: zh
`);
JS
node /repo/crysound/config/profile-upgrades.mjs "$DSH_HOME/profiles/web/cordis.patch.yml" \
  /repo/crysound/config/partner.patch.yml /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --web-preview
exec dsh --profile web --patch /repo/apps/web/tests/pin-browse-picker.overlay.yml \
  --no-open --host "$(hostname -i)" --port 3080 \
  --public-url http://127.0.0.1:18993/ --trusted-host 127.0.0.1:18993
