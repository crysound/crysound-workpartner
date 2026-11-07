# 兆华市场第一期

[English](README.md) | 中文

公司市场使用 dsh 的实验组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，入口是插件页的“兆华市场”标签，不修改 dshmarket。新旧用户启动时补齐 bundle 和公司索引；之后用户关闭 bundle 或修改 indexes 时保留其选择。发布技能随公司资源安装到 `<DSH_HOME>/skills/publish-zhaohua-market`。

## 部署配置

部署参数统一放在 `crysound/web/.env`，照 [示例](../.env.example) 填。`PUBLIC_HOST` 沿用公司网关域名；新增的 `MARKET_ADMINS` 必填已开通用户的 slug，首期填写 Jason 的 slug，多人用逗号分隔。用 `partner-user list` 由管理员核对代号，不把个人编号提交到仓库。所有管理员同时拥有审批权限并收到提醒。机器人需启用发送消息权限（如 `im:message:send_as_bot`），发布应用版本，且管理员在应用可用范围内。

Verdaccio 只加入已有 `partner-net`，没有宿主映射端口，`uplinks: {}` 禁止代理公网 npm。只允许内部网关账号访问 `@crysound/*`；其他 scope 一律拒绝。网关使用公司 Dockerfile 安装锁定的 semver 依赖，校验发布版本和 `engines.dsh`。数据保存在 `PARTNER_DATA/npm`，与 `PARTNER_DATA/gateway/state/market.json` 一起备份和恢复。不要单独恢复其中一份，也不要同时运行多个网关实例写同一市场状态文件。

首次部署由服务器管理员加载 `.env` 后准备目录和内部凭据；以下命令只在目标服务器执行，需要 root 和 `htpasswd`（Debian 的 `apache2-utils`）。随机内部密码不输出到终端；已有文件不覆盖，不把内容复制到 `.env` 或交给用户。网关读取 `market-npm-auth`（root:root 600），Verdaccio 读取同账号密码的 bcrypt `market-htpasswd`（10001:65533 400）。

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

网关启动给已开通用户签发 `.zp-market-token`（zpd，180 天），自助或手工开通也会签发；用户目录与文件分别归 UID 1001 所有。再按现有空闲升级流程重建用户容器，入口脚本将令牌原文写到 `/data/.npmrc`，权限 600。它不能引用含 TOKEN 的环境变量，因为 dsh 的 pnpm 子进程会过滤此类变量。市场 npm 配置、插件修补、profile 升级或发布技能复制失败时打印警告并继续启动。不支持的用户 YAML 或无效的 profile JSON 会跳过市场配置，保留原文件；请在设置页手工添加公司索引和市场 bundle。180 天内重建容器以更新身份；过期 401 时重建，不让用户索取内部密码。`partner-user upgrade` 也会重新签发；其签名格式与网关一致。

桌面版更新后登录或恢复登录时写 desktop profile 的 `.npmrc`，仅维护公司 scope 和该注册表的 `_authToken`，保留其他配置，切换域名时删除旧市场入口的令牌，退出登录移除公司两项。Host 的 fetch 钩子只给同一公司 origin 的 `/_zp/market/` 补 Authorization，拒绝重定向，401 触发原有重新登录流程。公司索引和模型占位地址在桌面准备阶段替换，网页版 Dockerfile 用 sed 换成 Docker 内部地址。

本地开发桌面版先设置 `PUBLIC_HOST`。桌面打包前运行 `node crysound/scripts/configure-public-host.mjs`，它从 `crysound/web/.env` 只提取 `PUBLIC_HOST`，生成被 git 忽略的 `crysound/config/public-host.json`；其他部署值不写入桌面资源。也可显式传入 `PUBLIC_HOST`，此时不读取 `.env`。Mac 和 Windows 打包工作流使用仓库变量 `PUBLIC_HOST`，由运维与部署 `.env` 中的同名值同步；缺失时构建失败。运行时同名环境变量可覆盖安装包值。代码不内置正式或旧域名；生成配置中的域名应使用当前正式入口，避免鉴权请求经过旧网址跳转。

## 发布与审批

