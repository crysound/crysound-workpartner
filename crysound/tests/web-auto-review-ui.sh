#!/bin/sh
# Run only in a disposable container from the existing image, with /repo read-only.
set -eu
node /repo/crysound/scripts/patch-web-auto-review.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules
export DSH_HOME="$(mktemp -d)" DSH_TELEMETRY_DISABLED=1
cd "$(mktemp -d)"
dsh --profile web --dump-config >/dev/null
node - <<'JS'
const fs = require('node:fs');
const dir = process.env.DSH_HOME + '/profiles/web';
const file = dir + '/package.json', manifest = JSON.parse(fs.readFileSync(file));
manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-auto-review');
fs.writeFileSync(file, JSON.stringify(manifest));
fs.writeFileSync(dir + '/cordis.patch.yml', `
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: locale
  config:
    preference: zh
`);
JS
exec dsh --profile web --patch /repo/apps/web/tests/pin-browse-picker.overlay.yml \
  --no-open --host "$(hostname -i)" --port 3080 \
  --public-url http://127.0.0.1:18888/ --trusted-host 127.0.0.1:18888
