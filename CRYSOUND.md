# 兆华工作伙伴（CRYSOUND WorkPartner）

本仓库是上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（标签 `dsh-v0.2.2-rc.1`）的公司版。公司改动集中在 `apps/desktop`（桌面版）与根目录 `crysound/`，其余目录与上游一致。`crysound/brand` 与 `crysound/config` 是桌面版和网页版共用的一份；网页版的镜像、网关与运维脚本在 `crysound/web`。

## 改了什么

### 品牌
- 产品名“兆华工作伙伴”，英文 CRYSOUND WorkPartner，appId `com.crysound.workpartner`。`.app` 与可执行文件名为 `CRYSOUND WorkPartner`（ASCII，命令行入口 `dsh` 依赖它）；Finder、Dock 与菜单栏显示中文名（`CFBundleDisplayName` 与 `crysound/macos/zh_CN.lproj/InfoPlist.strings`）。
- 系统 URL 协议 `dsh://` 改为 `crysound-workpartner://`；命令行入口仍叫 `dsh`。
- 图标由 `crysound/brand/zp-mark.svg` 生成：`apps/desktop/resources/icon-macos.svg` 按 macOS 图标网格（824/1024 留边）排版，导出 1024×1024 透明 PNG；`icon-windows.*` 用满版标志。
- 菜单、关于面板与各语言文案里的 DeepSeek Harness 全部换成新名（`src/locale.ts`，中文用“兆华工作伙伴”，其他语言用 CRYSOUND WorkPartner）。
- 品牌层（`crysound/brand/`）与网页版共用，由 `src/main.ts` 的协议处理在 index 文档里注入：标题、侧栏与首页 logo、插件中文名、侧栏顺序、首次进入的飞书引导（`welcome.js`，首次进入工作区时带 `?zp-welcome=1`）。
- 左下角账号按钮显示飞书头像和姓名，菜单里的“登录”项换成姓名（不可点）。`brand.js` 向 `/_zp/me` 取 `{name, avatar}`：网页版由网关按登录会话回答，桌面版由 `src/main.ts` 按本机保存的登录回答。网页版在账号按钮上方多一个“下载客户端”入口，指向网关的 `/_zp/download`。

### 断开 DeepSeek 服务
- 自动更新：协调器的 `enabled` 恒为 `false`；未签名包本身不带 `app-update.yml`。菜单里的“检查更新”换成“退出登录”。
- 强制更新：不读取清单与环境里的 `dshMandatoryUpdatePolicy`。
- 埋点：Host 环境固定 `DSH_TELEMETRY_DISABLED=1`，壳层 `analyticsEnabled` 恒为 `false`。
- DeepSeek 账号：不显示欢迎/登录窗口，`PLATFORM_IPC.open`（DeepSeek 用量与充值页）直接拒绝。

### 登录与模型
- 启动时 `src/crysound/partner.ts` 读取 `userData/partner-session.json`（权限 600）；没有令牌，或网关对令牌返回 401 时，打开窗口加载 `https://partner.corp.crysound.com/_zp/desktop-login`，拦截跳到 `/_zp/desktop-done#token=…&name=…&avatar=…` 的那一步，存令牌后关窗进入工作区。
- Host 环境：`MAGPIE_API_KEY`、`DEEPSEEK_API_KEY` 为令牌，`DEEPSEEK_BASE_URL=https://partner.corp.crysound.com/_zp/llm/v1`。
- 运行中模型请求返回 401：`crysound/host-hook.mjs`（Host 以 `--import` 预加载）包装 `fetch`，通过 IPC 通知壳层，壳层打开登录窗口，成功后重启应用。
- 菜单“退出登录”：删令牌、清登录窗口的飞书会话，重启后进入登录窗口。

