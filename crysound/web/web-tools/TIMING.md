# 联网工具分段计时

用于定位工具调用 `block-end` 到搜索发出之间的空档，不改变模型或工具的调度顺序。仅网页镜像包含此诊断入口；不改上游源码、不新增会话事件或持久化格式。镜像构建时 `timing-patch.mjs` 校验三个固定版本发布模块的替换点，运行时仅开启诊断的进程通过 Node 24 同步加载钩子在内存中插桩。普通进程不注册加载钩子，加载的上游模块保持原字节，流循环不增加计时分支。

## 打开和关闭

伙伴助理只在保留现有数据和全部启动参数的测试容器上操作。在启动 dsh 的进程环境中额外传入 `CRYSOUND_TOOL_TIMING_LOG=/data/tool-timing.jsonl`，沿用镜像的 `NODE_OPTIONS`，再启动测试容器。此变量不自动下发给所有用户；只写部署 `.env`、在已经运行的容器里 `export`、或只给 `docker exec` 设置变量，都不会改变现有 dsh 进程。不要使用会删除测试账号数据的重建脚本。

日志路径必须为普通用户可写的绝对路径，父目录必须已存在；新日志权限为 600，已有文件必须归当前用户所有且只允许本人读写，不跟随符号链接。使用已有 `/data` 持久卷，不写全局目录。路径错误会在进程启动时明确报错，需修正环境后重启。写入期间磁盘失败仅停用本进程计时并打印不含路径的警告，不让工具调用失败；出现警告的轮次不能当作完整采样。

关闭时移除该变量或设为空字符串，再用同一镜像和原参数启动测试容器。无需改代码或重建镜像，已有日志保留。日志在每次模型尝试结束后统一追加，不逐阶段同步落盘；进程被强杀时未落盘的当前尝试会缺失。日志不自动轮转，短时采样后及时关闭。

## 输出和分析

每行是一个 JSON 对象，仅含版本、进程、会话、轮次、步骤、模型尝试、工具调用、阶段、时间和少量状态。不会写问题、参数、返回正文、请求体、网址、标头或凭据；原有上游搜索请求事件保持原样。

`processStartTime` 为进程启动的 Unix 毫秒，`monotonicMs` 为进程单调时钟毫秒，`time = processStartTime + monotonicMs` 便于和会话记录对照。计算差值必须使用同一进程、同一尝试和同一调用的 `monotonicMs`，不要跨重启相减。`pid`、`processStartTime`、`session`、`turn`、`step`、`attempt`、`callId` 共同关联一次调用。并行工具各自记录；搜索重试的 `searchAttempt` 从 1 递增。

| stage | 采样位置 |
| --- | --- |
| `block-end` | 流迭代器交出该工具调用的完整块，在 `live.push` 前；不是首个参数增量 |
| `finish` | 流迭代器交出 finish 块，若提供方未发则缺失 |
| `stream-end` | 流迭代结束，能区分 finish 已到但迭代器仍未结束 |
| `assistant-message-append-start` | 成功路径中开始同步追加 assistant message |
| `assistant-message-written` | 同步追加返回，尚未发布流结束帧；不代表磁盘 fsync 完成 |
| `tools-execute-start` | 进入本步骤的工具批次，所有调用共享这个时间点 |
| `tool-dispatch-start` | 单个工具通过调度和 prepare 后，进入 dispatch |
| `search-request-record` | 该调用每次搜索尝试追加 `web/deepseek-search-llm-request` 之前 |
| `search-request-dispatch` | 同一事件追加成功并通过取消检查后，调用 fetch 之前 |
| `tool-result-returned` | dispatch 返回工具结果，尚未经过按模型顺序的结果提交 |
| `tool-result-finalized` | 单工具结果后处理完成，准备提交结果；被拒绝/跳过的工具也可有此阶段 |

这里的“搜索发出”指应用调用 fetch，不是 TCP 首字节到达网络；它与原事件之间还包含请求事件写入和取消检查。失败的请求日志不会记录 dispatch。工具若在 prepare 阶段被拒绝或取消，就没有搜索和 dispatch 返回阶段；流中断、追加失败、重试会保留已到的阶段，不补造后续时间点。

离线分析：

```sh
node crysound/web/web-tools/timing-report.mjs /path/to/tool-timing.jsonl
```

输出每个调用的 `durationsMs`、搜索尝试及缺失阶段。`blockToFinish` 大说明时间在模型流尾部；`finishToStreamEnd` 大说明结束块之后流仍未关闭；`assistantAppend` 单独给出同步追加耗时；`appendToExecute` 包含结束帧发布和批次准备；`executeToToolDispatch` 含排队、审查和 prepare；`executeToFirstSearch` 还包括工具执行、凭据读取与请求事件写入。`firstSearchToResult` 包含搜索、可能的第二次尝试和返回映射。非搜索工具的搜索字段为空；阶段缺失输出 null，不能视为零耗时或验收通过。

