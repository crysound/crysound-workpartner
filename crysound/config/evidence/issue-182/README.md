# 网页抓取提速：实现、自查与上线验收

覆盖需求单及补充 1–5：普通页面继续直抓，失败后并发尝试 DeepSeek Fetch 和 Treg Crawl4AI，首份可读正文胜出并取消另一路；两路失败保留原错误。不再通过 Codex 打开网页。只改公司补丁、网关与配置，`search.mjs` 和上游 dsh 不变。

## 可核对的行为

| 场景 | 行为 | 本地证据 |
| --- | --- | --- |
| 普通成功页 | 不请求付费兜底；有界 Markdown ≤12000 字符直接返回 | 实际发布工具注册/执行，数字、来源与限制保留，摘要请求和凭据读取为零 |
| 长文摘要 | 最多 2 秒、只用剩余总预算；失败保留有界原文 | 实际工具执行、虚拟时钟、取消和晚到凭据不补发、真实 Session 重放 |
| JS 页面 | article/main 已有至少 80 字正文不渲染；等待 DOM 与可见正文，不等网络空闲 | 实际 Chromium 执行 JS、持续网络、私网/登录导航和退出 |
| 直抓失败/超时 | 默认最多 1.5 秒，随后两路各最多 8 秒并发 | 确定性时钟、双路同时进入屏障、任一路胜出、另一请求取消；实际发布工具也执行两路竞争 |
| 付费失败/薄正文 | 失败或不足 80 非空白字符不能胜出；另一条仍可救回 | 空 pages、无效结构、JSON/网络/额度错误、65 字正文矩阵；双失败保留原错误/HTTP 状态 |
| 总时限/取消 | 总工作预算 9.5 秒、外层工具 10 秒；摘要共享预算，临近截止保留正文 | 虚拟时钟证明直抓耗尽 1.5 秒后两路还有 8 秒；调用者取消同时中止两路 |
| Treg 费用/范围 | 只额外开放 `treg.web.extract`，网关固定 Crawl4AI、无瀑布、最多 0.005 美元，计入本人日/月额度 | 真实 HTTP 假上游核对身份/费用/路由头、预算拒绝、低单次上限、客户端断连取消上游、不重试未知结果 |
| DeepSeek 入口/用量 | 仅内部精确 fetch/search POST、签名身份/有效期/名单、独立停用开关、按日按人分工具计数 | 真实 HTTP 假上游、伪造/过期/网页 Cookie 拒绝、日界/跨人/重启、停用保留钥匙 |
| DeepSeek 费用 | 公司每北京自然月默认最多 10 美元、每成功请求 750 微美元；发前持久预留 | 并发封顶、重启/月界、明确失败退款、取消/崩溃等未知结果保留预留；损坏账本拒绝启动 |
| 分段计时 | 实际派发数、各段耗时、跳过原因、胜出/取消结果，不记正文或凭据 | `fallbackCalls.deepseek/treg` 按 request-start 计数，`stages.<提供方>.outcomes.winner` 指出胜出者 |

时限是预算策略，不是线上实测速率。1.5 秒直抓为需求单中 DeepSeek 7.9 秒的页面留出完整 8 秒窗口；原可在 1.5–2.6 秒直抓的页面可能增加付费请求，需在线上比较救回率、费用和速度后决定是否调整。两路取消不保证提供方免计费，不把快速失败计作提速。

## 部署与回退

1. 伙伴助理已回报共用钥匙准备好，并用只读鉴权接口核验通过；本轮未读取钥匙、未调用真实付费接口。部署时仍须核对挂载。`DEEPSEEK_TOOLS_KEY_FILE=/run/deepseek-tools/deepseek-tools.key`，Compose 将已有安全目录额外只读挂到网关 `/run/deepseek-tools`，从中读取同名文件，用户容器和镜像不持有。钥匙文件缺失时网关仍可启动但此功能不可用；只读目录来自网关本已使用的安全目录，不为缺失钥匙创建目录或轮换钥匙。
2. `DEEPSEEK_TOOLS_ENABLED=0` 关闭 DeepSeek 上游调用，不能作废与公司模型网关共用的钥匙。`DEEPSEEK_TOOLS_USER_RPM=20`；`DEEPSEEK_TOOLS_MONTHLY_USD=10` 只可调低。手工部署可用 `DEEPSEEK_TOOLS_API_KEY`，但不传入用户容器或提交仓库。
3. 持久 `/state/ds-tools.json` 由单网关进程独占。`months` 保存预留/成功月账，`users` 保存限流窗口，`days[北京日期][本人标识][fetch或search]` 保存实际调用数 `calls` 和上游成功数 `success`。不记 URL、正文或钥匙；成功但正文不可读仍可能计费，不能把成功数当作救回数。保留账本，不删账号或清额度；旧账本缺 `days` 时初始化新增计数，已有额度不重置。
4. 入口脚本配置内部 `CRYSOUND_DS_TOOLS_BASE`、`CRYSOUND_TREG_BASE` 和 `CRYSOUND_DS_TOOLS_TOKEN_FILE`。两路复用本人已有身份文件，不给容器付费钥匙；3091 不映射公网，DeepSeek 公网同路径拒绝。Treg 路由在网关强制优先 `crawl4ai`、瀑布 `0`、上限 `min(个人单次上限, 0.005)`，不接受调用者覆盖。
5. 同提交更新网关模块与 Compose、重建网关、重建网页镜像，并同步 `partner.patch.yml`、`profile-upgrades.mjs`。先长期测试账号，再按已有容器升级策略推广。只同步配置不能增加运行时代码；桌面安装包不增加本次抓取补丁。
6. 回退单路用 `fetchDeepSeek:false` 或 `fetchTreg:false`；两者都关恢复原直抓时限，再加 `fetchSummary:false` 停摘要。网关独立关闭 DeepSeek 用上述开关或月额度 0，保留钥匙和账本。完整回退恢复保留的旧镜像、网关和公司配置，不轮换钥匙、不清账本。配置刷新会移除草稿版 `fetchOpen`、`fetchOpenModel`、`fetchOpenTimeoutMs`。

