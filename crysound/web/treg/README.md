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
- `GET /_zp/treg/usage`：本人 UTC 今日、本月已用与限额。

每个调用必须在公共目录存在、属于开放平台、`kind` 为 data 或 routed、支持 GET/POST 且可由平台付费执行。路由的全部子接口同样逐项验证；自定义工具、hub、管理功能、AI 生成和未知端点不开放。目录详情仅在当前进程缓存，不缓存用户查询结果。

`POST /_zp/treg/mcp/` 提供无会话 MCP：initialize、ping、initialized 通知、tools/list、tools/call；工具仅 catalog_search、catalog_get、call。call 支持 endpoint_id、params 或 query/body、method 和 idempotency_key；不接受自定义请求头、凭据、上传或金额参数。MCP 请求不是原样透传上游：2026-11-07 核对上游源码，MCP call 会转交 X-Treg-Meta，但没有转交 transport 的 X-Treg-Route-Max-Cost。网关将 MCP 工具转换为同一 REST 调用，确保金额上限、归属、白名单与脱敏都经过同一边界。MCP 返回结构化结果和文本，业务失败标记 isError。其他协议方法、批量请求、资源与管理工具被拒绝。

组织令牌只由网关读取。实际调用仅发送网关新建的 X-Treg-Token、X-Treg-Org、X-Treg-Meta: user=<已验证本人 slug>、X-Treg-Route-Max-Cost 和必要 JSON 头；不转交客户端的 Cookie、组织、金额或归属头。调用者幂等标识加本人命名空间后散列，避免另一人取得组织级幂等缓存。持有另一位已开通人的有效通行证仍会代表那位通行证本人；此功能不能判断通行证是否被盗，所以不得分享个人令牌。

## 原生标签预算与用量

以 2026-11-07 伙伴助理的真实调用结论为准，替代先前按北京时间自建账本的方案：REST 使用 `X-Treg-Token`（不是 Bearer），归属用 HTTP 头 `X-Treg-Meta: user=<slug>`。MCP 工具经网关转成同一 REST 调用，因此保持相同归属和单次上限，不在工具参数中放组织凭据。

默认每人每天 1 美元、每月 5 美元、单次最多 1 美元。首次付费请求前，同步 `PUT /orgs/<org>/budgets/user` 默认预算的 daily_cap_micro 和 monthly_cap_micro，同一进程内普通用户共用该结果，不为每人创建预算；配置了个人例外才另 PUT `/budgets/user/<slug>`。只发送金额字段，保留管理员设置的 status 和 calls_per_day；失败则不发付费请求，后续请求可以重新同步。改配置后重建网关。该团队的默认预算已由伙伴助理设为日 1、月 5 美元，同值 PUT 是幂等确认。

日/月预算由 Treg 在调用前拦截，超额的调用不扣钱，不影响其他人。不使用网关定时封禁/解封，不再把本地预留金额当成实扣。日/月窗口统一按 UTC，即北京时间每天 08:00、每月 1 日 08:00 恢复。并发时上游可能略超预算（并发数乘单次预估），团队余额是最终硬上限；单次调用仍传网关配置的 X-Treg-Route-Max-Cost。

`GET /_zp/treg/usage` 查询上游 `/orgs/<org>/usage/by-tag?key=user&days=1` 及 `days=<UTC 当月第几天>`。只投影已验证本人的 charged_micro，不返回其他用户、团队总额或未归属金额。接口失败时明确报错，不回退到零用量。示例：

```json
{"timezone":"UTC","date":"2026-11-07","month":"2026-11","resetMessage":"北京时间每天 08:00、每月 1 日 08:00 重置额度","daily":{"usedUsd":0.002,"limitUsd":1},"monthly":{"usedUsd":0.025,"limitUsd":5}}
```

usage/by-tag 不支持历史起止日期，本功能仅返回本月，不提供历史月报。Treg 的已有个人预算覆盖优先于默认值；管理员须将例外金额同步到 treg-limits.json，否则用量页的配置额度与后台可能不一致。删除本地个人例外不会删除上游覆盖，调整回默认值需管理员显式处理。

单次响应有合法 X-Treg-Cost-Micro 时返回实际费用；缺费用时 MCP cost_usd 为 null、costEstimated 为 true，REST 标记 x-zp-cost-estimated，不猜测费用。断连、超时或未知结果提示查询本人用量，不自动重试。重启不会丢失上游账单或限额。

公司余额或平台日额度不足时，REST 和 MCP 只给中文提示，不向同事返回余额、充值链接或原始错误。复用市场管理员飞书渠道发送一条中文额度提醒；`/state/treg/notices.json` 以北京日持久去重，重启不重发。通知尝试前记去重标志，同一天最多尝试一次；投递失败只记服务器日志，不声称通知已成功验收。本地测试不会发送真实通知。单网关进程独占此状态目录。

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
TREG_MONTHLY_USD=5
TREG_CALL_MAX_USD=1
```

管理员按已申请流程把组织令牌放在 `PARTNER_SECURE/treg-token`（网关 `/secure/treg-token`）。不得写进 .env、仓库、镜像、容器或桌面客户端。缺文件或空令牌自动关闭。组织编号和 slug 也由管理员核实；只有 zptest 经网关 REST 和网关 MCP 调用后都在上游显示 user=zptest，才把 TREG_ATTRIBUTION_VERIFIED 设为 1；为 0 时可看目录，付费调用明确拒绝。若标签实测失败，保持关闭，由同一需求分支改为已核准的身份方案，不用猜测开放。

可选 `PARTNER_SECURE/treg-limits.json`：

```json
{"zptest":{"dailyUsd":0.001,"monthlyUsd":5,"callMaxUsd":0.001}}
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

回退首选 TREG_ENABLED=0 后重建网关；移走令牌并重建也关闭功能。保留已有状态及备份（含先前测试账本，不删除文件），不删除同事数据。若需只停止付费验证，可先设 TREG_ATTRIBUTION_VERIFIED=0。伙伴助理已确认付款卡和自动充值恢复；本 PR 未再次操作充值或凭据。

## 验证与尚待验收

Node 24 轻量检查：

```sh
node --test crysound/web/gateway/tests/treg.test.mjs crysound/web/gateway/tests/treg-catalog.test.mjs crysound/web/gateway/tests/notifications.test.mjs
node crysound/web/tests/compose-config.mjs
```

测试使用真实 HTTP 与临时文件，注入假上游和假通知；覆盖签名身份、路径与工具白名单、AI/管理/路由子接口拦截、原生日/月预算、重启、UTC 月初与北京 08:00 界线、实际与未知费用、仅本人用量、预算失败及公司报错脱敏。截图与预览说明见 `evidence/README.md`；browser-preview.mjs 可在 Skill 指定的持久浏览器自有标签页重复观察真实发布运行时的卡片和交互参数，不执行安装/新建会话。

伙伴助理已实测确认：服务端令牌就位、REST/MCP 的 user 标签归属、原生日/月预算执行，以及自动充值恢复。以上是上游直连结论，不能替代本 PR 网关验收。尚待伙伴助理核实：zptest 经部署后网关 REST 与 MCP 调用的归属与实扣、网关中文限额提示、本人用量与账单、真实管理员通知、实际插件安装/启用及新对话草稿、目标平台 Electron 与桌面打包、#61 合入后的最终整页。开发本轮未进行付费调用、上线部署或全员开放。
