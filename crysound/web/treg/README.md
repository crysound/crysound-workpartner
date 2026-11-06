# 兆华数据：网关与市场

需求 #73 的网关与界面代码已提供，默认关闭。归属实测、实际插件安装、目标平台桌面构建与上线验收仍须由伙伴助理完成；截图只用于界面送审。插件由独立的 `@crysound/data` 提供，本仓库不复制插件。

## 身份、目录与调用

`/_zp/treg/` 只接受现有已开通用户的 zpd Bearer 通行证（容器的 `.zp-market-token` 或桌面通行证），不接受网页 Cookie。市场的 `GET /_zp/market/data.json` 是只读展示接口，可使用通行证或网关验证的网页身份。

网关启动时取一次公共 `https://treg.to/catalog/platforms`，15 秒超时、2 MiB 上限、不跟随重定向、不附带凭据。七个中文分类、例子和草稿在 `gateway/treg-categories.mjs`，只展示配置中已知分类；AI generation 和未知分类均排除。起步价是该类 `price_from.usd` 的最小值，未知为 null，不解释成免费。计价单位可能是调用、结果或字符，界面明确提示实际费用以所选接口为准。

开放的 REST 路径：

- `GET /_zp/treg/catalog/platforms`：已开放平台。
- `GET /_zp/treg/catalog/search?q=...&limit=8`：搜索后逐项核对可调用目录，最多 25 条。
- `GET /_zp/treg/catalog/endpoints/<id>`：目录详情。
- `GET` 或 `POST /_zp/treg/call/<id>`：方法必须与目录一致，POST 仅 JSON 对象或数组。
- `GET /_zp/treg/usage`：本人北京时间今日、本月已用与限额。

每个调用必须在公共目录存在、属于开放平台、`kind` 为 data 或 routed、支持 GET/POST 且可由平台付费执行。路由的全部子接口同样逐项验证；自定义工具、hub、管理功能、AI 生成和未知端点不开放。目录详情仅在当前进程缓存，不缓存用户查询结果。

`POST /_zp/treg/mcp/` 提供无会话 MCP：initialize、ping、initialized 通知、tools/list、tools/call；工具仅 catalog_search、catalog_get、call。call 支持 endpoint_id、params 或 query/body、method 和 idempotency_key；不接受自定义请求头、凭据、上传或金额参数。MCP 请求不是原样透传上游：2026-11-07 核对上游源码，MCP call 会转交 X-Treg-Meta，但没有转交 transport 的 X-Treg-Route-Max-Cost。网关将 MCP 工具转换为同一 REST 调用，确保金额上限、归属、白名单与脱敏都经过同一边界。MCP 返回结构化结果和文本，业务失败标记 isError。其他协议方法、批量请求、资源与管理工具被拒绝。

组织令牌只由网关读取。实际调用仅发送网关新建的 Authorization、X-Treg-Org、X-Treg-Meta: user=<已验证本人 slug>、X-Treg-Route-Max-Cost 和必要 JSON 头；不转交客户端的 Cookie、组织、金额或归属头。调用者幂等标识加本人命名空间后散列，避免另一人取得组织级幂等缓存。持有另一位已开通人的有效通行证仍会代表那位通行证本人；此功能不能判断通行证是否被盗，所以不得分享个人令牌。

## 北京时间额度账本

按分诊答复采用北京时间日/月界线，不用 UTC 每日汇总冒充本地整月，也不做 usage/by-tag 小时轮询或月初解封。

账本存于 `/state/treg/YYYY-MM.json`，目录 700、文件 600。每笔包含时间、人、调用路径、预留上限和实际费用；不保存查询参数与结果。单个网关进程独占状态目录（compose 已为单实例），不得让多个进程共享同一账本写入。

在付费请求前，同步核对本人本月、本日已用，先写预留并 fsync，再发送请求。预留上限取单次额度、今日剩余额度和本月剩余额度的最小值，避免并发越过限额；上游收到的金额上限与此预留完全相同。本月或本日累计达到上限时给出中文提示。每人默认日 1、月 10、单次 1 美元，可覆盖为零。

首次调用前为该人设置 TR-EG 原生 user 标签日预算，失败则不发送付费调用。上游原生日预算按 UTC 日、本地账本按北京日，两者取严；本地月额度独立执行，不设置上游月预算、不自动改 blocked 状态。日预算在同一进程内按人和金额缓存，改配置后重建网关。上线前需核对上游既有同名标签预算是否还保留其他限制。

收到可信的 X-Treg-Cost-Micro 后按整数微美元结算。超时、断连、缺费用或不合法费用都保留预留金额；不自动重试、不追查、不逐笔对账。重启后的未完成预留继续计费。跨月完成的响应更新原月份账本；北京每月 1 日自然换文件。账本不可读或损坏时拒绝服务，不能以空账本继续调用。账本必须与网关状态一起备份，不要通过删除文件重置额度。

