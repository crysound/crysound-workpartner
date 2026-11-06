# 兆华记忆：社区插件初评

关联 [需求单 #67](https://github.com/crysound/crysound-workpartner/issues/67)。四个固定版本的源码初评已完成，fooxe / palace 已在一次性测试容器试装，补测结果见 [RESULTS.md](RESULTS.md)。下表保持静态发现的口径；运行证据、未验收项另列，不把源码推断当作效果已通过。官方插件最小实现位于 [../memory/](../memory/README.md)，不加入预装。

## 一页结论

选择公司自写最小实现。**fooxe 和 memory-palace** 实测均能自动记、新会话召回；前者在对话中遗忘失败，网页可删整条但面板英文；后者确认删除后，后台日志重写了含原文的“已删除”条目，新会话仍把原文投影给模型。前者还存在公开域名检查和满额自动删旧文件问题；后者每轮后台整理增加模型调用。两者都不能原封不动交付。jipika 扩展到全局指令和通用文件写入守卫；restregular 的权限、向量安装及管理功能维护面较大。当前是少量合成偏好的功能实测，不是自动保存率统计或完整安全验收。

| 候选（固定版本） | 自动记与新会话召回、上下文及费用 | 数据、管理与隔离 | 依赖、质量与风险 |
| --- | --- | --- | --- |
| `@fooxe/dsh-memory@0.13.10` | 工具说明指导主模型主动保存稳定偏好，不是独立提取器；保存是否发生待测。每个作用域自动注入最多 25 条索引，索引另有 200 行、25 KiB 上限，正文按关键词搜/读；不是全部正文注入。无额外摘要模型调用，但主对话保存/检索及索引会增加用量。 | 用户目录默认 `$DSH_HOME/memory`，项目目录自动探测后写 `.dsh/memory`；Markdown 索引及每条文件。英文设置页可查看、编辑、删除；模型工具只有 save/search/read/list。会写项目目录，不能算只写插件专属目录。 | 无运行时普通依赖，无本地模型/外部服务。凭据形状扫描不能识别任意普通密码。同名更新、原子写入是优点；并发读改写索引存在丢更新风险，超过 500 个文件会删除旧文件。面板只允许本机/IP Host，原版不适配当前域名网关。 |
| `dsh-memory-palace@1.8.4` | 主模型主动写长期记忆；每轮另经 `ctx.llm.stream` 整理今日日志，另增模型调用，不能叫零费用。长期记忆及今日日志投影到历史；用户文件默认 8,000 字符，工作区每文件 6,000 字符，多个桥接目录会叠加，不能视为统一总量上限。 | 用户 `~/.deepseek-harness/MEMORY.md`、项目 `.deepseek-harness`；已存在的 WorkBuddy/CodeBuddy 目录默认参与桥接写入。Markdown 可手改；中文设置页主要管配置/自定义指令，源码初评未确认完整逐条记忆管理页。`memory_delete` 有人工确认；日志中的删除线墓碑不是物理清除，不能据此承诺彻底遗忘。 | 无普通依赖；使用宿主 Schemastery、LLM、工具和 Web 服务，部分实际 import 未列 peer。不需要嵌入模型或新外部服务；后台整理仍走已配置模型。会话缓冲、异步整理、历史投影耦合多；桥接目录、日志和备份需一起核对。 |
| `@jipika/dsh-memory@0.9.4` | 当前主模型按指令用文件工具写；默认注入分片地图、小库内联，正文关键词搜索后按行读取。地图随分片数增长；可选无地图模式，但主模型是否主动搜没有本轮证据。插件不另调摘要模型，主对话与检索仍增加用量。 | `~/.dsh/memory/topics` 及其项目分片，Markdown；中文面板可看/改记忆及 `~/.dsh/AGENTS.md`，修改留 `.bak`。依赖通用文件工具维护，不能把删某段等同于备份里也已删除。明确超出只管理自己的数据目录。 | 无普通依赖；可选外部命令判断器/过滤器须保持未配置，不需本地模型/服务。单文件宿主约 3,000 行以上，写入守卫、审计、历史投影、全局指令编辑扩大升级风险；部分宿主能力动态探测，缺失时可能静默降级。 |
| `@restregular/dsh-memory@0.30.1` | 主模型工具保存；新会话摘要、每轮按问题召回及行为触发召回，均有预算/去重。默认写入会话作用域，个人事实是否进入 global 待测。**向量为可选配置**，无后端会退到中文词法检索，不能直接认定必须启动 BGE-M3。 | 默认相对进程目录 `.dsh-memory`，JSONL 记录及作用域/设置/授权等 JSON；中文面板可查看、编辑、删除，模型有 `memory_forget`。路径可配置，向量安装又可涉及另一目录；需要锁定本人挂载区。 | 无普通依赖，宿主 Cordis/LLM/工具 peer。带 llama-server 启停、BGE-M3 下载及可选外部向量/重排入口；公司版必须移除或禁用这些入口。凭据扫描、并发锁和作用域授权较完整，但发布代码体量与维护面最大。 |

四款发布包都声明 MIT，包内均含许可证；复刻须保留原作者许可。`inspection.json` 固定了包完整性校验值、许可证、依赖、发布记录与代码指纹，未把任何候选加入运行配置。活动度仅按截至评估时过去 30 天的 npm 发版时间统计，包含预发布、不是提交活跃度或质量评分：fooxe 42 次、palace 8 次、jipika 2 次、restregular 106 次。

代码量是**发布包全部 JavaScript，包括宿主、客户端、注释及可能的打包代码**，不是原始项目源码行数，不能据此推导性能：分别为 97,714 / 254,635 / 217,605 / 1,178,488 字节，非空物理行分别为 2,035 / 4,164 / 4,193 / 21,203。归档完整性及这些数值由脚本直接从固定发布包计算。

## 与 dsh 0.2.2-rc.1 的兼容性

源码可见四款使用的系统提示词、工具注册等扩展点仍存在；但这不证明加载、页面或模型行为兼容。palace 声明 `engines.dsh: ^0.2.1-rc.5`；宿主 `packages/boot/app-boot/src/plugin-compatibility.ts` 的版本检查启用 `includePrerelease`，所以不能仅按普通 npm 的预发布规则把它判为不兼容。fooxe 仅声明较宽的 Cordis/tools peer，restregular 的宿主 peer 为 `*`，jipika 未声明宿主版本范围；这些也不是兼容保证。两款实测都要保留安装、启动、工具和页面证据，不擅自授予版本豁免。

升级时重点复查 `defineTool` 参数/输出、`systemPrompt.section` 及顺序、会话工作目录、`sessionProjections`、客户端模块与设置注册、`webStartup`/`connection` 的可信域名。palace 每轮后台调用还需复查 LLM 流及会话事件。源码基线为本分支起点 `45d1089a4c`，CLI 声明版本为 0.2.2-rc.1。

当前网关 `crysound/web/gateway/gateway.mjs` 的 `forwardHeaders` 对记忆插件路径保留公开 Host；fooxe 的 `isTrustedPanelRequest` 只收 localhost/IP，因此其原版面板会被该检查拒绝。这是源码路径推导，**尚未在真实网关发请求验证**。不能通过把网关来源伪成本机或删除来源检查来掩盖问题；公司实现应消费宿主可信域名配置并保留同源校验。

## 复查入口

```sh
python3 crysound/plugins/memory-evaluation/inspect_candidates.py \
  --cache /tmp/partner-memory-inspection \
  --output /tmp/partner-memory-inspection.json
```

脚本只读公开 npm 元数据及固定归档，不安装包，不执行生命周期脚本或插件。归档按 SHA-512 校验，在内存读取常规文件，不解压到工作区；缓存重跑应输出同一份报告。导入名只做正则粗扫，不是完整依赖审计。离线可用已生成报告，运行时实测另见 [TRIAL.md](TRIAL.md)。

固定版本源码可从 `candidates.json` 的 tarball 地址复查，关键位置如下：

| 候选 | 发布包内路径与关键符号 |
| --- | --- |
| fooxe | `lib/index.js`：`SAVE_DESCRIPTION`、`registerMemoryGuidance`、`pruneMemories`、`writeIndexGuarded`、`SECRET_PATTERN`、`isTrustedPanelRequest`、`handlePanelDelete`；`client/client.js`：设置页注册 |
| palace | `lib/index.js`：`Config`、`_settle`、`inject`；`lib/common/paths.mjs`：`writeDirs`；`lib/projection.mjs`：逐文件预算；`lib/hybrid/subagent.mjs`：`streamTurn`、`runMemorySubagent`；`lib/tools.mjs`：`memory_delete` |
| jipika | `index.js`：`RULE_FILES`、`atomicWrite`、`writeGuardHook`、系统提示词 section；`client.js`：规则/记忆编辑 |
| restregular | `lib/provider/index.js`：`resolveConfig`；`lib/provider/embed-server.js`、`embed-install.js`；`lib/inject/apply.js`：召回；`lib/tools/apply.js`：保存/遗忘；`lib/panel.js`：管理接口 |

## 接着做

候选与最小实现的真实模型和页面证据见 [RESULTS.md](RESULTS.md) 与 `trial-evidence.json`。`summarize_trial.py --output <报告.json> <合成测试会话文件...>` 提取已选测试会话的模型、用量、记忆工具和召回快照，不导出完整系统提示词或无关会话。只用于确认不含真实凭据的合成测试资料；`zstd` 命令须已安装。`browser_trial.mjs` 用已配置的持久 CDP 浏览器，必须指定自己的 `CDP_TAB`；支持新会话、输入合成消息、点击已核实控件和候选删除确认，不安装驱动、不借用桌面连接。

最小实现仅在本人持久化挂载区的插件专属目录保存稳定事实，主对话模型主动提取，不新增后台摘要调用；总召回字符受控，中文页面和遗忘工具共用 SQLite 事务。旧版本写入拒绝，满额停止新增；不另存日志、墓碑或自动备份。普通密码标签和常见凭据形状在写入边界拒存；没有已知格式或标签的任意秘密无法保证识别。数据落在个人挂载范围内有代码依据，但**现有备份包含新目录及 SQLite 一致性恢复效果仍需伙伴助理实测**。

界面变化及新持久化结构须在形成可审查 PR 后先经提问分诊；此处未请求重新决定已批准的产品方向。插件由伙伴助理验收后，再经负责人同意预装。

个人记忆的开关、编辑、来源时间、随机编号更新、原子合并、敏感拒存和本会话不记的新版验证见 [IMPROVEMENTS.md](IMPROVEMENTS.md)。`verify_personal_memory.py` 可无模型访问复查已提交的真实会话及页面证据；原评估结果保留为历史记录。