发布入口是 `npm publish --registry https://<PUBLIC_HOST>/_zp/npm/`，包名仅 `@crysound/*`。用随包的“发布到兆华市场”技能完成准备和发布，它通过应用提供的路径变量选择本人 `.npmrc`；容器用内网入口。只接受单版本、带 tarball、description 和 `dsh.bundle.patch` 的组合包。第一个成功发布者取得包所有权，非官方包后续只能该用户发布新版本；官方包还允许指定维护人续发，每个版本仍需管理员审批；禁止删除、覆盖和改写 dist-tag。

发布成功后持久化 pending 状态，并通过现有飞书机器人发交互卡片。卡片的“查看并审批”打开 `https://<PUBLIC_HOST>/_zp/market/admin`，管理员必须用飞书网页登录；桌面 Bearer 不能代替管理员会话。批准或拒绝的 POST 还检查 Origin，记录操作者与时间。发送失败不影响已发布版本，网关日志会报告失败；审批页的“重发审批卡片”可重试。

`/_zp/npm/*` 和 `/_zp/market/index.json` 都用 `desktopUser` 校验 Bearer zpd 的签名、期限及开通名单，不接受浏览器 cookie 代替。包元数据仅列出已批准版本；发布者还可读取并按明确版本号安装自己的 pending 版本。版本和 tarball 请求执行相同规则；rejected、publishing 和无审批记录的版本对所有人返回 404。`dist-tags.latest` 始终按 SemVer 指向最高的已批准版本，没有已批准版本时省略；此时其他用户请求该包返回 404。发布时不将 latest 指向新版本。内网元数据返回内网 tarball 地址，公网返回公网地址，均由网关替换内部账号；客户端只持有本人令牌。

索引为 format 1，结合 Verdaccio 包数据与审批记录。`package.json` 可写 1 到 80 字的 `displayName`（优先）或 `title`，索引使用原生 `title` 字段；安装仍使用 npm 包名，未填写显示名时仍显示包名。`plugins.json` 的 `officialPlugins` 按包名配置 `{displayName, maintainers}`，显示名以“兆华”开头，维护人使用部署名单代号。网关据此指定官方身份、中文名和作者“兆华工作伙伴”；普通包不能用包名、`displayName` 或 `title` 冒用“兆华”前缀。官方包首次发布仅允许公司发布账号或维护人，现有包的所有者及指定维护人可以续发，但每版仍需审批。`MARKET_OFFICIAL_PUBLISHERS` 指定公司发布账号；旧 `MARKET_OFFICIAL_PACKAGES` 与发布账号同时命中的显示规则继续兼容。其余作者使用 `users.json` 中发布者的姓名，没有姓名时使用 slug；无论包内自行声明什么，都不带官方标识。按 SemVer 降序列出仍存在的全部 approved 版本及 `engines.dsh`，不写 registry，依靠 `@crysound:registry` 映射。注册表无法核对时返回错误，不能伪装成空索引。dsh 会缓存索引十分钟，可在兆华市场刷新。第一期不提供私有包 README 的公共 CDN 镜像；详细介绍可能不可用。

插件页三个标签为“兆华市场 / CRYSOUND market → 第三方 / Third-party → 已安装”，公司市场默认打开。共用构建期脚本 `crysound/scripts/patch-market-ui.mjs --runtime <node_modules>` 一次检查五个固定版本浏览器模块，再应用补丁；版本变化时明确失败。侧栏依次显示新对话、市场、自动化任务，再显示已安装插件的页面，没有市场灰字。移除 `entry-customization` 的侧栏菜单注册后，空“更多”自然消失；市场右上角“做一个插件 / Create plugin”复用同一 `agentPreset: cordis`、侧栏提示和 `whenDraftExists: append` 动作。第三方正文和已安装列表保持原生实现。公司卡片分官方大卡片与全部插件列表，使用原生搜索、分类筛选、安装确认与分页；索引默认顺序为官方在前，其余按最近批准版本的发布时间降序。已安装按钮显示“使用”，已启用且版本与获批引导一致的官方包打开引导对话，其他包保留原生设置。网页镜像和下个桌面包发布这些界面变化；桌面准备阶段在生成校验记录、签名和冒烟验证之前应用补丁。首页快捷入口使用同一份包内引导。

