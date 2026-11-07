# 英文搜索并发补充 Exa（#185）

查询去掉空白后，ASCII 字母占 Unicode 字符数一半以上时，在原 DeepSeek Flash / Luna 搜索之外并发调用 Exa。中文和未达到此比例的混合查询保持原路径；正文保留原搜索回答。来源先放 Exa 有有效发布日期的条目，再放 Exa 其他条目和原搜索来源；按标准化 URL（忽略片段、规范化主机及默认端口）去重，沿用请求的来源上限，未指定时最多 10 条。摘要优先使用 Exa 的 summary，其次使用 highlights，沿用 800 字符上限；不把日期或正文编造成摘要。

Exa 调用复用镜像已有的 `CRYSOUND_MARKET_ORIGIN`、`CRYSOUND_MARKET_TOKEN_FILE` 和容器本人身份，只请求 `/_zp/treg/call/treg.web.search`。不新建密钥、不改身份结构。五秒从搜索开始时计算，包含读取身份、请求和响应解析；原搜索先完成时只等到这条共同截止线，原搜索较慢时不再增加五秒。无配置、身份缺失、超时、HTTP/网络错误、额度不足、响应损坏和无可用来源时返回原搜索结果；本人取消则停止调用并抛出取消。辅助调用不重试，原搜索失败后的 Luna 退路不变。

## 网关与费用

本轮通过只读公开目录及现有网关校验路径确认：`treg.web.search` 已经允许，无需扩大接口范围。原网关会忽略调用方路由头，本次只对该接口固定 `Prefer: exa`、`Waterfall: 0`，费用上限取个人单次设置和 0.01 美元中的较小值。目录仍须确认路由包含 Exa，且 Exa 子接口属于已开放的数据平台；只校验实际选择的 Exa，不再逐个查询其他未使用供应商。REST 与受限 MCP 共用此逻辑，调用方不能指定他人归属、改路由或提高费用上限。

仍经原网关设置 Treg 原生日、月预算、携带本人标签并处理额度错误。0.007 美元单价来自需求单与本轮读取的公共目录，不是本轮实扣账单。按该价格估算，100 次额外调用约 0.70 美元；实际实扣及预算阻断须在获准后验收。客户端超时仅保证搜索按时返回，不能保证已送达上游的调用不计费。

启用后会增加英文查询的付费调用，按 partner-issue 手册先交提问分诊确认；本轮不添加 deliver 标签，不发上线交付请求，不调用真实付费搜索。

## 自查

使用 Node 24、固定 `0.2.2-rc.1` 发布 JS 的隔离临时副本及已有文本转换依赖；不安装依赖、不跑整套测试、不构建镜像、不读取部署凭据。

| 检查 | 结果及范围 |
| --- | --- |
| 修改前对照 | 两项新检查均失败：没有 Exa 并发请求；网关未固定 Exa 路由头 |
| `exa.test.mjs` | 7 项通过，包含并发、日期顺序/URL 去重/条数上限、中文不调用、额度与响应错误退路、响应体停滞、五秒共同截止线、晚到的身份读取不能补发、取消与主搜索终止 |
| 原有搜索与补丁回归 | 9 项通过，覆盖 DeepSeek→Luna、12/4 秒预算、取消/凭据/日志错误、正文与引用、无来源正文、发布包补丁幂等和漂移拒绝 |
| `treg.test.mjs` | 14 项通过，真实本地 HTTP + 假上游；校验固定路由、个人身份、单次上限、原生日月预算、错误脱敏及原接口限制；Exa 未开放或路由不含 Exa 时拒绝 |
| `timing.test.mjs` | 6 项通过，原有发布循环计时、并发会话关联及启用/关闭行为保持 |
| 发布包实际入口 | 新测试从真实发布包注册搜索提供方，启用计时插桩，再调用搜索；验证 Luna 退路正文、Exa 来源以及同一工具调用的次数、耗时和采用标记 |

运行定向搜索回归时只选择本单相关测试；抓取、真实浏览器、真实模型和线上性能不计入通过项。首次使用的不完整临时依赖目录无法加载文本转换模块；改用隔离的原始发布 JS 和已有依赖后上述检查通过，不以缺依赖的结果作为代码缺陷或通过证据。

```sh
DSH_WEB_TOOLS_RELEASE_ROOT="$RELEASE_ROOT" node --experimental-vm-modules --test crysound/web/web-tools/exa.test.mjs
DSH_WEB_TOOLS_RELEASE_ROOT="$RELEASE_ROOT" node --experimental-vm-modules --test --test-name-pattern='fallback always|default search budgets|ten-second Flash|search does not retry|both failed searches|released search|multiple native searches|patches apply' crysound/web/web-tools/web-tools.test.mjs
DSH_TOOL_TIMING_RELEASE_ROOT="$TIMING_RELEASE_ROOT" node --test crysound/web/web-tools/timing.test.mjs
node --test crysound/web/gateway/tests/treg.test.mjs
```

## 获准后的部署与验收（尚未执行）

伙伴助理保留旧镜像和网关版本，重建网页镜像、重新创建网关（`treg.mjs` 是单文件挂载），先在长期测试账号换镜像验证；按既有约定推进其他容器。本单没有共享配置或桌面安装包改动。

1. 英文分别搜索 “latest stable Rust release version” 和 “latest Claude model released by Anthropic”，按当天官方发布页核对版本、型号和日期；不得把需求单里列的历史示例当作固定答案。两题均应有官方来源，检查新来源摘要与保留的主搜索回答是否冲突。
2. 以同模型、推理档、插件、新会话及同一题目复测中文天气，和 #181 部署后的记录比较；核对没有 Exa 请求，不凭本地模拟时间宣称线上提速。
3. 模拟 Exa 超时/失败/额度耗尽，确认仍返回 DeepSeek 或其原有备用结果。日/月额度核对本人标签、上游实际费用及其他账号不受影响。
4. 在测试进程按 TIMING.md 开启诊断，报告中的 `exa.calls`、`exa.attempts[].durationMs/status`、`exa.adopted` 应与实际调用对应；中文显示零次、未采用，超时显示 timeout。记录完整会话与计时报表。

真实 Exa 返回、答案时效、官方来源质量、中文天气耗时和实扣预算均尚未验收。回退时恢复旧网页镜像和旧网关文件，按原方式重建网关及升级容器；不改用户数据、额度、令牌或密钥。
