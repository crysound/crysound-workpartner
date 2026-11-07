# Zhaohua market phase one

English | [中文](README.zh.md)

The company market uses the experimental dsh bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`, available through the 兆华市场 / CRYSOUND market tab on the plugins page, without modifying dshmarket. Startup adds the bundle and company index for new and existing users; later changes to indexes or disabling the bundle remain in effect. The publishing skill is installed with company resources at `<DSH_HOME>/skills/publish-zhaohua-market`.

## Deployment configuration

Keep deployment parameters in `crysound/web/.env`, following the [example](../.env.example). `PUBLIC_HOST` is the company gateway domain. The new required `MARKET_ADMINS` contains provisioned user slugs; initially, enter Jason’s slug, with commas separating multiple administrators. An administrator checks slugs with `partner-user list`; do not commit personal identifiers. All listed administrators can review packages and receive notifications. Enable the bot’s messaging permission, such as `im:message:send_as_bot`, publish the application version, and include administrators in its availability scope.

Verdaccio joins only the existing `partner-net`, exposes no host port, and uses `uplinks: {}` to disable public npm proxying. Only the internal gateway account can access `@crysound/*`; all other scopes are denied. The company gateway Dockerfile installs a pinned semver dependency to validate published versions and `engines.dsh`. Store packages in `PARTNER_DATA/npm`; back up and restore this directory together with `PARTNER_DATA/gateway/state/market.json`. Never restore either alone or run multiple gateway instances against the same market state file.

For the first deployment, the server administrator loads `.env` and prepares directories and internal credentials. Run the following commands only on the target server with root and `htpasswd` (Debian package `apache2-utils`). The random internal password is never printed. Existing files are not overwritten; do not copy their contents into `.env` or give them to users. The gateway reads `market-npm-auth` (root:root, mode 600); Verdaccio reads the same account and password through bcrypt `market-htpasswd` (10001:65533, mode 400).

```sh
set -a
. crysound/web/.env
set +a
python3 - <<'PY'
import os, secrets, subprocess
from pathlib import Path
secure = Path(os.environ['PARTNER_SECURE'])
auth, hashed = secure / 'market-npm-auth', secure / 'market-htpasswd'
if auth.exists() or hashed.exists():
    raise SystemExit('内部凭据已存在；停止，不覆盖或轮换')
password = secrets.token_urlsafe(48)
record = subprocess.run(['htpasswd', '-niB', 'zp-gateway'], input=password + '\n', text=True, capture_output=True, check=True).stdout
os.umask(0o077)
with auth.open('x') as out:
    out.write('zp-gateway:' + password + '\n')
with hashed.open('x') as out:
    out.write(record)
os.chown(auth, 0, 0)
os.chown(hashed, 10001, 65533)
hashed.chmod(0o400)
npm = Path(os.environ['PARTNER_DATA']) / 'npm'
npm.mkdir(mode=0o750, exist_ok=True)
os.chown(npm, 10001, 65533)
PY
docker compose -f crysound/web/compose.yml config --quiet
docker compose -f crysound/web/compose.yml --profile build build partner-image gateway
docker compose -f crysound/web/compose.yml up -d --force-recreate verdaccio gateway
```

At startup, the gateway issues `.zp-market-token` files (zpd, valid for 180 days) for provisioned users. Self-service and manual provisioning also issue them; user directories and token files belong to UID 1001. Recreate user containers through the existing idle-upgrade procedure. The entrypoint writes the literal token to `/data/.npmrc` with mode 600. It cannot reference an environment variable containing TOKEN because dsh filters those variables from pnpm subprocesses. Failures while writing the market npm configuration, patching plugins, upgrading profiles, or copying the publishing skill log warnings and allow startup to continue. Unsupported user YAML or invalid profile JSON skips market configuration without changing those files; add the company index and market bundle manually in settings. Recreate containers within 180 days to renew their identity; recreate them after an expiry-related 401 rather than giving users the internal password. `partner-user upgrade` also reissues tokens using the gateway’s signing format.

After the desktop update, login or session restoration writes the desktop profile’s `.npmrc`. It maintains only the company scope and that registry’s `_authToken`, preserving other settings. Changing domains removes the old market token; logout removes both company settings. The Host fetch hook adds Authorization only to `/_zp/market/` on the same company origin, rejects redirects, and triggers the existing login flow on 401. Desktop preparation replaces company index and model placeholders; the web Dockerfile uses sed to replace them with Docker internal addresses.

For local desktop development, set `PUBLIC_HOST` before launching. Before packaging the desktop app, run `node crysound/scripts/configure-public-host.mjs`. It extracts only `PUBLIC_HOST` from `crysound/web/.env` into the git-ignored `crysound/config/public-host.json`; other deployment values are excluded from desktop resources. Setting `PUBLIC_HOST` explicitly skips reading `.env`. Mac and Windows packaging workflows use the repository variable `PUBLIC_HOST`, which operations must keep aligned with the deployment `.env`; a missing value fails the build. The runtime environment variable can override the packaged value. Code embeds neither the current nor the previous domain. Use the current public entrypoint in generated configuration so authenticated requests avoid redirects from the old address.

## Publishing and approval

Publish with `npm publish --registry https://<PUBLIC_HOST>/_zp/npm/`; names must match `@crysound/*`. Use the bundled “发布到兆华市场” publishing skill, which selects the user’s `.npmrc` through application-provided path variables; containers use the internal entrypoint. Only single-version bundles with a tarball, description, and `dsh.bundle.patch` are accepted. The first successful publisher owns the package. Nonofficial packages retain owner-only publishing; designated official maintainers can also publish new versions, each requiring administrator approval. Deletion, overwriting, and dist-tag changes are forbidden.

After publishing, the gateway persists pending status and sends an interactive card through the existing Feishu bot. The card’s “查看并审批” button opens `https://<PUBLIC_HOST>/_zp/market/admin`. Administrators must log in through Feishu in the browser; desktop Bearer tokens cannot replace administrator sessions. Approval and rejection POSTs also check Origin and record the reviewer and time. Notification failure leaves the published version intact and is reported in gateway logs. The approval page’s “重发审批卡片” button retries delivery.

`/_zp/npm/*` and `/_zp/market/index.json` both use `desktopUser` to validate the Bearer zpd signature, expiry, and provisioned-user list; browser cookies cannot replace it. Package metadata lists only approved versions; publishers can additionally read and install their own pending versions by explicit version. Version and tarball requests enforce the same rule; rejected, publishing, and unrecorded versions return 404 for everyone. `dist-tags.latest` always selects the highest approved version by SemVer and is omitted when none is approved; packages without approved versions return 404 for other users. Publishing does not set latest to the new version. Internal metadata returns internal tarball URLs, while public metadata returns public URLs. The gateway substitutes its internal account for both; clients hold only their own tokens.

The format-1 index combines Verdaccio metadata with approval records. `package.json` may provide a 1–80 character `displayName` (preferred) or `title`; the index emits the native `title` field, while installation keeps the npm package name. Without either field, the client displays the package name. `plugins.json` configures `officialPlugins` by package name with `{displayName, maintainers}`; display names start with “兆华”, and maintainers use deployment user slugs. The gateway uses this list for official designation, Chinese titles, and author “兆华工作伙伴”. Nonofficial packages cannot start their package name, `displayName`, or `title` with “兆华”. Only a designated company publishing account or maintainer can first publish an official package. Existing owners and designated maintainers can publish later versions, still requiring approval for every version. `MARKET_OFFICIAL_PUBLISHERS` names the company publishing accounts; the legacy rule matching both publisher and `MARKET_OFFICIAL_PACKAGES` remains supported. Other authors use the publisher’s name from `users.json`, falling back to the slug, and receive no official label regardless of package-supplied claims. It lists all approved versions still present in descending SemVer order, including `engines.dsh`, and omits registry, relying on `@crysound:registry` mapping. Failure to check the registry returns an error rather than an empty index. dsh caches the index for ten minutes; users can refresh it in 兆华市场 / CRYSOUND market. Phase one provides no public CDN mirror of private package READMEs, so detailed descriptions may be unavailable.

The three tabs are 兆华市场 / CRYSOUND market, 第三方 / Third-party, and Installed, with the company market selected by default. The shared build-time `crysound/scripts/patch-market-ui.mjs --runtime <node_modules>` script checks five pinned browser modules before writing any patches and rejects changed versions. The sidebar orders New Session, Market, and Automation tasks before installed plugin pages and has no market hint. Removing the sidebar menu registration from `entry-customization` naturally removes an empty More launcher. The market header’s 做一个插件 / Create plugin button reuses its existing `agentPreset: cordis`, sidebar prompt, and `whenDraftExists: append` action. Third-party content and the Installed list retain their native implementation. Company cards appear as large official cards followed by the all-plugins list, using native search, category filters, installation confirmation, and pagination. Default index order puts official entries first, then orders others by their latest approved version’s publication time. Installed buttons say Use and open guided conversations for active official packages with matching approved guidance; other packages retain native settings. Rebuild the web image and use the next desktop package for these UI changes. Desktop preparation patches modules before file inventories, signatures, and smoke verification. The market Use action uses the same package guidance.

`MARKET_OFFICIAL_MAINTAINERS` is a JSON object overriding per-package maintainer lists in `officialPlugins`, such as `{"@crysound/design":["maintainer-slug"]}`. This grants permission to publish new versions of that official package, so administrators must verify the deployment list. Names come from `users.json`, using the owner’s name when no maintainer is designated; missing names never display a slug. `@crysound/data` uses title “兆华数据” and category `data`, without adding a tab. Native labels carry maintenance information, rendered as 维护：姓名 / Maintained by name.

Categories come from package `labels` or `keywords`: 设计, 视频, 文档与报告, 数据, 研发, 销售与市场, 其他, or the corresponding ids `design`, `video`, `documents`, `data`, `development`, `sales`, `other`. Unmatched packages use Other. Optional `dsh.market.preview` contains package artwork encoded by its author as an inline PNG, JPEG, or WebP data URL, at most 32 KiB of decoded bytes, mapped to the native index `icon` field. Without a valid image, no sample image is displayed; image requests never target a private registry or arbitrary URL.

Before uploading, the gateway atomically saves publishing status. A dropped connection, 5xx response, or later save failure may follow a successful upload; the gateway neither retries automatically nor releases ownership. An administrator must stop the gateway, back up data, and compare the Verdaccio version with `market.json`. Change publishing to pending only after confirming the version exists and its contents are correct. Remove the version reservation only after confirming nothing was written; remove the package record if no versions remain. If uncertain, retain publishing. Restart the gateway after editing, then review the version. Never delete a published tarball. Corrupted state is not reset to empty; restore paired backups. Recovery in this phase is performed only by operations.

## Plugin capability guidance

New conversations render no plugin shortcuts or Explore the market row below the input, with no empty placeholder; the `home` flag no longer controls the home page. The official list includes 兆华设计, 兆华动画, 兆华作品, 兆华设计系统, 兆华幻灯片, and 兆华看板; packages without an approved version remain absent from the market. This list does not add preinstalled packages. The home input has a localized example placeholder. Choosing Use for an active plugin from the sidebar Market opens a blank conversation without sending, adds a removable capability label, and displays a summary and three examples. An example submits through the native input; removing the label preserves draft text and attachments. Existing drafts are never replaced.

Maintainers own the optional `package.json` field `dsh.market.guide`, with `zh` and `en` entries. Each has `summary` (1–200 characters), `prompt` (1–500 characters), and exactly three `examples` (1–300 characters each); whitespace-only values are invalid. The prompt instructs the model to use the package capability and is sent with the user text and attachments through the logged session prompt. Content is plain text. See the [publishing skill](../../config/skills/publish-zhaohua-market/SKILL.md) for an example. Package guidance does not add home shortcuts.

`GET /_zp/market/guides.json` accepts an onboarded browser session or existing market Bearer identity and returns each official package’s latest approved stable guidance, falling back to the latest approved prerelease when no stable release exists. Pending, rejected, and nonofficial releases are excluded. The client requires an enabled, active bundle with the exact approved version. Market Use still opens native settings when guidance is missing or versions differ. Desktop proxies only this fixed path using the current login and does not expose credentials or upstream headers to the page. Failed reads never invent guidance; the market entry remains available.

Deployment requires rebuilding the gateway and user image and including the shared patches in the next desktop package before integrity records are generated. Package maintainers must publish guide metadata, obtain normal approval, and align the installed version before market capability guidance can be accepted. The [component preview evidence](evidence/issue-61-c/evidence.md) uses test packages and fake sessions; it does not verify full native editor behavior, real model requests, deployed package content, or Electron navigation. Acceptance must cover the absence of home shortcuts, market capability selection, an existing draft, cancellation with attachments, one example submission, locale/theme switching, and a narrow viewport in the real product.

Guide patch v4 declares both `remote` and `remote.pluginManager`; the namespace does not grant access to the remote event service. It reads native `{ ok, value }` responses and resolves the session's conversation service through `get`. The conversation patch renders the composer dock on blank home pages as well. Reapplying the runtime patch upgrades older guide patches and removes home buttons before integrity records are generated. In a dedicated authenticated browser tab showing a blank native session, run `CDP_TAB=<tab> node crysound/web/market/verify-guide-boot.mjs <output-directory>`. It substitutes only browser responses, reproduces the missing-dependency boot failure, reloads with the fix, and requires the native input, no home shortcuts, and no console errors. It leaves the server and package installation unchanged; [startup evidence](evidence/issue-61-boot/evidence.md) records the separate package-interaction acceptance still required.

The [design 1.0.0 delta evidence](evidence/issue-61-design-v1/evidence.md) supersedes the design 0.2.1 acceptance target. It covers native startup, bilingual home and market guidance, a real example submission using `/crysound-design`, and automatic dependency installation in isolation. Earlier motion and attachment evidence remains valid. The partner assistant will accept the packaged Electron app during the next scheduled desktop build; it does not block this web fix. Deployment acceptance remains separate.

## Preinstall and updates

The `retire` section in `plugins.json` records a one-time dependency migration with a stable id. Web and desktop updates use native `dsh plugin remove` to retire SlideStudio, video editor, and oil-ui, changing only profile dependencies and activation selections. Work directories, generated files, and plugin data are retained. A failed migration stays unmarked and retries at the next update; after success, users can reinstall these plugins from the third-party market. The image retains `/opt/slidestudio-runtime`, fonts, and ffmpeg, with `OM_CHROME` unchanged.

Preparation records the `officialPlugins` names in profile `dsh.company.officialPackages`. A shared build patch makes the native plugin page and removal endpoint refuse uninstall for those names while retaining disable. This field governs application management only; it does not restrict the user’s terminal or workspace files. After publishing approval, administrators synchronize `plugins` `spec/want` to exact approved versions and distribute them through the existing idle-update process. Matching versions skip installation; existing disabled selections are preserved. Company market entries should use registry specs such as `@crysound/design@<approved-version>`, retaining gateway integrity metadata and avoiding #55’s direct remote tarballs. Feishu retains its verified local archive.

Official designation does not install a package. The approved design target is `@crysound/design@1.0.0`, using `/crysound-design`, with `@crysound/artifacts@^1.0.0` installed as its dependency. Design 0.2.1 was never published to the company market and is superseded; it must not be a release or acceptance target. Motion remains at approved 0.1.3 for this change; the later animation replacement is separate. Preinstall versions follow the approved deployment configuration. No fake or uninstallable spec is needed as a configuration switch. This delivery does not replace real workspace-update, file-retention, motion-rendering, or packaged desktop acceptance.

## Local verification

All tests use temporary directories, fake identities, and isolated configuration. They read neither real `.env` files nor credentials and send no real Feishu messages. Node 24.9 or later is required; configuration and index tests also need the repository’s installed dependencies:

```sh
node --test crysound/web/gateway/tests/*.test.mjs
node crysound/web/tests/compose-config.mjs
```

The real-registry smoke test requires `verdaccio@6.1.6` and `pnpm@11` installed in a separate temporary directory. Install with a temporary HOME, empty user/global npm configuration, and a separate cache to avoid reading local credentials. Pass that directory through `MARKET_TEST_TOOLS`:

```sh
MARKET_TEST_TOOLS=<隔离依赖目录> node crysound/web/tests/registry-smoke.mjs
```

The smoke test starts real Verdaccio on a random loopback port, publishes two versions with npm, approves them through the production gateway handler, and queries, downloads, and installs with pnpm 11 using the profile `.npmrc`. On exit it awaits child termination and removes temporary data.

Production verification remains for operations: image builds and existing-container recreation, new-user self-service provisioning, desktop login/logout/expired-session login, card delivery to Jason and approval, the Discover tab and installation under company branding, scope and tarball authentication through company networks and proxies, internal container DNS, and disk permissions. Never output credentials during acceptance testing.

## Recommendation cards and counters

The shared `patch-market-cards.mjs` adapter renders two columns, falling back to one below a 900px window or 650px content area. It preserves native search, category filters, sorting, refresh, installation, enable switches, warnings and update indicators. The third-party detail dialog retains the full original card and its controls. Company segments count currently loaded matching entries; third-party headings count all matching entries. Desktop uses the native `data-platform` marker for its local installation hint.

Reviewable SVGs live in `crysound/brand/market-icons/`. Run `node crysound/scripts/sync-market-card-patch.mjs` to encode them into official `plugins.json` entries and regenerate the self-contained startup patch; `--check` detects drift. Both Web and desktop patch release artifacts rather than upstream sources.

The gateway stores aggregate completed authorized package GET transfers in `market.json.installs`, containing only package names and counts. Metadata reads, HEAD, rejected requests and failed transfers do not count. Updates and repeat downloads count; this is neither confirmed installation completion nor a unique-user measure. Counting starts at deployment without historical backfill. The native `crysound-installs` sort key carries counts through the existing index, labeled as installs. Back up counters with market state and registry data; operations owns restoration. Atomic writes share the existing queue, corrupt files fail visibly, and counter-write failures do not undo delivered packages.

Third-party cards retain upstream download statistics as downloads. Installed entries without supplied counts or authors explicitly show unavailable values. Company native details retain versions, categories and publication dates. Third-party details retain available native metadata; missing dates are not invented.

Run `verify-cards.mjs` in a dedicated authenticated CDP tab with `CDP_TAB`, `MARKET_RUNTIME_MODULES` (a writable copy of the five pinned 0.2.2-rc.1 browser modules) and `THIRD_PARTY_CLIENT` (dshmarket 1.73.12 client). It substitutes responses only in that tab, uses live server lists, checks three surfaces, responsive columns, truncation, actions, detail navigation and controlled search, and crops screenshots to omit the sidebar and account. `--english` overrides only tab-local locale initialization without persisting a preference. Deployment, real install completion, Use workflows and packaged desktop acceptance remain with the delivery owner.
