# 兆华数据：网关与插件

需求 #73 提供网关，以及原生市场卡片的“使用”入口，默认关闭。插件由独立仓库的 `@crysound/data` 提供，本仓库不复制技能。真实网关费用归属、插件安装、桌面构建与上线验收仍须由伙伴助理完成。

## 身份、目录与调用

`/_zp/treg/` 只接受现有已开通用户的 zpd Bearer 通行证（容器的 `.zp-market-token` 或桌面通行证），不接受网页 Cookie。不提供 `/_zp/market/data.json` 或独立数据标签、分类卡片和市场目录缓存。

受控调用按需读取公共 `https://treg.to/catalog/platforms` 校验平台白名单：15 秒超时、2 MiB 上限、不跟随重定向、不附凭据。成功结果在网关进程内缓存五分钟，并发读取共用一次请求；到期读取失败直接报错，不使用过期白名单，后续请求可重新读取。只允许已知数据分类，AI generation 和未知分类仍被拒绝；这一服务端限制不依赖市场页面或技能。

开放的 REST 路径：

- `GET /_zp/treg/catalog/platforms`：已开放平台。
- `GET /_zp/treg/catalog/search?q=...&limit=8`：搜索后逐项核对目录，最多 25 条；单项核对失败跳过该项，有结果但全部核对失败时报错，上游无匹配则返回空列表。
- `GET /_zp/treg/catalog/endpoints/<id>`：目录详情。
- `GET` 或 `POST /_zp/treg/call/<id>`：方法必须与目录一致，POST 仅 JSON 对象或数组。
- `GET /_zp/treg/usage`：本人 UTC 今日、本月已用与限额。

每个调用必须在公共目录存在、属于开放平台、`kind` 为 data 或 routed、支持 GET/POST 且可由平台付费执行。目录搜索、详情查询和付费调用使用同一路由核对：跳过返回 `provider_paused` 或 HTTP 404 的子接口，至少一个子接口须可用，且所有可核对的子接口均须通过白名单；其他核对错误（包括其他 5xx、超时和分类不符）仍拒绝该路由。直接查询或调用暂停、下架的接口仍报错；金额上限与本人归属规则继续生效。自定义工具、hub、管理功能、AI 生成和未知端点不开放。目录详情仅在当前进程缓存，不缓存用户查询结果。

`POST /_zp/treg/mcp/` 提供无会话 MCP：initialize、ping、initialized 通知、tools/list、tools/call；工具仅 catalog_search、catalog_get、call。call 支持 endpoint_id、params 或 query/body、method 和 idempotency_key；不接受自定义请求头、凭据、上传或金额参数。MCP 请求不是原样透传上游：2026-11-07 核对上游源码，MCP call 会转交 X-Treg-Meta，但没有转交 transport 的 X-Treg-Route-Max-Cost。网关将 MCP 工具转换为同一 REST 调用，确保金额上限、归属、白名单与脱敏都经过同一边界。MCP 返回结构化结果和文本，业务失败标记 isError。其他协议方法、批量请求、资源与管理工具被拒绝。

MCP 客户端的 `server/discover` 探测在身份、服务开关和请求格式校验通过后，返回 HTTP 200、JSON-RPC 错误 `-32601`（Method not found）及原请求 `id`，使客户端回退到现有 `initialize` / `tools/list` 握手。这不提供发现服务；其他未开放方法仍返回 403，未登录仍返回 401，服务关闭仍返回 503。

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

市场标签沿用 #61 / PR #64 的“兆华市场 / 第三方 / 已安装”。`@crysound/data` 通过原有发布审批进入同一市场索引，声明分类“数据”；官方身份及作者使用 #61 的受控发布者和包名单，不改变权限或审批。七类分组、说明、示例提问和小额价格表达均在独立插件内部。

