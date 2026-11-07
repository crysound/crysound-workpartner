# 服务端搜索能力核对

固定发布运行时 `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1` / `@earendil-works/pi-ai@1.5.0` 暂不支持完整的 Anthropic 服务端搜索。公司现有搜索退路保留；本 PR 未启用服务端搜索，也不宣称完成 #137 的 Claude 原生搜索要求。

## 隔离复现

在已有网页镜像中只读挂载本检出，关闭外网，限一核、512 MiB，执行：

```sh
DSH_RELEASE_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
  node --experimental-import-meta-resolve --experimental-vm-modules \
  crysound/tests/anthropic-search-capability.mjs
```

脚本核对两个包的版本，将真实发布适配器加载到独立模块环境，仅附加导出其已有配置解析器。适配器、导入依赖、网络请求编码、流式解析和重放代码均来自真实发布包。回环服务返回包含服务端搜索调用、搜索结果、正文和引用增量的固定 SSE；无需密钥，不访问公司模型网关，不改 profile 或发布包。

实测发出两次回环请求：正文流式输出和继续会话成功；原生工具的 `type` 被移除并编码为客户端工具；`server_tool_use`、`web_search_tool_result`、引用来源全部丢失；输出 JSON 序列化后和下一轮请求均没有来源 URL 或服务端工具块。界面上游收到的只是正文，无法据此显示结构化来源。本项没有启动浏览器或实际写入会话数据库，不能当作界面和数据库验收通过。

阻塞分为三层：[请求转换](../../../../packages/llm/llm-pi-ai/src/context.ts)及发布依赖只编码普通客户端工具；发布依赖的 Anthropic 流式解析只处理正文、思考和普通 `tool_use`；[流式输出](../../../../packages/llm/llm-pi-ai/src/stream.ts)与[重放](../../../../packages/llm/llm-pi-ai/src/replay.ts)没有服务端搜索块和引用来源的保留路径。因此仅注入声明或仅把搜索结果拼成文字不够，必须补齐请求、流式、持久化重放及界面来源后才能启用。需要运行时维护方承接；若用公司补丁，按现有侧栏补丁方式固定版本、唯一命中、重复执行不变化，仍不直接改 `packages/` 源码。本 PR 没有强行添加不完整补丁。

## 公司网关实测

本轮未取得正式长期测试账号容器或其现有网关环境，本机隔离容器没有模型网关凭据。已按开发请求入口请伙伴助理补齐入口或代跑；网关是否透传仍为未知，不能由本机普通正文成功推出网关支持服务端工具。

[只读探针](../../../scripts/probe-anthropic-search.mjs)需由伙伴助理在已授权的测试账号容器执行。`--base-env` 和 `--key-env` 只接收现有环境变量名；`--model` 必须取实际 Anthropic 提供方的 Claude 路由；不要把 OpenAI 提供方的地址或模型名直接套过来。默认调用该 Messages 基地址下的 `/messages`，发送一次流式请求，搜索最多一次。加 `--json` 可单独核对非流式，两次分别记录。不要把真实密钥放进命令参数或日志，也不为测试新建或轮换密钥。

```sh
node crysound/scripts/probe-anthropic-search.mjs \
  --base-env EXISTING_ANTHROPIC_BASE_VARIABLE \
  --key-env EXISTING_GATEWAY_KEY_VARIABLE \
  --model ACTUAL_TEST_ACCOUNT_CLAUDE_ROUTE
```

探针只输出 HTTP 状态、已知内容块类型计数、去重来源数量及是否完整结束，不输出密钥、请求头、正文或原始错误。只有完整结束、服务端调用和结果均出现、有引用来源且无搜索工具错误时才报告 `gatewayVerified: true`；普通 200、正文成功或工具未实际调用均不算通过。一次请求最多等待 60 秒、读取 4 MiB；失败不自动重试、不改线上配置。此结果只验证该网关路由当次请求，不能证明 dsh 的持久化或界面已支持。

探针的回环行为测试使用 Node 24：`node --test crysound/tests/anthropic-search-probe.test.mjs`。6 项通过，覆盖流式分片、非流式、网关忽略工具、拒绝请求、流截断、工具报错，并核对密钥不出现在输出；这些是离线协议检查，未调用付费模型。

## 交付范围与启用位置

已有公司退路继续保留：Claude 优先 GPT、失败后 DeepSeek，单次默认 10 秒、工具总预算 25 秒、抓取输出最多 4 万字符、证据足够就停止。非 Claude 路径保持已有首选规则。本次未改这些已自查的运行行为。

服务端搜索当前保持关闭：本 PR 没有可启用的配置开关；往 `partner.patch.yml` 增加 `web_search` 声明不能补齐上述支持。待运行时维护方补齐并完成真实网关核对后，另交可审查的固定版公司补丁及默认关闭的开关，再决定是否启用。现有退路可否先上线由伙伴助理决定；暂不关闭需求单，也不把退路当作原生搜索验收通过。

部署与回退仍见[公司配置说明](../../../web/README.md#联网搜索提速)：已有部分需重建网页镜像并同步配置，回退恢复旧镜像、两份配置及个人工具两个字段，不覆盖整个 profile。新诊断和探针不会在启动时执行，无需为它们重建或重启线上容器。三题真实性能、每答至少五个来源及原生搜索验收仍待完成。
