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
- 启动时 `src/crysound/partner.ts` 读取 `userData/partner-session.json`（权限 600）；没有令牌，或网关对令牌返回 401 时，打开窗口加载 `https://workpartner.corp.crysound.com/_zp/desktop-login`，拦截跳到 `/_zp/desktop-done#token=…&name=…&avatar=…` 的那一步，存令牌后关窗进入工作区。
- Host 环境：`MAGPIE_API_KEY`、`DEEPSEEK_API_KEY` 为令牌，`DEEPSEEK_BASE_URL=https://workpartner.corp.crysound.com/_zp/llm/v1`。
- `src/main.ts` 在恢复登录终端环境后，把公司飞书命令目录加到恢复后的 PATH 前，保留 Homebrew 和终端安装的工具。
- 运行中模型请求返回 401：`crysound/host-hook.mjs`（Host 以 `--import` 预加载）包装 `fetch`，通过 IPC 通知壳层，壳层打开登录窗口，成功后重启应用。
- 菜单“退出登录”：删令牌、清登录窗口的飞书会话，重启后进入登录窗口。

### 首次启动自动就位（`src/crysound/workspace.ts`，数据在 `crysound/config/`）
1. 5 个插件按 `plugins.json` 的固定版本，用包内 `dsh plugin --profile desktop add` 安装（已记录同版本则跳过）。
2. 运行 `plugin-patches.mjs`（每次启动一次，已打过的跳过）。
3. 4 个实验插件只开一次（标记 `userData/.zp-default-plugins-v1`）。
4. 启动时从网关读取公司配置快照，取不到时使用包内配置。默认值首次写入，之后每次只刷新 `providers.magpie`，保留个人其他提供方和已选默认值；详见 `crysound/web/README.md`。
插件安装需要联网；某个插件装失败只记日志，应用照常启动，下次启动会重试。

### 打包
- `apps/desktop/scripts/electron-builder-config.mjs`：productName、protocols、artifactName、`extraResources`（把 `crysound/` 的 `brand`、`config`、`host-hook.mjs` 放进 `Resources/crysound`）、macOS 分类与麦克风说明。
- `desktop-package-environment.mjs`：本地未签名构建的默认 appId。
- `package-target.ts`、`package-macos.ts`、`smoke-packaged-runtime.ts`、`cli/dsh`、`development-app.ts`：`.app` 名称与协议。
- `.github/workflows/desktop-mac.yml`：macOS 托管机打包，见下。

## 打包

本地开发桌面版前，先设置 `PUBLIC_HOST` 为公司网关域名（不带协议或路径），再运行 `pnpm run dev:desktop`。