### 首次启动自动就位（`src/crysound/workspace.ts`，数据在 `crysound/config/`）
1. 5 个插件按 `plugins.json` 的固定版本就位。构建时 `apps/desktop/scripts/prepare-plugin-template.ts` 用打包用的 dsh 运行时把它们装进临时 profile，结果（`package.json`、`pnpm-lock.yaml`、`modules/` 即 `node_modules`）随包放在 `Resources/crysound/plugin-template`；首次启动在 profile 里还没有这 5 个插件、`node_modules` 为空时，把模板复制进去并写入插件记录，几秒内完成。模板缺失、版本不符、profile 里已有旧版插件或复制失败时，退回联网执行包内 `dsh plugin --profile desktop add`（已记录同版本则跳过）。模板只在与构建机同架构的 macOS 目标上生成。
2. 运行 `plugin-patches.mjs`（每次启动一次，已打过的跳过）。
3. 4 个实验插件只开一次（标记 `userData/.zp-default-plugins-v1`）。
4. 默认配置 `partner.patch.yml` 只写一次到 profile 的 `cordis.patch.yml`（标记 `.zp-seed-v1`，已有同 id 项不覆盖）。
只有退回联网安装时才需要网络；每一步都有时限：联网安装单个插件 120 秒、一次启动内全部联网安装共 180 秒，超时就结束该子进程及其子孙进程，剩下的跳过，下次启动重试。准备期间（复制模板或联网安装）显示“正在准备兆华工作伙伴…”小窗口，点 Dock 图标会把它带到前台；结束后若有插件没装好，弹出非阻塞提示并列出名字。某个插件装失败只记日志，应用照常启动，下次启动会重试。

### 打包
- `apps/desktop/scripts/electron-builder-config.mjs`：productName、protocols、artifactName、`extraResources`（把 `crysound/` 的 `brand`、`config`、`host-hook.mjs` 放进 `Resources/crysound`）、macOS 分类与麦克风说明。
- `desktop-package-environment.mjs`：本地未签名构建的默认 appId。
- `package-target.ts`、`package-macos.ts`、`smoke-packaged-runtime.ts`、`cli/dsh`、`development-app.ts`：`.app` 名称与协议。
- `.github/workflows/desktop-mac.yml`：macOS 托管机打包，见下。

