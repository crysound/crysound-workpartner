# 网页抓取长尾：实现、自查与上线验收

本次覆盖原需求、两次补充及分诊交回的费用限制：普通页面继续直抓；失败或直抓截止后，先 DeepSeek Fetch，再在剩余预算内用 Codex 打开；都失败保留原错误。只改公司 web-tools、共享配置及网关，不改上游 dsh、公司模型网关或 #181 的 search.mjs。费用和接入已获准，不再等待决定；真实线上结果尚未验收。

## 行为与边界

| 场景 | 本次行为 | 直接核对的证据 |
| --- | --- | --- |
| 有问题的短正文 | 有界 Markdown ≤12000 字符直接返回，不读模型凭据 | 真实发布工具执行，请求/凭据读取数均为零，保留数字与限制 |
| 长正文摘要卡住 | 最多 2 秒且不超过整个调用剩余时间；失败返回有界原文 | 虚拟时钟、请求中止、晚到凭据不补发、原文逐字相同 |
| JS 正文已就绪但网络持续 | DOM 就绪后等可见正文，默认最多 2 秒渲染；article/main 已有 80 字不启动浏览器 | 真 Chromium 执行 JS，持续请求仍未结束时返回正文并关闭浏览器 |
| 直抓失败或超时 | 直抓最多 3 秒；DeepSeek 阶段最多 8 秒；其后 Codex 最多 6 秒 | 真实发布工具和独立流水线检查，顺序、来源、问题及单次派发 |
| DeepSeek 正文不足 80 个非空白字符或失败 | 继续 Codex；所有步骤合用 9.5 秒工作预算，外层工具为 10 秒 | 65 字、无效结构、解析/网络/额度错误矩阵，预算耗尽不再调用 Codex |
| DeepSeek 可读长文 | 原 Markdown 走现有按问题摘要；截止时保留正文 | 模型收到原问题，来源由代码附加；临近截止的摘要取消后仍有证据 |
| Codex 未真正打开目标页 | 原错误/HTTP 结果 | 必须有 completed、目标 URL 的完成 open_page 记录及 readable:true JSON 摘要；缺记录、拒绝、错 URL 等均失败 |
| 本人取消、安全拦截、私网或带身份的 URL | 不通过兜底绕过，取消后不再派发 | 原网络检查、取消信号与请求计数 |
| 付费工具入口 | 只在内部 3091 端口接收 fetch/search 精确 POST，公网拒绝；签名身份、有效期及开通名单必查 | 假上游 HTTP 请求，伪造/过期/未开通/网页 Cookie 拒绝；不转发用户 Cookie 或模型钥匙 |
| 费用/限流 | 默认每人每分钟 20 次，全公司每北京自然月最多 10 美元；成功请求每次 750 微美元 | 并发预留、重启、跨人/分钟/月、损坏账本与未知结果保留；真实 HTTP 断连使上游中止 |
| 计时 | 下载、提取、渲染、摘要、DeepSeek 与 Codex 段，以及跳过/结果 | 实际发布工具、真实浏览器、确定性阶段时间；报告按派发起点数兜底调用，未派发不计 |

这些时限是配置上限，夹具不证明真实线上速度。直抓 3 秒沿用原单典型页面 0.03–2.6 秒的观察，DeepSeek 8 秒和 Codex 6 秒来自两次补充；总工作预算按最新 10 秒目标留 0.5 秒处理余量。各段只可用剩余预算，不能把 3+8+6 秒串行用尽。直抓耗满后只剩约 6.5 秒，可能影响某些慢页救回，必须由真实验收判定是否够用；不能用快速失败冒充提速。

## 凭据、费用与部署

