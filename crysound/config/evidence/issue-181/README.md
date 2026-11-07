# 搜索优先顺序与重复抓取（#181）

网页搜索改为 `deepseek/deepseek-flash` 首选（12 秒），`codex/gpt-6-luna` 备用（最多 4 秒），保留 `searchTimeoutMs: 18000` 和原来的回退条件、错误文案。12 秒依据是需求单记录的 Flash 复杂查询约 6–10 秒；16 秒两段预算给工具总时限留 2 秒收尾。这些不是本轮重新测得的网关性能。

`crysound/config/partner.patch.yml` 的搜索模型同步为 Flash，已有配置通过原启动升级刷新，第二次执行字节不变。桌面版只获得公司配置的搜索模型刷新；12/4 秒回退与工具说明属于网页镜像补丁。没有改 `fetchSummary` 配置、模型网关或上游源码。

搜索与抓取工具说明要求：搜索正文或来源摘要已足够回答时，直接引用现有来源；不为确认同一来源再抓取。需要原文、细节、表格、补证据或满足指定来源数量时仍可抓取。此项是给模型的引导，真实调用次数须上线核对。

## 本轮自查

在固定 npm 发布产物 `0.2.2-rc.1` 的临时副本中执行，宿主服务和网络响应为夹具；不安装依赖、不构建镜像、不调用真实模型。

| 检查 | 结果与边界 |
| --- | --- |
| 修复前复现 | 两个新断言失败：实际先调 Luna；模拟 10 秒响应时，7 秒预算导致回退并发起第二次请求 |
| `web-tools.test.mjs` | 26 项中 24 通过、2 跳过、0 失败；跳过百度公网请求和 Chromium 渲染，本单未修改这两项实现 |
| `timing.test.mjs` | 6 项通过，0 失败；真实发布循环的事件与计时关联保持一致 |
| 公司配置定向测试 | `startup refreshes missing and literal search settings` 通过；新配置、旧 Luna 配置均刷新到 Flash，个人选项保留，重复升级字节一致 |
| 语法与差异检查 | 修改的 `.mjs` 经 `node --check`，`git diff --check` 通过 |

网页工具检查覆盖 HTTP、网络、无正文与超时回退、请求日志顺序、本人取消、凭据/日志失败不回退、双失败结构化报错、12/4 秒预算、模拟 10 秒 Flash 成功且只请求一次。零来源但有正文的返回继续保留正文，不回退；渲染后的正文与答案元数据均保留，原有 800 字符上限和来源映射不变。旧公司工具说明能升级，补丁重复执行无变化，发布产物漂移会拒绝。

复跑命令（Node 24，路径变量指向已有发布依赖；不执行安装）：

```sh
DSH_WEB_TOOLS_RELEASE_ROOT="$RELEASE_ROOT" node --experimental-vm-modules --test crysound/web/web-tools/web-tools.test.mjs
DSH_TOOL_TIMING_RELEASE_ROOT="$TIMING_RELEASE_ROOT" node --test crysound/web/web-tools/timing.test.mjs
DSH_CLI_ENTRY="$CLI_ENTRY" node --experimental-vm-modules --test --test-name-pattern='startup refreshes missing and literal search settings' crysound/tests/company-config.test.mjs
```

## 伙伴助理部署与线上验收（未执行）

保留旧镜像，重建并更换网页镜像，同步同一提交的 `crysound/config/partner.patch.yml`；无需升级模型网关。先在长期测试账号验证，再按既有发布约定推进。

- 杭州天气跑 3 次：中位数不超过 12 秒；至少 2 次没有 `web_fetch`。核对请求日志确实首选 Flash，正文足够时直接回答。
- 按 #137 的同三道调研题，每题 3 次，保持模型、推理档位、预设和插件一致，使用新会话。中位数分别不慢于 #172 的 S1 185 秒、S2 114 秒、S3 160 秒；每份答案来源链接不少于 5 条，保留完整会话记录。
- 需要原文、细节或表格的提问仍能抓网页；有正文但没有来源不能冒充满足来源数量。
- 真实模型答案质量、天气耗时、重复抓取次数及调研题性能均尚未验收；本轮确定性时钟只证明超时行为，不证明上线提速。

回退：撤回本提交并重建旧行为镜像，恢复旧公司搜索模型配置；用户会话和数据无需迁移。