下面是缩写的合成样例，同一调用的其他阶段略去，**不是线上实测结果**：

```jsonl
{"version":1,"pid":100,"processStartTime":1794042000000,"session":"sample","turn":1,"step":1,"attempt":"sample:1","callId":"search-1","name":"web_search","stage":"block-end","monotonicMs":100,"time":1794042000100}
{"version":1,"pid":100,"processStartTime":1794042000000,"session":"sample","turn":1,"step":1,"attempt":"sample:1","callId":"search-1","name":"web_search","stage":"finish","monotonicMs":3100,"time":1794042003100}
{"version":1,"pid":100,"processStartTime":1794042000000,"session":"sample","turn":1,"step":1,"attempt":"sample:1","callId":"search-1","name":"web_search","stage":"search-request-dispatch","monotonicMs":3220,"time":1794042003220,"searchAttempt":1}
```

## 抓取分段

`web_fetch` 在同一个 `CRYSOUND_TOOL_TIMING_LOG` 开关下增加以下阶段。公司补丁复制到发布产物时引用同一个计时模块，沿用工具调用的异步身份；默认关闭、不写日志。阶段及结果均为固定字符串，不包含地址、问题、正文、请求体或错误文本。

| 阶段前缀（均带 `fetch-`） | 起止位置 |
| --- | --- |
| `direct-start/end` | 公司直抓开始至返回或超时，包含下载、提取和可能的浏览器 |
| `download-start/end` | HTTP 请求/跳转开始至原提供方读完有界正文并解码，失败同样结束 |
| `extract-start/end` | 登录/空壳识别及 HTML 精简；摘要前的有界 Markdown 转换另记一段 |
| `render-start/end` | Chromium 加载、渲染到清理完毕 |
| `summary-request-start/end` | 摘要 HTTP 派发至响应解析完成；派发前失败只有 end，耗时为 null |
| `open-start/end` | Codex 打开整个阶段，包括公开地址检查、凭据读取和模型请求 |
| `open-request-start/end` | `/responses` HTTP 派发至打开记录及摘要解析完成 |

`outcome` 标明 success、http-error、timeout、error、cancelled；`fetch-render-skip`、`fetch-summary-skip`、`fetch-open-skip` 标明静态页、短正文、不满足摘要条件、直抓成功、被拦截或已关闭的分支。直抓/打开/下载/提取有包含关系，不能把所有段相加当作端到端时间。取消后的浏览器清理可能晚于直抓截止时刻，记录保留实际完成时间；同一调用异步尝试结束后才 flush。

原命令逐调用输出 `fetchStages`（每段可多次）与 `fetchBranches`。没有运行的段是空数组，只有开始/结束一端的段是 null，不补成零。跨调用汇总：

```sh
node crysound/web/web-tools/timing-report.mjs /path/to/tool-timing.jsonl --fetch-summary
```

汇总含调用数、各段完整样本数、缺失数、中位数、90 分位、结果及跳过分支计数。分位取有序完整样本的 nearest rank；错误/超时也保留在相应分布并单列结果数量。未包含的凭据等待可对照整个 open 阶段与 open-request 的差值。进程被强杀或诊断写入失败仍不构成完整样本。

## 检查和上线验收

本机仅下载三个 npm 固定发布包的归档到临时目录供检查，不安装依赖，不运行整套测试或镜像构建。准备好目录后用 Node 24 执行：

```sh
node crysound/web/web-tools/timing-patch.mjs /path/to/runtime/node_modules
DSH_TOOL_TIMING_RELEASE_ROOT=/path/to/runtime/node_modules \
  node --test crysound/web/web-tools/timing.test.mjs
```

检查执行发布包的真实 step 方法、工具批次调度和搜索提供方代码；流组装、外围宿主服务和 HTTP 响应使用夹具。覆盖确定性时间差、重试、并行调用/会话关联、正文与凭据排除、失败阶段缺失、原业务事件一致、关闭时不注册变换以及开启时上游漂移拒绝。合成时间只验证采样位置和计算，不证明线上 3–5 秒的根因或实际性能。

随下一批伙伴镜像构建发布。伙伴助理先在测试容器启用计时，新会话固定同一模型、推理档位、预设和插件，独立跑“查下杭州今天的天气”三次，保留完整会话与计时日志。逐次核对六个需求时间点、搜索尝试和工具结果；有缺失、取消、错误或缓存/未实际搜索的轮次单独标注，不能充当完整样本。比较各段耗时及三次范围，以重复出现的最长空档决定后续调查方向，不凭一次大值改模型或调度。

然后关闭变量，以相同条件再跑三次，核对正常回答、来源与原会话事件，确认新进程不追加计时日志；保留端到端耗时及其波动，避免把网络/模型差异归为计时开销。本轮没有运行真实公司模型请求，也没有变更线上容器，三次天气和关闭后的性能仍未验收。回退整个补丁时撤回本 PR 并重建镜像；临时关闭只需移除变量并重启测试容器。