## 打包
- 本地（需要 Apple Silicon Mac、Node ≥ 24.9）：`pnpm install --frozen-lockfile && pnpm run package:desktop:mac:arm64:unsigned`，产物在 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/crysound-workpartner-<版本>-mac-arm64-unsigned.dmg`。
- CI：`.github/workflows/desktop-mac.yml`，手动触发或推送 `desktop/**` 分支，在 `macos-15`（Apple 芯片）上构建，依次做：打包、检查安装包内容（`crysound/scripts/verify-mac-package.sh`）、上传 artifact `crysound-workpartner-mac-arm64-unsigned`、首启动准备冒烟（`crysound/scripts/smoke-workspace.sh`，用包内运行时在临时目录里、npm 源指向不可达地址的条件下准备 5 个插件，打印用时，并附联网安装的对照用时）。
- 签名与公证：仓库 secrets 里同时有 `CSC_LINK`（base64 的 .p12）、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 时，`crysound/scripts/sign-mac.sh` 会重签（含 `plugin-template` 里的全部 Mach-O 文件）、公证、盖章并另传 `crysound-workpartner-mac-arm64-signed`；缺任何一项就跳过。
- 未签名的 dmg 下载后被系统隔离，首次打开前在终端执行 `xattr -cr /Applications/CRYSOUND\ WorkPartner.app`，或右键“打开”。

## 网页版（`crysound/web`）
每位同事一个 dsh 网页版容器，前面是一个网关，公网入口 `https://partner.corp.crysound.com`。
- `gateway/gateway.mjs`：飞书登录与会话；按飞书身份把请求转到本人容器；`/_zp/me`（姓名与头像）、`/_zp/download`（客户端下载页，文件放数据目录的 `downloads/`，按 `mac-arm64`、`mac-x64`、`win-x64` 命名）；桌面版登录 `/_zp/desktop-login` → `/_zp/desktop-done`，签发 180 天的桌面令牌；`/_zp/llm/v1/*` 校验桌面令牌后换成本人的模型网关钥匙转发。
- `gateway/onboard.mjs`：飞书群“AI工作台”的成员首次登录时自助开通：建模型网关钥匙、建本人容器、写名单。
- `Dockerfile`：每人容器的镜像。dsh 与 5 个插件按 `crysound/config/plugins.json` 固定版本；语音识别模型、SlideStudio 渲染浏览器、ffmpeg 装进镜像共用；注入 `crysound/brand`；默认配置用共用的 `partner.patch.yml`，构建时把模型地址换成内部 magpie。
- `entrypoint.sh`：每次启动安装或核对插件、打修补；第一次启动开实验插件、写默认配置（之后本人可在设置页改）。
- `bin/partner-user`：给群外的人手工开通、列名单、用新镜像重建；`bin/upgrade-when-idle.sh <代号>` 等本人 10 分钟没操作再重建；`bin/upgrade-and-check.sh`、`bin/try-fresh.sh` 用于核对。
- 名单、每人数据、网关状态、下载文件在 `PARTNER_DATA`（默认 `/srv/xiaoman/zhaohua-partner`），钥匙在 `PARTNER_SECURE`，都不进仓库。

部署（在仓库 `main` 的检出里执行）：
```sh
docker compose -f crysound/web/compose.yml --profile build build partner-image   # 新镜像
docker compose -f crysound/web/compose.yml up -d --force-recreate gateway        # 网关改动（单文件挂载，必须重建才读到新文件）
for s in $(PARTNER_DATA=/srv/xiaoman/zhaohua-partner crysound/web/bin/partner-user list | cut -d' ' -f1); do
  crysound/web/bin/upgrade-when-idle.sh "$s" &                                     # 每人空闲时换新镜像
done
```
只改品牌层时，镜像里的文件版本号随内容变化，浏览器会取新文件。

客户端安装包放公司 Cloudflare 账号的 R2 存储桶 `crysound-workpartner-downloads`（亚太位置，公开域名 `partner-dl.corp.crysound.com`，对象键带随机段）。在数据目录 `downloads/` 里放 `<文件名>.url`，内容是该对象的公开地址；下载页按文件名列出，点下载时跳到 R2。文件名含 `mac-arm64`、`mac-x64`、`win-x64` 才会出现在下载页上，不含的只能直链下载（用于测试包）。

## 合并上游新版本
1. `git fetch upstream && git merge upstream/master`（上游默认分支名以实际为准，标签 `dsh-v*` 也可合并）。
2. 冲突集中在下面这些文件，保留上游新内容，再把我们的几行改回去：
   - `apps/desktop/src/main.ts`：公司登录、更新与账号关闭、品牌注入、菜单与协议，所有改动都标有 `partner`、`DEEPSEEK_PLATFORM_ENABLED`、`crysound` 字样。
   - `apps/desktop/src/host-process.ts`：`--import` 钩子和 `crysound-auth-expired` 事件。
   - `apps/desktop/src/web-document.ts`：`transformIndex` 参数。
   - `apps/desktop/src/locale.ts`：产品名。上游新增含 “DeepSeek Harness” 的文案时，重新执行替换（`en` 等用 CRYSOUND WorkPartner，`zh` 用兆华工作伙伴）。
   - `apps/desktop/scripts/*`：见上文“打包”。
   - `apps/desktop/resources/icon-*`：用 `crysound/brand/zp-mark.svg` 重新导出。
3. 插件版本、实验插件、修补集中在 `crysound/config/`，桌面版与网页版共用：升级插件时改 `plugins.json` 和 `plugin-patches.mjs`，两边同时生效。
4. 上游升级 `dsh` 运行时版本后，核对 `plugin-patches.mjs` 的每一条是否还命中（未命中会在启动日志里打印“插件修补未命中”）。
5. 合并后先在分支上推送，等 `desktop-mac.yml` 通过再合入 `main`。

## 已知限制
- 签名、公证与 Gatekeeper 校验的步骤已写好，尚未在 CI 上跑通。
- `apps/desktop/tests` 里与上游品牌文案绑定的期望文件（`tests/expected/*`）没有同步，上游桌面单测在本仓库不保证通过。
- 本版没有随包带语音识别模型、SlideStudio 渲染浏览器、ffmpeg；这些依赖在网页版里装进镜像，桌面版需要时由插件自己下载或使用本机已有的。
- Windows 与 Intel Mac 的打包脚本保持上游状态，品牌与登录改动在这两个平台上没有验证。
