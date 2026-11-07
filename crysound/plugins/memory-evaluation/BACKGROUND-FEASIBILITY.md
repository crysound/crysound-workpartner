# 后台学习技术验证

本单仅验证扩展能力，不实现后台学习，不增加学习模型请求，不改线上容器或用户数据。未来自动学习默认开启的产品决定仍适用。运行验证使用隔离的 dsh 0.2.2-rc.1 / Node 24.22.2、既有测试模型接入与合成会话；源码判断和现场事实分别列出。

| 项目 | 结论 | 依据、限制与替代做法 |
| --- | --- | --- |
| (a) 运行变空闲 | 可行，隔离运行已验证 | `agent/status` 发出 `running` / `idle`；[声明](../../../packages/core/agent/src/runtime-types.ts)说明 idle 表示没有正在调度或执行的驱动。测试插件实际记录了 running → idle。根插件监听应按作用域设置 global，仅处理本人容器的主会话，区分子会话；idle 只当线索，不能认为之后不会再有用户输入。 |
| (b) 读本人会话 | 可行，隔离运行已验证 | `ctx.sessionQuery.listSessions()` / `readSession(id)` 统一读取活跃与持久会话，不必直接读文件或把旧会话变为活跃。[服务](../../../packages/session-query/session-query/src/index.ts)返回分离的 header/events。本次 idle 后读到同一个合成会话的两条用户消息。身份隔离依赖每人容器与数据挂载，未验证跨正式账号；学习应只取本人亲述，保留用户原话证据，排除引用、工具结果与助手推测。 |
| (c) 主对话外辅助请求 | 可行，已有真实请求证据 | [session-title-llm](../../../packages/session/session-title-llm/src/index.ts)使用 `ctx.llm.prepareCall()`，记录精确辅助 system/messages/route 后调用 `call.stream(options)`，带独立 purpose、上限、超时与取消。合成会话实际有一条 title-llm-request，之后出现 provider 生成的 title，同路由为 magpie / codex/gpt-6.1-sol；不是仅凭函数存在判断。未来学习需自己的 purpose、精确请求日志与结果校验，不能将 memory 功能挂在 title provider 上，也不能绕过宿主直接调外部接口。 |
| (d) 定时运行 | 可行，进程内定时器已验证 | 测试插件在 `ctx.effect()` 中注册 100ms 定时器并在卸载时清理，实际触发；不把它当跨重启保证。已有 [schedule](../../../packages/schedule/schedule/README.md)持久化任务且宿主需运行，适合向会话投递指令；后台学习若不向主对话投递，应自己持久保存处理游标和到期时间，按时区计算每日一次，启动补查，避免并发重复。只有新对话才调用模型，失败不推进游标。 |
| (e) 网页容器夜间运行 | 架构允许；线上夜间实际状态未验证 | [onboard](../../web/gateway/onboard.mjs)创建每人容器并设 `unless-stopped`，[compose](../../web/compose.yml)也为常驻服务；这些源码不能证明当前线上容器夜间一直运行。环境负责人明确本机没有线上入口，未取得现场证据。需伙伴助理查线上实际部署和夜间状态记录；若会夜停，替代为下次启动补跑，不宣称准点夜间运行。 |

[capability-probe.mjs](capability-probe.mjs)是可复用的测试插件，未装入正式 memory 包，也不随预装启用。在只含合成对话的隔离 profile 中插入它，完成一轮会话后读取 `$DSH_HOME/memory-capability-probe.jsonl`；它只记录状态、消息数量和辅助请求数量，不记录会话内容或凭据。[实际输出](evidence/issue-99/capabilities.jsonl)含 llm 接口可用、timer fired、running、idle、userMessages=2 与 auxiliaryRequests=1。辅助标题成功另从同一次合成会话的真实持久日志核对。

后台学习后续实现还需验证用户原话、幂等游标、撤销/删除后的遗忘、防重复执行、预算与错误恢复；这里不以接口可用代替功能验收，也未修改记忆数据结构。
