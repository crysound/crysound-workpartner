# 首次陈述与回复回执验收

关联需求单 #99。评估集 [dialogues.json](dialogues.json)包含 30 段合成中文工作对话，18 段“该记”、12 段“不该记”。每段从空记忆与新会话开始，不用“记住”提醒模型，不手工补保存。五个中文信号、自然偏好、职责、长期项目、纠正和带相同关键词的临时要求分别标注。

## 指标口径

提取率 = 该记对话中，最终数据库至少一条内容符合该段目标语义的对话数 / 18。误记率 = 不该记对话中，最终数据库出现任意记忆的对话数 / 12；同一段误记多条只算一段。不是工具调用率，不凭助手说“记住”判定。目标词正则在跑模型前固定，用于保守地筛出对应事实；同义表达可能漏判，逐条事实需审阅。kind 只作为标注参考，不因模型将职责分成 project 或 identity 就判漏记。该记样本内部的额外扩写不计入这个误记率：逐条审阅发现新版 m16 把“喜欢编号清单”扩写为“每条简短、只讲一个重点”，这部分不是用户逐字明确的偏好；后续后台学习仍需用户原话校验，不能把两项指标当作全部记忆内容都准确。

同一模型、同一测试环境各跑一遍旧版与新版，不混入之前小样本、页面预置或别的模型结果。环境或采集失败不计成漏记，未跑满时脚本只报告 completed，不给比例。此样本小、每段只有一次运行，不代表线上稳定效果或跨模型泛化。

## 本次结果

既有 magpie 接入的 codex/gpt-6.1-sol / low，隔离 dsh 0.2.2-rc.1 / Node 24.22.2；真实模型名逐段取自持久会话日志。每个版本各 30 次独立会话，未重复挑选更好的结果；没有环境失败。旧版为 33c57a3fc0，新版被测提示词与工具说明来自 8bde5cda98。实际保存内容均写成陈述句。

| 版本 | 目标内容提取 | 不该记对话误记 |
| --- | --- | --- |
| 旧提示词 | 18/18（100%） | 0/12（0%） |
| 新提示词 | 18/18（100%） | 0/12（0%） |

这组小样本前后相同，**未测出提取提升**；不据此宣称后台学习已生效。逐条真实事实、模型、调用参数和结果元数据见 [evaluation.json](evidence/issue-99/evaluation.json)，可与固定标注重新计算。回执、陈述句指引和触发/反例说明是本单可验证的行为变化。

## 复跑

使用环境负责人提供的既有隔离测试入口，不自行接正式账号、复制凭据或安装依赖。入口须支持 `sync <plugin-dir>`、`reset`、`headless <message>`、`db <只读SQL>`；reset 只能作用于这次测试的合成数据。浏览器使用另一份隔离数据，不能和评估共享 reset 目标。Node 24 和 zstd 可用即可跑脚本。

基线取本单起点 `33c57a3fc0` 的 `crysound/plugins/memory` 及同级 `memory-evaluation`；例如用 `git archive 33c57a3fc0 crysound/plugins/memory crysound/plugins/memory-evaluation` 解到自己的测试目录。新版用本分支源码，不将基线的整个工作树覆盖回来。不要切换模型或推理档。

```sh
node crysound/plugins/memory-evaluation/evaluate.mjs \
  --entry /provided/isolated-entry.sh \
  --baseline /scratch/baseline/crysound/plugins/memory \
  --candidate /checkout/crysound/plugins/memory \
  --sessions /scratch/synthetic-home/sessions \
  --output /scratch/results
node --test crysound/plugins/memory-evaluation/evaluate.test.mjs
```

脚本顺序同步每个版本，每段 reset → headless → 读真实 facts → 解压本段会话，保存真实模型、调用/结果和最终事实。会话必须有实际完成的模型轮次；中断会留下错误，不生成通过率。每个版本的提示词 hash 固定，可从同一输出目录续跑已成功条目；输入变化须换新目录。

## 页面验收

真实隔离网页通过持久 CDP 的独立标签访问，沿用既有测试模型；目录选择器用官方 in-browser overlay，未建镜像、未改正式站。用户自然陈述周报风格，模型实际保存，回答下出现“已记住：周报表达顺序”。浅/深色下均可点击，弹窗复用设置的管理组件，目标记录滚动到可见区域且获得焦点。实际数据库与成功元数据编号一致。重启测试宿主后，同一合成会话的回执仍可点击。第二轮“临时测试结束”没有新增回执。

- [浅色回执](evidence/issue-99/receipt-light.png)、[浅色定位](evidence/issue-99/located-light.png)。
- [深色回执](evidence/issue-99/receipt-dark.png)、[深色定位](evidence/issue-99/located-dark.png)。

**限制**：原生 dsh 工具视图能渲染按钮，回复末尾也有 `conversation.chat.turnTail` 扩展位；原生设置壳的 `openSection()` 只在壳内部与 onboarding 的 props 中可达，没有供普通插件调用的服务或动作。本版点击打开同一管理组件的独立弹窗，是待分诊确认的替代实现，尚未满足“直接打开原生设置页”的原始交互。没有通过 DOM 点击或模拟快捷键绕开设置接口。设置页改版 PR #89 与本单重叠，合并前需保留其样式并复查定位。

## 发布与未验收项

0.1.2 包新增 guidance.mjs，发布时不得漏包；回执 id/title 是工具结果元数据，SQLite 格式不变，旧结果卡片无新元数据时保留原展示。预装清单固定到 0.1.2；必须先发布插件，再更新配置并核对网页版/桌面版。没有发布、合并或操作正式用户。

正式网关 A/B 账号隔离、桌面端、线上夜间常驻、与 PR #89 合并后的页面和正式发布由伙伴助理继续验收。已完成的旧样本记录不重做。后台学习技术结论见 [BACKGROUND-FEASIBILITY.md](BACKGROUND-FEASIBILITY.md)。

## 轻量检查

隔离环境以真实已装 peer 依赖执行 `node --test tests/*.test.mjs`，20/20 通过；评估计分测试 `node --test crysound/plugins/memory-evaluation/evaluate.test.mjs`，2/2 通过。存储测试覆盖持久化、并发版本、敏感拒存、事务回滚和旧录制会话；工具测试覆盖真实 schema 编译、成功编号/标题与同编号更新；客户端测试覆盖成功/拒存/旧结果、嵌套 PTC、同条更新去重和会话绑定。`node --check` 覆盖全部改动的运行文件及评估/探针脚本；`npm pack --dry-run --json` 确认 0.1.2 的九个发布文件含 guidance.mjs，未含测试探针和评估资料。另复核既有 6 组真实会话证据。没有安装依赖、跑整套测试、构建 dsh 或建镜像；按 partner-issue 的服务器资源限制使用轻量自查。完整构建、正式发布与部署验收仍交伙伴助理。