`MARKET_OFFICIAL_MAINTAINERS` 是 JSON 对象，可按包覆盖 `officialPlugins` 的维护人列表，例如 `{"@crysound/design":["maintainer-slug"]}`；这同时授予该官方包的续发权限，请管理员核对后配置。姓名从 `users.json` 读取，无指定维护人时尝试包所有者姓名，缺姓名时不显示代号。`@crysound/data` 使用“兆华数据”及 `data` 分类，不增加标签页；维护信息由原生标签传递，显示为“维护：姓名 / Maintained by name”。

分类取包内 `labels` 或 `keywords`，可使用设计、视频、文档与报告、数据、研发、销售与市场、其他，或相应 id：`design`、`video`、`documents`、`data`、`development`、`sales`、`other`；没有匹配时为其他。可选 `dsh.market.preview` 是包作者将包内样例图片编码得到的内联 PNG、JPEG 或 WebP data URL，解码后不超过 32 KiB，映射到原生索引 `icon` 字段；没有有效图片时不显示样例图，不向私有注册表或任意 URL 发图片请求。

上传前先原子保存 publishing；连接中断、5xx 或后续保存失败时可能已经上传成功，不自动重试或放开所有权。由管理员停止网关，备份并核对 Verdaccio 对应版本与 `market.json`：确认存在且内容正确才把 publishing 改成 pending；确认未写入才撤销该版本预留（无其他版本时可移除包记录）；不能确认则保持 publishing。修改后重启网关再审批，勿删除已发布 tarball。损坏状态不会重置为空；恢复成对备份。此阶段恢复仅由运维完成。

## 首页快捷入口与引导

`officialPlugins.<name>.home: true` 启用首页快捷入口，随包配置仅选择兆华设计和兆华动画。官方名单另含兆华作品、兆华设计系统、兆华幻灯片、兆华看板；没有获批版本的包不在市场显示。此名单不增加预装插件。仅无草稿、无附件的空白新对话显示入口，按官方清单排序，最多四个，另有“去市场看看”。首页输入框使用本地化例句。选择能力打开空白对话但不发送，加入可取消的标签，显示一句话说明和三个示例。示例走原生输入框提交，取消标签保留草稿和附件，已有草稿不会被替换。

维护人在 `package.json` 的可选字段 `dsh.market.guide` 中维护 `zh` 和 `en`。每种语言包含 `summary`（1–200 字符）、`prompt`（1–500 字符），以及恰好三个 `examples`（每个 1–300 字符），仅空白内容无效。prompt 指示模型使用包的能力，与用户文字和附件一起进入有日志记录的会话提示。内容仅为纯文本，示例见[发布技能](../../config/skills/publish-zhaohua-market/SKILL.md)。包不能自行开启首页入口。

`GET /_zp/market/guides.json` 接受已开通用户的浏览器登录或现有市场 Bearer 身份，返回每个官方包最新获批稳定版本的引导，没有稳定版本时取最新获批预发布版本。待审批、被拒绝及非官方版本均排除。客户端要求组合包已启用、处于活动状态且版本完全一致，首页入口在未安装、未启用或版本不符时打开对应官方包的原生市场详情与安装入口；“去市场看看”打开兆华市场列表，并清除此前的筛选。市场“使用”缺引导或版本不符时仍进入原生设置。桌面只用当前登录代理这一固定路径，不向网页暴露凭据或转发上游头。读取失败提供重试并保留市场入口，不编造包内引导。

部署需重建网关和用户镜像，下个桌面包在生成完整性记录前应用共用补丁。维护人需发布引导字段、按原流程批准并对齐已安装版本，才能验收两个首页入口。[组件预览证据](evidence/issue-61-c/evidence.md) 使用测试包与假会话，不证明完整原生输入框、真实模型请求、线上包内容或 Electron 导航。真实产品仍需验收两个入口、已有草稿、带附件取消、示例只提交一次、语言与主题切换及窄屏。

