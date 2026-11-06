# 兆华数据：目录准备阶段

本阶段为需求 #73 准备只读目录，不代表数据服务已开放。付费 MCP/REST 转发、按人额度、本人用量、管理员额度通知、市场卡片与安装/新对话交互均未实现；不得给本阶段 PR 打 `deliver` 标签或按整单验收通过。

## 已提供的目录接口

`GET /_zp/market/data.json` 需要现有已开通用户的 zpd Bearer 令牌或网关验证的网页会话。目录只含公共展示信息，不能花钱。处理器必须放在现有 `market` 处理器前，否则市场会把这个新地址返回为 404。

启动时仅从 `https://treg.to/catalog/platforms` 读取一次，15 秒超时、2 MiB 上限，禁止跟随重定向，不附带任何用户或组织凭据。结果在当前网关进程中缓存；取目录失败后返回中文 503，重建网关后重取，不按每个用户请求重试。响应含 `fetchedAt` 和 `categories`；分类字段包括 `id`、`name`、`examples`、`prompt`、`package`、`pluginName`、`platforms`、`priceFromUsd` 和 `priceNote`。草稿提示只是数据，由后续界面填入输入框，不得自动发送。

中文文案在 `gateway/treg-categories.mjs`。按上游 `category` 分为七组；最后一组合并 Community、Research & public data、Market data、Developer。AI generation 和未知分类不进入结果。价格取该组平台 `price_from.usd` 的最小值；缺价格返回 `null`，不能显示为免费。不同接口可能按调用、结果、字符等计价，起步价不表示一次调用的总费用；界面须展示 `priceNote`，具体单位和报价仍须在选择接口时核对。所有分类引用同一个 `@crysound/data` 插件。

## 部署准备与回退

`.env` 增加 `TREG_ENABLED=0`（默认关闭）。服务器管理员按已批准流程将组织令牌放在 `PARTNER_SECURE/treg-token`，网关内对应 `/secure/treg-token`；不在本阶段新建或轮换任何令牌。令牌不得进入 `.env`、仓库、镜像、桌面版或用户容器。本阶段只检查文件是否非空，不使用令牌发送请求。缺文件或空文件自动关闭目录，不影响网关启动。

只有后续整项完成并通过伙伴助理验收，才在部署配置设 `TREG_ENABLED=1`。本阶段无需重建用户镜像或桌面安装包。后续部署由伙伴助理执行：

```sh
docker compose -f crysound/web/compose.yml build gateway
docker compose -f crysound/web/compose.yml up -d --force-recreate gateway
```

回退首选 `TREG_ENABLED=0` 后重建网关；也可在经过批准后移走令牌文件并重建网关。本阶段不改用户数据。

## 后续实现的前置核对

- 市场 #61 / PR #64 仍在开发，需以其最终界面和原生新对话/草稿入口接入卡片，之后提供截图送审。
- 需求要求先实测再选费用归属办法。需由伙伴助理准备组织编号和服务端令牌，在 MCP 与 REST 都核实网关注入 `X-Treg-Meta: user=<slug>` 或 pinned agent 的账单归属，再确定方案。测试不能把组织令牌传给客户端。
- 2026-11-07 读取线上 `https://treg.to/openapi.json`，`TagBudgetIn` 已含 `monthly_cap_micro`。这与需求“没有月度预算”不同；先核实该字段的执行能力与月界线，再决定是否保留网关小时轮询及解封。
- 同一线上文档的 `GET /orgs/{org_id}/usage/by-tag` 只有 `key` 和 `days` 等参数，没有精确起止时间。公开源码以 UTC 天界线统计；不能用“当月日数”冒充北京时间当月账单。需核实按北京时间取数与解封的可行接口。
- MCP `/mcp/` 同时包含 `balance`、`my_tools`、hub 等工具，HTTP 路径白名单不足以屏蔽管理功能和公司余额。后续须对协议方法及工具名逐项放行，限制工具内的自带请求头、金额上限与 endpoint，并过滤 AI generation；须检查 MCP 包装后的业务报错，不能只判断 HTTP 状态。
- `/call/` 支持公司自定义工具和 hub，不能仅以路径前缀放行。后续须核对具体 endpoint 的目录归属，并保证 MCP 与 REST 同样拒绝 AI generation 和未知入口。

## 本阶段核对

使用 Node 24 运行 `node --test crysound/web/gateway/tests/treg-catalog.test.mjs`，覆盖七类顺序、价格、未知类过滤、真实 HTTP 鉴权、启动单次读取、并发读取、关闭开关和上游失败脱敏。另从真实公共目录运行映射，核对分类与价格。不调用付费接口，不声称已验收费归属、额度或市场界面。