- 本地（需要 Apple Silicon Mac、Node ≥ 24.9）：`pnpm install --frozen-lockfile && pnpm run package:desktop:mac:arm64:unsigned`，产物在 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/crysound-workpartner-<版本>-mac-arm64-unsigned.dmg`。
- CI：`.github/workflows/desktop-mac.yml`，手动触发或推送 `desktop/**` 分支，在 `macos-15`（Apple 芯片）上构建，依次做：打包、检查安装包内容（`crysound/scripts/verify-mac-package.sh`）、上传 artifact `crysound-workpartner-mac-arm64-unsigned`、首启动准备冒烟（`crysound/scripts/smoke-workspace.sh`，用包内运行时在临时目录里真实安装 5 个插件）。
- 签名与公证：仓库 secrets 里同时有 `CSC_LINK`（base64 的 .p12）、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 时，`crysound/scripts/sign-mac.sh` 会重签、公证、盖章并另传 `crysound-workpartner-mac-arm64-signed`；缺任何一项就跳过。
- 未签名的 dmg 下载后被系统隔离，首次打开前在终端执行 `xattr -cr /Applications/CRYSOUND\ WorkPartner.app`，或右键“打开”。

## 网页版（`crysound/web`）
每位同事一个 dsh 网页版容器，前面是一个网关，公网入口 `https://workpartner.corp.crysound.com`。
- `gateway/gateway.mjs`：飞书登录与会话；按飞书身份把请求转到本人容器；`/_zp/me`（姓名与头像）、`/_zp/download`（客户端下载页，文件放数据目录的 `downloads/`，按 `mac-arm64`、`mac-x64`、`win-x64` 命名）；桌面版登录 `/_zp/desktop-login` → `/_zp/desktop-done`，签发 180 天的桌面令牌；`/_zp/llm/v1/*` 校验桌面令牌后换成本人的模型网关钥匙转发。
- `gateway/onboard.mjs`：飞书群“AI工作台”的成员首次登录时自助开通：建模型网关钥匙、建本人容器、写名单。
- `Dockerfile`：每人容器的镜像。dsh 版本固定；5 个插件每次启动按挂载的 `plugins.json` 核对版本；语音识别模型、SlideStudio 渲染浏览器、ffmpeg 装进镜像共用；注入 `crysound/brand`；公司配置从服务器目录只读挂载，模型地址从启动环境注入。
- `entrypoint.sh`：每次启动安装或核对插件、打修补；第一次启动开实验插件、写默认配置；每次刷新公司模型清单，个人其他提供方保留（之后本人可在设置页改）。
- `bin/partner-user`：给群外的人手工开通、列名单、用新镜像重建；`bin/upgrade-when-idle.sh <代号>` 等本人 10 分钟没操作再重建；`bin/upgrade-and-check.sh`、`bin/try-fresh.sh` 用于核对。
- 部署参数（域名、飞书应用、试点群、数据目录）写在 `crysound/web/.env`，照 `.env.example` 填，不进仓库。名单、每人数据、网关状态、下载文件在 `PARTNER_DATA`，钥匙在 `PARTNER_SECURE`。

部署（在仓库 `main` 的检出里执行）：
```sh
PARTNER_BACKUP_TAG="zhaohua-partner:backup-$(date +%Y%m%d-%H%M%S)"
docker tag zhaohua-partner:0.2.2-rc.1 "$PARTNER_BACKUP_TAG"                       # 换 partner-image 前先备份当前镜像，记下此 tag
docker compose -f crysound/web/compose.yml --profile build build partner-image   # 新镜像
docker compose -f crysound/web/compose.yml build gateway                        # 构建网关镜像
docker compose -f crysound/web/compose.yml up -d --force-recreate gateway        # 网关改动（单文件挂载，必须重建才读到新文件）
for s in $(crysound/web/bin/partner-user list | cut -d' ' -f1); do
  crysound/web/bin/upgrade-when-idle.sh "$s" &                                     # 每人空闲时换新镜像
done
```
回退每人容器镜像时，用记录的备份 tag 执行 `docker tag "$PARTNER_BACKUP_TAG" zhaohua-partner:0.2.2-rc.1`，再运行上面的空闲升级循环重建用户容器；不要重新构建 `partner-image` 覆盖备份。首次部署没有旧镜像时可跳过备份步骤。

只改品牌层时，镜像里的文件版本号随内容变化，浏览器会取新文件。

客户端安装包放公司 Cloudflare 账号的 R2 存储桶 `crysound-workpartner-downloads`（亚太位置，公开域名 `partner-dl.corp.crysound.com`，对象键带随机段）。在数据目录 `downloads/` 里放 `<文件名>.url`，内容是该对象的公开地址；下载页按文件名列出，点下载时跳到 R2。文件名含 `mac-arm64`、`mac-x64`、`win-x64` 才会出现在下载页上，不含的只能直链下载（用于测试包）。

## 本人飞书与飞书项目（`crysound/feishu`）

- 设置 → 飞书授权显示飞书和飞书项目两项连接状态。网页版管理云端授权；桌面版本机模式在独立公司窗口管理本机项目授权，飞书授权仍共享网关。本机没有 CLI 时提示固定版本安装方法。
- 飞书只用本人身份。网关复用登录应用和回调，以独立的、绑定本人会话的一次性 state 区分连接流程；从应用权限接口筛选已授予的 user 权限并加入 offline_access，回调再核对 union_id。应用身份令牌只在网关读取应用权限元数据，不用于操作用户资源。
- 长期凭证在网关状态目录的 `feishu/` 中按身份散列存放，目录 700、文件 600、原子改写。每分钟检查到期前五分钟的授权并刷新；领取、刷新和断开按人串行。撤销失败先停止领取，保留不可用的待撤销记录，后台重试；成功后删除。授权到期或被撤销时明确提示重新连接，不使用过期令牌。
- 容器复用市场身份文件，向 partner-net 内未映射的 3091 端口领短期令牌；桌面版本机模式用已有登录文件向公网的受鉴权桌面入口领取。返回值只有 user_access_token、过期时间和公开应用编号。两个包装器不复制长期飞书凭证、不回退机器人身份、不自动加高风险确认参数。
- 镜像在独立前缀固定安装 `@larksuite/cli@1.0.99`、`@lark-project/meegle@1.0.27`。项目走独立 Device Code，容器的 HOME 是个人数据卷；本机用自己的凭证存储。`MEEGLE_HOST` 来自部署配置，桌面启动时从网关更新。官方 CLI 的技能及参考资料和公司确认规则从同一固定归档装入只读公司目录，独立技能提供器保留个人技能和 AGENTS.md。

部署前：负责人给现有飞书应用开通并发布所需用户权限，沿用现有回调；`.env` 设置 `FEISHU_USER_AUTH_ENABLED=1` 和 `MEEGLE_HOST`。重建 gateway、构建 partner-image，再让每人空闲时换镜像；桌面版下次正常打包带上。设 `FEISHU_USER_AUTH_ENABLED=0` 并重建网关可同时停用所有人的飞书令牌领取与刷新，仍能完成撤销。不要给 3091 增加端口映射或公网转发。

轻量自查：在已有运行时镜像中按 `crysound/web/README.md` 的隔离方式运行，额外设置 `DSH_CLI_ENTRY=/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`，测试文件为 `crysound/web/gateway/tests/feishu.test.mjs`、`crysound/feishu/tests.mjs`、`crysound/web/gateway/tests/config.test.mjs`、`crysound/web/gateway/tests/notifications.test.mjs` 和 `crysound/tests/company-config.test.mjs`；本机另跑 `node crysound/web/tests/compose-config.mjs`。全部使用假令牌和临时目录，无网络、限一核、512 MiB，不读取部署配置、安装依赖或构建镜像。设置页外观示例见 `crysound/feishu/settings-preview.png`（本机 HTTP 预览、假授权状态）。

上线验收仍由负责人做：测试账号未连接时询问日程应得到授权链接；连接后列日程、搜索并读文档；发消息先展示完整内容请本人确认；项目登录后查本人待办；断开后不能再领取令牌；另一用户无法领取本人的令牌；重建容器后项目登录保留。桌面实际 Electron 导航、系统凭证存储、Windows 命令以及安装包内的 CLI 查找需在目标平台验证，本地的无界面测试不代替这些验收。

## 公司维护的插件（`crysound/plugins/`）
- `dsh-feishu`：飞书机器人，复刻自 fan56/dsh-feishu（Apache-2.0，基线与 npm 0.17.0 逐字节一致，见 `BASELINE.md`）。包名仍是 `@aiwayds/dsh-feishu`，同事 profile 里的机器人配置按包名记录，换版本不丢。公司改动：没选会话时自动新建会话、只发回复正文不发进度卡、正常完成不发状态卡、提示先推荐 /new。
- 发版：在插件目录 `npm ci && npm test && npm pack`，版本号写成 `<上游版本>-crysound.<n>`；tgz 传到下载站存储桶 `plugins/<随机段>/` 下（`CLOUDFLARE_ACCOUNT_ID` 要指公司账号）；`crysound/config/plugins.json` 里该插件的 `spec` 与 `want` 都写这个地址（pnpm 按地址记录依赖，已装同一地址就跳过）。网页版同步服务器配置后空闲重启生效，桌面版启动时从网关刷新，断网用包内版本。
- 跟上游：把上游新提交合进插件目录，保留公司改动，重跑测试再发版。

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

## 需求单标签

打了 `agent` 标签的需求单由自动开发流程处理：改代码、开 PR、做轻量自查。PR 打上 `deliver` 标签表示已交负责人审查、合入、部署和验收；负责人验收完成后关闭需求单，并去掉 PR 的 `deliver` 标签。
