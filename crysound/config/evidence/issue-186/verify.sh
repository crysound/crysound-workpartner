#!/bin/sh
# Run against existing pinned release dependencies; never install or call paid APIs.
set -eu
cd "$(dirname "$0")/../../../.."
: "${DSH_WEB_TOOLS_RELEASE_ROOT:?Set the pinned web tools release root}"
: "${DSH_TOOL_TIMING_RELEASE_ROOT:?Set the pinned timing release root}"
node --input-type=module <<'JS'
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, '@deepseek-ai/dsh-tool-web/lib/index.js'));
for (const dependency of ['turndown', '@joplin/turndown-plugin-gfm', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-session']) require.resolve(dependency);
JS
for file in crysound/web/web-tools/*.mjs; do node --check "$file"; done
node --experimental-vm-modules --test \
  crysound/web/web-tools/search-api.test.mjs \
  crysound/web/web-tools/exa.test.mjs \
  crysound/web/web-tools/exa-transcript.test.mjs \
  crysound/web/web-tools/web-tools.test.mjs \
  crysound/web/web-tools/timing.test.mjs \
  crysound/web/web-tools/fetch-pipeline.test.mjs \
  crysound/web/gateway/tests/ds-tools.test.mjs \
  crysound/web/gateway/tests/treg.test.mjs