- 官方协议：[Fetch](https://api-docs.deepseek.com/api/fetch/) 返回 title/content；[Search](https://api-docs.deepseek.com/api/search/) 接受 query/count/ori_question/localization/need_content。Search 仅备好转发，不改变现有搜索。
- 网关钥匙：环境变量 `DS_TOOLS_API_KEY`，或 `DS_TOOLS_API_KEY_FILE` 指定文件（默认 `/secure/deepseek-tools.key`）。Compose 使用已有服务器安全目录中的 `deepseek-tools.key`，单独只读覆盖挂载到网关；不得传给用户容器、桌面端或写入镜像。文件必须先放好再重建网关，缺失时 Compose 拒绝创建空目录。助手提供的钥匙准备事项仍由其负责，本轮未读取或验证真实钥匙。
- 容器只读本人 `/data/.zp-market-token`。入口脚本设置 `CRYSOUND_DS_TOOLS_BASE=http://zhaohua-partner-gateway:3091/_zp/ds-tools/` 与 `CRYSOUND_DS_TOOLS_TOKEN_FILE`；内部端口不映射宿主机，公网同路径明确 404。单个用户停用后原令牌也不能继续调用。
- `DS_TOOLS_USER_RPM=20` 可调。`DS_TOOLS_MONTHLY_USD=10` 只可调低。每次发请求前，单网关进程同步、原子更新持久 `/state/ds-tools.json` 的已占额度；预留与成功合计最多 13333 次，即 9.99975 美元。明确上游非成功状态释放预留；断连、取消、崩溃等未知结果保留，成功但响应无效也占额度。旧月在途请求仍记原月。账本损坏会停止启动，不静默重置；不支持多个网关进程共享该账本。账本只保存身份、窗口和次数，不含钥匙、URL 或正文。
- 网关拒绝额外接口、查询参数、重定向和无效参数；请求最多 16 KiB，上游响应最多 2 MB。错误只返回本地固定文案，不透出上游头、正文或异常信息。达到费用上限后仍可按剩余时间走 Codex，否则返回原错误。
- 部署须同时更新网关模块与 Compose、重建网关，重建网页镜像，并同步同提交的 `partner.patch.yml`、`profile-upgrades.mjs`。先只升级长期测试账号，再按现有容器升级策略推广；桌面安装包本轮不增加抓取补丁。只同步配置无法增加新运行时代码。

## 本地证据

使用现有 Node 24.14.0 与固定版 0.2.2-rc.1 发布依赖，发布工具先复制到独立临时目录再修补；未安装依赖、未跑整套测试、未建镜像、未访问线上容器、未使用真实付费钥匙或模型。真实 Chromium 为现有 1208 版，Playwright Core 1.58.2 为已有驱动。

```sh
node --test crysound/web/gateway/tests/ds-tools.test.mjs \
  crysound/web/web-tools/fetch-pipeline.test.mjs

DSH_WEB_TOOLS_RELEASE_ROOT='<已有固定版 node_modules>' \
PARTNER_TEST_PLAYWRIGHT='<已有 Playwright Core index.mjs>' \
PARTNER_TEST_CHROMIUM='<现有 Chromium 可执行文件>' \
node --experimental-vm-modules --test crysound/web/web-tools/web-tools.test.mjs

DSH_TOOL_TIMING_RELEASE_ROOT='<已有固定版计时发布模块 node_modules>' \
node --test crysound/web/web-tools/timing.test.mjs

DSH_CLI_ENTRY='<已有 dsh lib/bin.js>' \
node --expose-internals --experimental-vm-modules --test \
  --test-name-pattern='web limits|summary rollback' crysound/tests/company-config.test.mjs

node crysound/web/tests/compose-config.mjs
```

新增网关与流水线检查 13 项通过，含真实 HTTP 假上游和断连；发布产物检查 34 项中 33 通过、真实百度公网探测 1 项未运行，真实 Chromium 与发布工具 DeepSeek 兜底项通过。原计时检查 6 项通过，配置刷新 2 项通过，覆盖新旧 profile、保留个人选项、三个开关回退和重复刷新字节一致。Compose 展开检查只读钥匙、默认额度和内部端口，不连接 Docker 服务。修补重复执行字节一致，漂移明确拒绝；真实 Session 重放保留摘要/打开的实际请求体且不含凭据。改动脚本语法、差异空白和文档本地链接另行检查。项目开发依赖未安装，未运行全仓 doc-sync。

## 上线验收（均未完成，归伙伴助理）

1. 核对已有真实钥匙已准备、网关只读挂载和持久账本目录可用，再部署同一提交的网关、镜像和配置。不得删除账号或清空费用账本。先给长期测试账号开启实际 dsh 进程的 `CRYSOUND_TOOL_TIMING_LOG`。
2. 固定 #137 三道调研题、模型、推理档位、预设、插件和新会话，改前改后每题各三次并交替跑，保留完整会话与计时 JSONL。真实 web_fetch 次数作分母，超时/错误/未调用/取消/缺日志单列。单次 90 分位 ≤6 秒、中位数 ≤3.5 秒、失败率不升高，每题至少 5 条去重来源；仅正文有 URL 不等于该页抓取成功。
3. 从 #137/#172 原会话定位补充表八个失败页面的原始 URL（PDF、官网跳转、NVIDIA、LinkedIn、audioxpress、giant.pandct、公众号、中新网手机页），不能用域名首页代替原文章。逐页记录直抓失败、DeepSeek/Codex 实际调用、证据片段、原来源和阶段耗时；至少救回 6/8。Codex 必须核对真实目标打开记录及可读结果，不能靠 URL 猜内容。
4. 复跑 OpenAI、Apple、Listen、HBK 原长尾页，单次 ≤10 秒且正文可用；核对普通可直抓页没有额外 DeepSeek/Codex 调用。未达救回或速度目标就返工，不能只调整口径。
5. `timing-report.mjs <日志> --fetch-summary` 核对 `fallbackCalls.deepseek/codex`、各段完整/缺失/结果及跳过数量；与实际请求及网关成功/预留账本核对。关闭计时再跑同题，确认新进程无追加日志，业务输出与来源正常。
6. 用测试身份核对公网接口不可用、未开通身份拒绝、两种接口限流、费用封顶后不再发付费请求，Codex 仍按剩余预算兜底；不为验收消耗真实上限或改真实用户数据，可在独立测试账本设低额度。

回退：`fetchDeepSeek:false` 只停付费兜底；`fetchOpen:false` 只停 Codex；两个都关后恢复原抓取时限，加 `fetchSummary:false` 也停摘要。配置同步并按既有策略重启，从新会话核对请求消失。网关月额度设 0 可直接阻止新增付费调用并保留账本。完整回退使用保留的旧镜像、网关代码和配置，不轮换钥匙，不清账本。
