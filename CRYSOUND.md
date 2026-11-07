# 兆华工作伙伴（CRYSOUND WorkPartner）

本仓库是上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（标签 `dsh-v0.2.2-rc.1`）的公司版。公司改动集中在 `apps/desktop`（桌面版）与根目录 `crysound/`，其余目录与上游一致。`crysound/brand` 与 `crysound/config` 是桌面版和网页版共用的一份；网页版的镜像、网关与运维脚本在 `crysound/web`。

## 改了什么

### 网页版默认自动审查
- `crysound/scripts/patch-web-auto-review.mjs` 只在网页镜像构建时修补固定版本的权限 Host、权限界面和自动审查退出路径，不改上游源码或桌面运行时。未设置个人默认权限时用自动审查，显式选择继续优先；插件不可用时新会话退回工作区内修改，停用插件也不升级为完全权限。部署、额外请求消耗和回退见 [网页说明](crysound/web/README.md#默认自动审查)。

### 工作区本地服务预览
- `crysound/web/preview/`：单一预览域与主站隔离，经主站登录兑换绑定本人和当前端口的短期 Cookie，再流式转发到容器 loopback；部署、边界与线上验收见 [预览说明](crysound/web/preview/README.md)。公司启动配置为新老工作区显式启用原生 Browser；其发布包补丁由 `crysound/config/plugin-patches.mjs` 在镜像构建时应用，第三方 Artifacts 只改 MIT `lib/`。桌面本机链接保持原状，原生桌面云端连接入口尚未实现。

### 品牌
- `crysound/brand/timezone.js` 在网页与桌面前端启动前加载：仅在浏览器同时报告零偏移与 UTC/GMT 类时区时，默认日期格式化改用北京时间；显式时区保留。dsh 使用的本地日期取值、设值与日期字符串按现代北京时间（UTC+08:00）兜底，时间戳、UTC 方法与序列化不变。此脚本不模拟历史夏令时，也不改变原生日期构造或解析规则；回退时撤下两端 HTML 的该脚本入口。网页版需重建用户镜像并在空闲时更新容器，网关无改动；桌面版随下次打包生效。轻量回归：`node crysound/scripts/check-timezone.mjs`；截图与验收边界见 `crysound/web/tests/evidence/issue-80/`。
- 产品名“兆华工作伙伴”，英文 CRYSOUND WorkPartner，appId `com.crysound.workpartner`。`.app` 与可执行文件名为 `CRYSOUND WorkPartner`（ASCII，命令行入口 `dsh` 依赖它）；Finder、Dock 与菜单栏显示中文名（`CFBundleDisplayName` 与 `crysound/macos/zh_CN.lproj/InfoPlist.strings`）。
- 系统 URL 协议 `dsh://` 改为 `crysound-workpartner://`；命令行入口仍叫 `dsh`。
- B 玻璃图标与会动组件统一由 `crysound/brand/logo-src/src/gen.mjs` 生成（配色只改这一处，≤32 px 简化）；素材、预览与核对方法见 `crysound/brand/logo-src/README.md`。Windows 安装图标与托盘 ICO 按尺寸选用简化版。
- 图标由品牌源稿生成：`apps/desktop/resources/icon-macos.svg` 按 macOS 图标网格（824/1024 留边）排版，导出 1024×1024 透明 PNG；`icon-windows.*` 用满版标志。
- 菜单、关于面板与各语言文案里的 DeepSeek Harness 全部换成新名（`src/locale.ts`，中文用“兆华工作伙伴”，其他语言用 CRYSOUND WorkPartner）。
- 品牌层（`crysound/brand/`）与网页版共用，由 `src/main.ts` 的协议处理在 index 文档里注入：标题、侧栏与首页 logo、插件中文名、侧栏顺序、首次进入的飞书引导（`welcome.js`，首次进入工作区时带 `?zp-welcome=1`）。
- 公司市场：共享构建期补丁调整市场、侧栏和原生 Creator 入口，官方卡片与同事列表复用原生索引、分类和安装流程；维护人显示、包内样例图及部署方式见 `crysound/web/market/README.zh.md`。
- 首页能力引导：公司补丁复用原生输入框和命令认领，官方包维护双语说明与三个示例；首页最多四个入口，设计、动效由官方配置启用。缺引导或已装版本不符时回到原生设置；网页与桌面读同一受鉴权端点，部署和验收限制见市场说明。
- 官方插件策略：`plugins.json` 的 `officialPlugins` 提供中文名与维护人，原生管理页禁止卸载而允许停用；`retire` 在新老工作区一次性移出三款旧预装，保留作品和共用浏览器。发布与版本同步见市场说明。
- 左下角账号按钮显示飞书头像和姓名，菜单里的“登录”项换成姓名（不可点）。`brand.js` 向 `/_zp/me` 取 `{name, avatar}`：网页版由网关按登录会话回答，桌面版由 `src/main.ts` 按本机保存的登录回答。网页版在账号按钮上方多一个“下载客户端”入口，指向网关的 `/_zp/download`。

- 飞书原生模块通过主界面插槽提醒未连接主飞书授权的人；未连接者每天首次打开再弹原生说明框，按本机日期在本机去重并避让首次引导；连接成功同时隐藏，飞书项目未连接不提醒。共用设置页授权动作和网关状态，不新增凭据记录（`crysound/feishu/native`）。

### 断开 DeepSeek 服务
- 自动更新：已签名 Mac 正式包使用公司 generic 更新目录与 `latest` 通道，启动及每六小时检查并后台下载，中文提示可选重启，保留上游任务保护；未签名包与开发版不开启。主入口的公司接入均标注 `CRYSOUND`，更新源仅由签名步骤注入，菜单里的“检查更新”换成“退出登录”。构建、发布与待验证项见 `crysound/scripts/mac-auto-update.md`。
- 强制更新：不读取清单与环境里的 `dshMandatoryUpdatePolicy`。
- 埋点：Host 环境固定 `DSH_TELEMETRY_DISABLED=1`，壳层 `analyticsEnabled` 恒为 `false`。
- DeepSeek 账号：不显示欢迎/登录窗口，`PLATFORM_IPC.open`（DeepSeek 用量与充值页）直接拒绝。

Mac 更新清单和安装包通过网关 `/_zp/updates/mac/` 读取；新旧域名均用桌面通行证鉴权，文件在 `downloads/updates/mac/`。桌面版检查、下载前读取当前登录；未登录时等待下一轮。

### 原生飞书授权设置
- `crysound/feishu/native` 是随应用分发的公司设置模块，注册原生 `settings.section` 和链接图标，复用原生按钮与主题；品牌脚本不再插入设置导航链接。`prepareSkillProfile` 在安装公司技能时将本地模块写入个人 profile，重复执行不重复加条目，不需要从市场安装。
- 网页授权使用小窗；飞书内置浏览器使用同页授权，完成后通过固定 `?zp-settings=feishu` 标记打开原生设置。旧 `/_zp/feishu/` 页面继续可用。授权回调只向同源 opener 发送完成事件，不传授权码或令牌。
- 桌面版 `main.ts` 仅增加公司设置的协议路由，`partner.ts` 和 `feishu/desktop.mjs` 在主进程复用本人登录与原有接口，隔离子窗口完成授权；渲染页不接触凭据。新授权附带授权时间，自动刷新不改变该时间；旧记录没有时间时明确显示未记录。
- 部署需要同步公司配置的 `plugin-patches.mjs`（明确打开的设置页暂缓首次引导）、重启网关、重建个人容器镜像及重新发布桌面版。测试和真实验收步骤见 `crysound/feishu/README.md`；截图是测试状态预览，不能替代真实飞书与桌面安装包验收。

### 登录与模型
- 启动时 `src/crysound/partner.ts` 读取 `userData/partner-session.json`（权限 600）；没有令牌，或网关对令牌返回 401 时，打开窗口加载 `https://workpartner.corp.crysound.com/_zp/desktop-login`，拦截跳到 `/_zp/desktop-done#token=…&name=…&avatar=…` 的那一步，存令牌后关窗进入工作区。
- Host 环境：`MAGPIE_API_KEY`、`DEEPSEEK_API_KEY` 为令牌，`DEEPSEEK_BASE_URL=https://workpartner.corp.crysound.com/_zp/llm/v1`。
- `src/main.ts` 在恢复登录终端环境后，把公司飞书命令目录加到恢复后的 PATH 前，保留 Homebrew 和终端安装的工具。
- 运行中模型请求返回 401：`crysound/host-hook.mjs`（Host 以 `--import` 预加载）包装 `fetch`，通过 IPC 通知壳层，壳层打开登录窗口，成功后重启应用。
- 菜单“退出登录”：删令牌、清登录窗口的飞书会话，重启后进入登录窗口。

### 首次启动自动就位（`src/crysound/workspace.ts`，数据在 `crysound/config/`）
飞书技能由 `crysound/feishu/setup.mjs` 解压到公司版本目录：先重命名到最终位置，再将根目录设为只读，兼容 macOS；失败时恢复本次副本的目录及文件写权限后清理，已有 `.complete` 的版本直接复用。

1. 插件按 `plugins.json` 的固定版本就位。构建时 `apps/desktop/scripts/prepare-plugin-template.ts` 只把公开源和本地归档插件装进临时 profile，结果（`package.json`、存在时的 `pnpm-lock.yaml`、`modules/` 即 `node_modules`）随包放在 `Resources/crysound/plugin-template`。首次启动在 profile 未记录随包插件且 `node_modules` 为空时复制模板；校验只要求随包插件齐全。模板缺失、版本不符、已有旧版插件或复制失败时，退回联网执行包内 `dsh plugin --profile desktop add`。`@crysound/*` 市场包不进入模板，在登录后用桌面通行证联网安装；公司配置新增或升级的市场包也由每次启动的版本核对安装，已记录同版本则跳过。模板在与构建机同架构的 macOS 或原生 Windows x64 目标上生成。
2. 运行 `plugin-patches.mjs`（每次启动一次，已打过的跳过）。
3. 4 个实验插件只开一次（标记 `userData/.zp-default-plugins-v1`）。
4. 启动时从网关读取公司配置快照，取不到时使用包内配置。默认值首次写入，之后每次只刷新 `providers.magpie`，保留个人其他提供方和已选默认值；详见 `crysound/web/README.md`。
市场插件和退回联网安装的插件需要网络；每一步都有时限：联网安装单个插件 120 秒、一次启动内全部联网安装共 180 秒，超时就结束该子进程及其子孙进程，剩下的跳过，下次启动重试。准备期间（复制模板或联网安装）显示“正在准备兆华工作伙伴…”小窗口，点 Dock 图标会把它带到前台；结束后若有插件没装好，弹出非阻塞提示并列出名字，应用照常启动，下次启动会重试。Mac / Windows 离线冒烟只核对随包插件，市场包明确记为“登录后联网安装、尚未验收”；签名构建及登录后的实际安装另行验收。

### 打包
- `apps/desktop/scripts/electron-builder-config.mjs`：productName、protocols、artifactName、`extraResources`（把 `crysound/` 的 `brand`、`config`、`host-hook.mjs` 放进 `Resources/crysound`）、macOS 分类与麦克风说明。
- `desktop-package-environment.mjs`：本地未签名构建的默认 appId。
- `package-target.ts`、`package-macos.ts`、`smoke-packaged-runtime.ts`、`cli/dsh`、`development-app.ts`：`.app` 名称与协议。
- `.github/workflows/desktop-mac.yml`：macOS 托管机打包，见下。

## 打包

本地开发桌面版前，先用 Node 24 执行 `node crysound/plugin-artifacts.mjs download crysound/company-plugins` 准备固定插件包（生成目录不提交），再设置 `PUBLIC_HOST` 为公司网关域名（不带协议或路径），再运行 `pnpm run dev:desktop`。

- 本地（需要 Apple Silicon Mac、Node ≥ 24.9）：`pnpm install --frozen-lockfile && pnpm run package:desktop:mac:arm64:unsigned`，产物在 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/crysound-workpartner-<版本>-mac-arm64-unsigned.dmg`。
- CI：`.github/workflows/desktop-mac.yml`，只手动触发，输入正式版本号 `version` 与更新目录 `update_url`（可回退到仓库变量 `CRYSOUND_DESKTOP_UPDATE_URL`），在 `macos-15`（Apple 芯片）上构建。正式版本通过打包元数据注入，源 manifest 与运行时版本不变。依次做：更新自查、打包、检查安装包内容（`crysound/scripts/verify-mac-package.sh`）、上传 artifact `crysound-workpartner-mac-arm64-unsigned`、首启动准备冒烟（`crysound/scripts/smoke-workspace.sh`，用包内运行时在临时目录里、npm 源指向不可达地址的条件下准备 5 个插件，打印用时，并附联网安装的对照用时）。
- 签名与公证：仓库 secrets 里同时有 `CSC_LINK`（base64 的 .p12）、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 时，`crysound/scripts/sign-mac.sh` 会重签（含 `plugin-template` 里的全部 Mach-O 文件）、公证、盖章并另传 `crysound-workpartner-mac-arm64-signed`；完整发版输入还生成签名 app 的 ZIP 与 `latest-mac.yml`，随 DMG 一起上传为工作流产物，下载站由伙伴助理手动发布。缺任何签名凭据就跳过。
- 未签名的 dmg 下载后被系统隔离，首次打开前在终端执行 `xattr -cr /Applications/CRYSOUND\ WorkPartner.app`，或右键“打开”。

## 网页版（`crysound/web`）
每位同事一个 dsh 网页版容器，前面是一个网关，公网入口 `https://workpartner.corp.crysound.com`。
- `gateway/gateway.mjs`：飞书登录与会话；按飞书身份把请求转到本人容器；`/_zp/me`（姓名与头像）、`/_zp/download`（客户端下载页，文件放数据目录的 `downloads/`，按 `mac-arm64`、`mac-x64`、`win-x64` 命名）；桌面版登录 `/_zp/desktop-login` → `/_zp/desktop-done`，签发 180 天的桌面令牌；`/_zp/llm/v1/*` 校验桌面令牌后换成本人的模型网关钥匙转发。
- `gateway/onboard.mjs`：飞书群“AI工作台”的成员首次登录时自助开通：建模型网关钥匙、建本人容器、写名单。
- `Dockerfile`：每人容器的镜像。dsh 版本固定；公司插件每次启动按挂载的 `plugins.json` 核对版本；语音识别模型、SlideStudio 渲染浏览器、ffmpeg 装进镜像共用；注入 `crysound/brand`；公司配置从服务器目录只读挂载，模型地址从启动环境注入。
- `web/web-tools/`：镜像构建时给固定 dsh 发布产物装公司搜索、抓取适配。搜索按会话模型在 ChatGPT 与 DeepSeek 间选择、失败互相回退；抓取允许最多五跳，对公网地址检查并固定连接地址，短动态页复用镜像 Chromium。登录页明确报错，私网与本机地址不再由 `web_fetch` 读取。测试和回退见 `crysound/web/web-tools/README.md`。
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

## 兆华数据（网关与插件）

- 网关 `/_zp/treg/` 使用现有个人通行证，受控 MCP 与 REST 共用平台白名单、归属和单次金额上限；日/月限额用 Treg 原生 user 标签预算，每人默认日 1、月 5 美元；缺组织令牌自动关闭，真实费用归属验证前不开放付费入口。本人用量取上游 UTC 当日/当月账单；北京时间每天 08:00、每月 1 日 08:00 重置。
- 兆华数据 `@crysound/data` 经现有审批进入兆华市场普通官方卡片，分类“数据”。市场保持 #61 的三个标签；七类分组、示例和易读价格说明在独立插件内部，本仓库不提供数据目录页或市场目录缓存。
- `config/patch-data-use.mjs` 为原生卡片增加“使用”：已启用时打开分类引导草稿、保留已有草稿、不自动发送；停用时进入原生设置。网页镜像与桌面打包共用幂等补丁，无额外桌面目录代理。部署配置、回退与待验收项见 `crysound/web/treg/README.md`。

## 公司维护的插件（`crysound/plugins/`）

- `memory`（`@crysound/memory`，个人记忆）：独立最小实现，主对话模型主动保存稳定的个人事实，在新会话中按总预算召回；中文设置页支持个人开关、添加、编辑、确认删除和清空，显示来源及时间；随机编号支持原条目更新，满额经用户同意原子合并再新增，拒存证件和银行卡号。数据仅在个人 DSH home 的插件专属 SQLite 文件，使用 DELETE 日志模式，不接新模型或服务，不加入预装。中文页和存储方案已获分诊确认，交伙伴助理测试账号验收；正式网关、桌面版、备份恢复、长期并发及提取率仍未验收。评估见 `crysound/plugins/memory-evaluation/`；Node 实验性 SQLite 的升级复查、镜像版本和备份恢复步骤见插件 README，验收后征得负责人同意才预装。
- `design`：`@crysound/design` 公司设计技能（固定 huashu-design + frontend-design 来源），提供 `/design` 与技能工具入口；默认公司品牌，只保留网页、App 原型、信息图、海报和体检，复用现有 SlideStudio 浏览器且最多并发两个。打包、兆华市场发布与测试账号验收见 `crysound/plugins/design/README.md`，不自动加入全员预装清单。
- `motion`：`@crysound/motion`，固定 huashu-motion 0.3.1 的无依赖渲染子集；公司中文品牌模板、静帧、合成配乐与 MP4/GIF。网页版复用共用浏览器和 ffmpeg，同一容器一次一项任务、最多 2 个渲染浏览器、5 分钟截止；不启动预览服务，不下载口播模型或采样。市场发布与镜像预置说明见 `crysound/plugins/motion/README.md`，未加入默认插件清单。
- `dsh-feishu`：飞书机器人，复刻自 fan56/dsh-feishu（Apache-2.0，基线与 npm 0.17.0 逐字节一致，见 `BASELINE.md`）。包名仍是 `@aiwayds/dsh-feishu`，同事 profile 里的机器人配置按包名记录，换版本不丢。公司改动：没选会话时自动新建会话、只发回复正文不发进度卡、正常完成不发状态卡、提示先推荐 /new。
- 飞书本地包：`crysound/plugin-artifacts.mjs` 固定下载地址和 SHA-512。网页构建下载并校验到 `/opt/company-plugins/`，`plugins.json` 的 spec/want 使用 `file:/opt/company-plugins/<文件名>`；入口在安装前只补回这一个旧远程包缺失的锁文件校验值。Mac/Windows 打包都携带同一归档，桌面准备时校验并复制到 profile 的 `company-plugins/`，依赖与模板锁文件使用 `file:company-plugins/<文件名>`，不记录构建机或安装包路径。桌面准备按 assets 资源目录加载共用脚本，不依赖源码或编译后文件的相对层级。
- 发版：在插件目录 `npm ci && npm test && npm pack`，版本号写成 `<上游版本>-crysound.<n>`；tgz 传到下载站存储桶 `plugins/<随机段>/` 下（`CLOUDFLARE_ACCOUNT_ID` 要指公司账号）；飞书版本更新同时修改 `plugin-artifacts.mjs` 的文件名、下载地址和校验值，以及 `plugins.json` 的本地 spec/want。重建网页镜像并同步配置，逐人空闲时换镜像；桌面随下一安装包携带归档。不要只同步本地路径清单而沿用缺归档的旧镜像或旧桌面包。
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
