# Recommendation cards evidence

The screenshots show the native application with tab-local response substitution of the actual pinned 0.2.2-rc.1 client modules and dshmarket 1.73.12. Lists, package state and detail requests use the existing server. The source patch is applied to published modules without building or changing the server. Screenshots omit the sidebar and account. No model request, installation, enable change, preference write or publication was performed.

[Wide, 1600px window](wide.png) · [Narrow, 820px window](narrow.png) · [English](english.png) · [Installed](installed.png) · [Third-party](third-party.png) · [Nine official icons, 64px and 40px](icons.png).

The browser check also covers a 520px window, dark theme, card and chevron detail navigation, controlled search and clearing, company/official segments, and third-party dialog opening and closing. It checks that actions remain beside descriptions and missing counts have no placeholder. Official icons use distinct non-blue gradients and filled glyphs; the icon board shows all nine at 64px and 40px. Summaries: [Chinese](zh.json), [English](en.json). English uses the native locale initialization with a tab-local English preference and no Host preference persistence. Theme changes affect this tab only. The supplied release-module directory is a writable temporary copy.

The server has not received the new counter implementation, so screenshots correctly omit company download counts. Gateway HTTP tests separately exercise the production handler and native index parser, checking completed transfers, parallel increments, restart persistence, access rejection, HEAD, upstream failure, file permissions and corrupt-count handling. An existing 27-case market regression passed using a temporary copy with its tsx import replaced by a direct TypeScript import under Node 24's transform-types mode; test bodies were unchanged. No dependency installation or full build ran.

Reproduce the lightweight checks from the repository root, with published modules supplied separately:

```sh
MARKET_RUNTIME_MODULES=<original-five-modules> node --test crysound/scripts/tests/market-catalog.test.mjs
THIRD_PARTY_CLIENT=<dshmarket-client.js> node --test crysound/scripts/tests/market-cards.test.mjs
node --experimental-transform-types --test crysound/web/gateway/tests/market-installs.test.mjs
CDP_TAB=<dedicated-tab> MARKET_RUNTIME_MODULES=<writable-module-copy> THIRD_PARTY_CLIENT=<dshmarket-client.js> node crysound/web/market/verify-cards.mjs <output>
```

The gateway check uses Node 24 and an existing semver dependency. The browser check requires the skill-configured persistent CDP browser. Add `--english` for the isolated English pass.

Pending: Jason’s final review of the revised glyphs and screenshots; gateway and image deployment; actual installation completion and Use workflows; packaged Electron acceptance. The counter measures completed package transfers (including updates and repeats), not unique people or confirmed installation success. Counts start at rollout. Native installed metadata does not supply authors/counts, so absent counts are omitted and absent authors are labeled. Third-party counts remain downloads with the native statistic available in details. No GIF is embedded: static wide/narrow screenshots document this layout change; a fresh full build is outside the permitted lightweight validation scope.
