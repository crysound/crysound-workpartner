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

Publish with `npm publish --registry https://<PUBLIC_HOST>/_zp/npm/`; names must match `@crysound/*`. Use the bundled “发布到兆华市场” publishing skill, which selects the user’s `.npmrc` through application-provided path variables; containers use the internal entrypoint. Only single-version bundles with a tarball, description, and `dsh.bundle.patch` are accepted. The first successful publisher owns the package and alone can publish later versions. Deletion, overwriting, and dist-tag changes are forbidden.

After publishing, the gateway persists pending status and sends an interactive card through the existing Feishu bot. The card’s “查看并审批” button opens `https://<PUBLIC_HOST>/_zp/market/admin`. Administrators must log in through Feishu in the browser; desktop Bearer tokens cannot replace administrator sessions. Approval and rejection POSTs also check Origin and record the reviewer and time. Notification failure leaves the published version intact and is reported in gateway logs. The approval page’s “重发审批卡片” button retries delivery.

`/_zp/npm/*` and `/_zp/market/index.json` both use `desktopUser` to validate the Bearer zpd signature, expiry, and provisioned-user list; browser cookies cannot replace it. Package metadata lists only approved versions; publishers can additionally read and install their own pending versions by explicit version. Version and tarball requests enforce the same rule; rejected, publishing, and unrecorded versions return 404 for everyone. `dist-tags.latest` always selects the highest approved version by SemVer and is omitted when none is approved; packages without approved versions return 404 for other users. Publishing does not set latest to the new version. Internal metadata returns internal tarball URLs, while public metadata returns public URLs. The gateway substitutes its internal account for both; clients hold only their own tokens.

The format-1 index combines Verdaccio metadata with approval records. `package.json` may provide a 1–80 character `displayName` (preferred) or `title`; the index emits the native `title` field, while installation keeps the npm package name. Without either field, the client displays the package name. `MARKET_OFFICIAL_PUBLISHERS` and `MARKET_OFFICIAL_PACKAGES` are comma-separated deployment settings; both the stored package owner and package name must match, with `@crysound/*` supported as the whole-scope package selector. Empty settings designate no official packages. Operations sets the designated company publishing account in `.env`; no account name is embedded in code. Official entries use author “兆华工作伙伴” and the native localized label “兆华官方” / “CRYSOUND official”; the existing design and motion packages display “兆华设计” and “兆华动效” even before their next release. Other authors use the publisher’s name from `users.json`, falling back to the slug, and receive no official label regardless of package-supplied claims. It lists all approved versions still present in descending SemVer order, including `engines.dsh`, and omits registry, relying on `@crysound:registry` mapping. Failure to check the registry returns an error rather than an empty index. dsh caches the index for ten minutes; users can refresh it in 兆华市场 / CRYSOUND market. Phase one provides no public CDN mirror of private package READMEs, so detailed descriptions may be unavailable.

The Plugins page combines Installed (upstream `ui-plugin-manager`), the third-party tab (`dshmarket`, id `dsh-market`), and Discover (`ui-plugin-market`, id `discover`, enabled by `dsh-experimental-plugin-market-bundle`). The shared build-time `crysound/scripts/patch-market-ui.mjs` patch orders them as 兆华市场 / CRYSOUND market, 第三方市场 / Third-party market, then Installed. The first visit selects the company market even when its tab registers late; explicit tab selections, installed-package navigation, and the Installed fallback when Discover is unavailable remain functional. The patch changes the actual tab items, preserving matching keyboard order, and refuses unmatched runtime versions. Web images and desktop packages apply it before shipping; running user containers do not write to the global runtime. Rebuild the web image and use the next desktop package to update the tab UI; recreate the gateway and publish the company configuration to update index metadata and the publishing skill.

Before uploading, the gateway atomically saves publishing status. A dropped connection, 5xx response, or later save failure may follow a successful upload; the gateway neither retries automatically nor releases ownership. An administrator must stop the gateway, back up data, and compare the Verdaccio version with `market.json`. Change publishing to pending only after confirming the version exists and its contents are correct. Remove the version reservation only after confirming nothing was written; remove the package record if no versions remain. If uncertain, retain publishing. Restart the gateway after editing, then review the version. Never delete a published tarball. Corrupted state is not reset to empty; restore paired backups. Recovery in this phase is performed only by operations.

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