引导补丁 v2 同时声明 `remote` 与 `remote.pluginManager`；子命名空间不能替代远端事件服务的注入。客户端按原生 `{ ok, value }` 结果读取清单，通过 `get` 解析会话的 conversation 服务。会话补丁也让空白首页渲染输入框下的扩展位。再次执行运行时补丁会在生成完整性记录前升级 v1。在独立且已登录、显示空白原生会话的浏览器标签页运行 `CDP_TAB=<标签页> node crysound/web/market/verify-guide-boot.mjs <输出目录>`：它只替换浏览器响应，复现漏声明依赖的启动失败，再带修复完整刷新，要求首页有官方入口且控制台没有错误。它不改服务器或已安装插件；[启动证据](evidence/issue-61-boot/evidence.md) 单独保留包内引导的待验收项。

[设计 1.0.0 差异证据](evidence/issue-61-design-v1/evidence.md) 取代设计 0.2.1 的验收目标，覆盖原生网页启动、双语首页与市场引导、使用 `/crysound-design` 的真实示例发送，以及隔离环境自动安装依赖。此前动效与附件证据继续有效。伙伴助理在下次正常桌面构建时验收 Electron 成品，不阻塞此次网页修复；部署后验收另行完成。

## 预装与更新

`plugins.json` 的 `retire` 是带固定迁移编号的一次性依赖移出清单。网页和桌面更新时通过原生 `dsh plugin remove` 移出演示文稿、视频剪辑和 oil-ui，仅修改 profile 的依赖及启用记录；不删除工作目录、作品或插件数据。失败不写完成标记，下次更新重试；成功后本人仍可从第三方市场重装。镜像继续保留 `/opt/slidestudio-runtime`、字体与 ffmpeg，`OM_CHROME` 保持不变。

启动准备将 `officialPlugins` 的包名写入 profile 的 `dsh.company.officialPackages`；共用构建补丁让原生插件页及卸载接口拒绝移出这些包，停用仍可用。此字段只供应用管理行为使用，不限制本人终端或工作区文件访问。发布批准后，管理员将 `plugins` 清单的 `spec/want` 同步为确切获批版本，再按现有空闲更新流程分发；已有同版本跳过，已有停用选择保留。公司市场应使用 `@crysound/design@<获批版本>` 这样的注册表包规格，保留网关返回的完整性信息，避免 #55 的直接远程 tarball；飞书继续使用已校验的本地归档。

官方名单本身不触发安装。设计验收目标为已批准的 `@crysound/design@1.0.0`，使用 `/crysound-design`，安装时会自动带上依赖 `@crysound/artifacts@^1.0.0`。设计 0.2.1 从未发布到公司市场，已被新版替代，不再作为上线或验收目标。本次动效保持已批准的 0.1.3，后续动画替换另单处理。预装版本以获批部署配置为准。两者无需为“留开关”放入虚假或不可安装的规格。此交付不代替真实工作区更新、作品保留、动效渲染或桌面安装包验收。

## 本地验证

所有测试使用临时目录、假身份和隔离配置，不读取真实 `.env` 或凭据，不发送真实飞书消息。Node 至少 24.9，配置与索引验证测试需要仓库已安装的依赖：

```sh
node --test crysound/web/gateway/tests/*.test.mjs
node crysound/web/tests/compose-config.mjs
```

真实注册表冒烟需要在独立临时目录安装 `verdaccio@6.1.6`、`pnpm@11`，安装时使用临时 HOME、空 user/global npm 配置和独立 cache，避免读取本机凭据；将该目录传给 `MARKET_TEST_TOOLS`：

```sh
MARKET_TEST_TOOLS=<隔离依赖目录> node crysound/web/tests/registry-smoke.mjs
```

冒烟自动在 loopback 随机端口启动真实 Verdaccio，用 npm 连续发布两个版本，经生产网关处理器审批，再用 pnpm 11 从 profile `.npmrc` 查询、下载和安装；退出时等待进程结束并清理临时数据。

真实环境还需验证：镜像构建和现有用户重建、新用户自助开通、桌面登录/退出/过期重登、Jason 收到卡片并完成审批、品牌层下“兆华市场”标签及点击安装、公司网络与代理下的 scope 和 tarball 鉴权、容器内网 DNS 与磁盘权限。不要在验收中输出凭据。