`GET /_zp/treg/usage` 示例：

```json
{"timezone":"Asia/Shanghai","date":"2026-11-07","month":"2026-11","daily":{"usedUsd":0.002,"limitUsd":1},"monthly":{"usedUsd":0.025,"limitUsd":10}}
```

公司余额或平台日额度不足时，REST 和 MCP 只给中文提示，不向同事返回余额、充值链接或原始错误。复用市场管理员飞书渠道发送一条中文额度提醒；以北京日为单位持久去重，重启不重发。通知尝试前记去重标志，同一天最多尝试一次；投递失败只记服务器日志，不声称通知已成功验收。本地测试不会发送真实通知。

## 市场与原生交互

`config/patch-data-market.mjs` 对已发布的插件管理器客户端注入原生 plugins.tab；补丁同时供网页版镜像与桌面打包使用，重复运行不改变，入口不唯一时停止构建。应先合入市场基础 #61 / PR #64；数据补丁与其可任意顺序运行，分类卡片接在相同标签结构中。

每类一张卡片，显示中文说明、主要平台、起步价和按钮。插件未装时从已批准公司索引取确切版本，进入原生安装流程；已装但停用时进入插件页；启用后调用原生 uiWorkspace.startSession，填入示例草稿并保留已有草稿，不自动发送、不付费调用。公司索引尚无兆华数据时禁用安装。桌面协议只代理这两个固定目录 GET 到公网网关，由主进程附本人通行证，渲染层得不到令牌。

## 配置、部署与回退

`.env` 新增项：

```dotenv
TREG_ENABLED=0
TREG_ORG_ID=
TREG_ORG_SLUG=
TREG_ATTRIBUTION_VERIFIED=0
TREG_DAILY_USD=1
TREG_MONTHLY_USD=10
TREG_CALL_MAX_USD=1
```

管理员按已申请流程把组织令牌放在 `PARTNER_SECURE/treg-token`（网关 `/secure/treg-token`）。不得写进 .env、仓库、镜像、容器或桌面客户端。缺文件或空令牌自动关闭。组织编号和 slug 也由管理员核实；只有 zptest 经网关 REST 和网关 MCP 调用后都在上游显示 user=zptest，才把 TREG_ATTRIBUTION_VERIFIED 设为 1；为 0 时可看目录，付费调用明确拒绝。若标签实测失败，保持关闭，由同一需求分支改为已核准的身份方案，不用猜测开放。

可选 `PARTNER_SECURE/treg-limits.json`：

```json
{"zptest":{"dailyUsd":0.001,"monthlyUsd":10,"callMaxUsd":0.001}}
```

只允许 dailyUsd、monthlyUsd、callMaxUsd，未填字段沿用全局，金额为非负数且精确到微美元；配置错误停止启动。改额度或覆盖文件后重建网关。

由伙伴助理在界面审查和凭据核实后执行：

```sh
# 按 .env 指定源配置并部署（须先核对 token、org 和状态备份）
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml build gateway
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml up -d --force-recreate gateway
# 卡片补丁在用户运行时内，需另构建 partner-image；空闲时换镜像。
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml --profile build build partner-image
```

市场数据卡片依赖 plugin-data 的发布，安装包随下一次正常桌面构建携带补丁与固定目录代理。不能仅重建网关后声称所有界面已上线。

回退首选 TREG_ENABLED=0 后重建网关；移走令牌并重建也关闭功能。保留账本及状态备份，不删除同事数据。若需只停止付费验证，可先设 TREG_ATTRIBUTION_VERIFIED=0。全员开放前的付款卡修复由伙伴助理/小满跟进，不是本 PR 的开发验收。

## 验证与尚待验收

Node 24 轻量检查：

```sh
node --test crysound/web/gateway/tests/treg.test.mjs crysound/web/gateway/tests/treg-catalog.test.mjs crysound/web/gateway/tests/notifications.test.mjs
node crysound/web/tests/compose-config.mjs
```

测试使用真实 HTTP 与临时文件，注入假上游和假通知；覆盖签名身份、路径与工具白名单、AI/管理/路由子接口拦截、并发预留、重启、跨北京日/月、实际与未知费用、个人用量、原生预算失败及公司报错脱敏。截图与预览说明见 `evidence/README.md`；browser-preview.mjs 可在 Skill 指定的持久浏览器自有标签页重复观察真实发布运行时的卡片和交互参数，不执行安装/新建会话。

尚待伙伴助理核实：真实公司令牌与组织归属；zptest 便宜接口成功与上游 user 标签；原生日预算执行；真实管理员通知；实际插件安装/启用及新对话草稿；目标平台 Electron 与桌面打包；#61 合入后的最终整页。未进行付费调用、上线部署、全员开放或余额对账。若实测 by-tag 日合计与账本偏差很大，记入已知限制，不伪称精确一致。