## 本地验证

仅使用已有 Node 24.14.0、固定 0.2.2-rc.1 发布依赖、Playwright Core 1.58.2 和 Chromium 1208。每次将发布产物复制到独立临时目录再修补；不安装依赖、不跑整套测试、不建镜像、不访问线上容器、不调用真实付费接口。第一次选错旧临时产物目录，发布检查未通过；改为已有完整固定版依赖后运行下列检查。夹具时钟不代表真实速度。

```sh
node --test crysound/web/gateway/tests/ds-tools.test.mjs \
  crysound/web/gateway/tests/treg.test.mjs \
  crysound/web/web-tools/fetch-pipeline.test.mjs

DSH_WEB_TOOLS_RELEASE_ROOT='<已有完整固定版 node_modules>' \
PARTNER_TEST_PLAYWRIGHT='<已有 Playwright Core index.mjs>' \
PARTNER_TEST_CHROMIUM='<已有 Chromium 可执行文件>' \
node --experimental-vm-modules --test crysound/web/web-tools/web-tools.test.mjs

DSH_TOOL_TIMING_RELEASE_ROOT='<已有固定版计时发布模块 node_modules>' \
node --test crysound/web/web-tools/timing.test.mjs

DSH_CLI_ENTRY='<已有 dsh lib/bin.js>' \
node --expose-internals --experimental-vm-modules --test \
  --test-name-pattern='web limits|summary rollback' crysound/tests/company-config.test.mjs

node crysound/web/tests/compose-config.mjs
```

网关和流水线 33 项通过（含主分支 Exa 路由回归）；计时 6 项及合并后的 Exa 7 项通过，配置刷新 2 项沿用未受影响的既有通过结果。发布工具检查 31 项中 30 项通过、真实 Chromium 通过，百度公网探测 1 项未启用；当前提交的远端扫描状态记录在 PR。Compose 只展开假环境，不连接 Docker 服务，核对仅网关只读持钥、内部端口无映射。修补和配置重复执行字节一致，漂移拒绝；真实 Session 重放保留摘要请求体且无凭据。另核对改动脚本语法、差异空白和本次文档链接；未运行全仓 doc-sync。

## 上线验收（尚未完成，归伙伴助理）

1. 部署同提交网关、镜像与配置，核对真实只读挂载、持久账本、Treg 本人归属和额度。只在测试进程开启 `CRYSOUND_TOOL_TIMING_LOG`。
2. 从 #137/#172 原记录取得补充表中八个失败页面的原始 URL，不能用域名首页代替原文章：audioxpress、giant.pandct、HEAD PDF、公众号、中新网手机页、HEAD 官网、NVIDIA、LinkedIn。逐页保留原文片段、来源、阶段耗时、两路实际调用与胜出者；至少救回 7/8，不将空正文或登录提示算成功。
3. 复跑 OpenAI、Apple、Listen、HBK 原长尾页，单次 ≤10 秒且正文可用。普通可直抓页不能无条件调用付费兜底。未达救回或速度要求就返工，不调整统计口径。
4. 固定 #137 原三道调研题、模型、推理档位、预设、插件与新会话，改前改后每题各三次并交替跑，保存完整会话与计时 JSONL。真实 web_fetch 次数作分母，失败、超时、取消、未调用及缺日志单列。单次 90 分位 ≤6 秒、中位数 ≤3.5 秒、失败率不升高、每题至少五条去重来源。
5. `timing-report.mjs <日志> --fetch-summary` 核对 `fallbackCalls.deepseek/treg`、各路 `outcomes.winner`、取消/跳过及缺失段，与实际请求和网关日/人/工具计数核对。关闭计时后新进程无追加日志，业务正文/来源正常。
6. 测试身份核对 DeepSeek 公网不可达、未开通身份拒绝、两种工具限流、低额度封顶、缺文件与独立开关关闭后不发上游请求，Treg 仍可救回；Treg 额度用完时 DeepSeek 仍可救回。用独立测试账本低额度，不为验收耗尽真实上限或改真实用户数据。