`config/patch-data-use.mjs` 修补原生市场卡片；同版重复运行不改变，入口不唯一则停止构建；v2 不跳过旧 v1 补丁，遇到旧补丁时须从原始发布运行时重新构建。未安装仍使用原生安装流程；已安装的兆华数据卡片显示“使用”。点击时查询本人插件状态，仅数据技能行启用且运行阶段为 active 时调用 uiWorkspace.startSession 填入分类引导草稿、保留已有草稿，不发送、不付费；技能停用、加载中、运行失败或状态读取失败时打开原生设置；连接行已运行不能代替技能就绪。网页镜像和桌面打包使用同一补丁，不新增目录代理。该补丁不修改 #61 的市场标签模块。

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

管理员按已申请流程把组织令牌放在 `PARTNER_SECURE/treg-token`（网关 `/secure/treg-token`）。不得写进 .env、仓库、镜像、容器或桌面客户端。缺文件或空令牌自动关闭。组织编号和 slug 也由管理员核实。伙伴助理已通过直连实测确认上游归属，试点部署时可据此把 TREG_ATTRIBUTION_VERIFIED 设为 1，再以 zptest 验收经网关 REST/MCP 的归属；这不代表网关验收已经通过。为 0 时可看目录，付费调用明确拒绝。若网关归属验收失败，恢复为 0，由同一需求分支修复，不扩大开放。

可选 `PARTNER_SECURE/treg-limits.json`：

```json
{"zptest":{"dailyUsd":0.001,"monthlyUsd":5,"callMaxUsd":0.001}}
```

只允许 dailyUsd、monthlyUsd、callMaxUsd，未填字段沿用全局，金额为非负数且精确到微美元；配置错误停止启动。改额度或覆盖文件后重建网关。

由伙伴助理在 #61 合入和凭据核实后执行：

```sh
# 按 .env 指定源配置并部署（须先核对 token、org 和状态备份）
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml build gateway
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml up -d --force-recreate gateway
# 原生卡片使用按钮在用户运行时内，需构建 partner-image；空闲时换镜像。
docker compose --env-file crysound/web/.env -f crysound/web/compose.yml --profile build build partner-image
```

兆华数据卡片依赖独立插件发布、审批与 #61 官方插件配置；默认官方名单必须包含 @crysound/data（或已有 @crysound/*），不自动预装。安装包随下一次正常桌面构建携带使用按钮补丁；本轮不触发构建。

回退首选 TREG_ENABLED=0 后重建网关；移走令牌并重建也关闭功能。保留已有状态及备份（含先前测试账本，不删除文件），不删除同事数据。若需只停止付费验证，可先设 TREG_ATTRIBUTION_VERIFIED=0。伙伴助理已确认付款卡和自动充值恢复；本 PR 未再次操作充值或凭据。

## 验证与尚待验收

Node 24 轻量检查：

```sh
node --test crysound/web/gateway/tests/treg.test.mjs crysound/web/gateway/tests/treg-catalog.test.mjs crysound/web/gateway/tests/notifications.test.mjs
DATA_MARKET_CLIENT=<已发布原生市场client.js副本> node --test crysound/config/patch-data-use.test.mjs
node crysound/web/tests/compose-config.mjs
```

测试使用真实 HTTP 与临时文件，注入假上游和假通知；覆盖签名身份、路径与工具白名单、AI/管理/路由子接口拦截、原生日/月预算、重启、UTC 月初与北京 08:00 界线、实际与未知费用、仅本人用量、预算失败及公司报错脱敏。原生卡片补丁已用真实发布客户端检查幂等性、入口变化和硬链接隔离；浏览器预览使用 Skill 指定的持久浏览器自有标签页，不安装或发送对话。截图与限制见 `evidence/README.md`。

伙伴助理已实测确认：服务端令牌就位、REST/MCP 的 user 标签归属、原生日/月预算执行，以及自动充值恢复。以上是上游直连结论，不能替代本 PR 网关验收。尚待伙伴助理核实：zptest 经部署后网关 REST 与 MCP 调用的归属与实扣、网关中文限额提示、本人用量与账单、真实管理员通知、兆华市场官方数据卡片、实际插件安装/启用及七类引导草稿、目标平台 Electron 与桌面打包、#61 合入后的最终整页。开发本轮未进行付费调用、上线部署或全员开放。
