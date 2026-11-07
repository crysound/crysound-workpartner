# 原生下载标记的 CSP 回归

验证时间：2026-11-07（北京时间）。沿用处理手册明确配置的持久 Chromium 入口，只操作自己新建的独立标签，结束后关闭。`native-downloads.*` 是隔离夹具；`real-editors.json` 和两张 `*-frame.png` 是真实插件编辑器的隔离测试。

- 负对照：先给验证页添加原脚本哈希、不含 `unsafe-inline` 的策略，保持旧版 `downloads.mjs`，等待启动标记失败；复现 CSP 阻止注入脚本。
- 修复后：`node --test crysound/web/preview/tests/*.test.mjs`，14 项通过。覆盖精确哈希、nonce、三种哈希算法、指令优先级、多策略、保留 inline-only 策略、报告模式不变，以及压缩 HTML 和原有代理行为。
- `verify-downloads.mjs` 在实际浏览器通过：6 类策略下标记与原编辑器夹具脚本都执行，无 CSP 错误；侧栏和独立标签页中文文本下载完成。完整结果见 `native-downloads.json`，截图见 `native-downloads.png`。
- 真实编辑器标记自查通过：用幻灯片、设计插件的 `artifact.mjs open` 打开合成测试作品，转发器直接复用本分支的 `previewDownloadBody`，与工作树文件的 SHA-256 一致。浏览器依次检查两种编辑器 × 对照/分支 × 独立页/跨源 iframe，共 8 个场景。对照只注入标记、不改 CSP；幻灯片的两种位置均阻止标记执行，分支均为 true 且无 CSP 错误；设计的两种位置、两种转发均为 true，原 inline-only 策略不受影响。全部场景恰有一份标记，均无脚本异常。结果见 `real-editors.json`，截图见 `slides-frame.png`、`design-frame.png`。
- 真实编辑器复查步骤：打开各编辑器的分支转发及旧行为对照地址；分别独立访问、嵌入真实本地 HTTP 验证页的跨源 iframe，在其默认执行上下文读取 `window.__baoyuNativeDownloads` 并收集 CSP 错误。iframe 显式含 `allow-downloads`；许可自动添加/撤回及中文下载链路沿用前述夹具验证。未修改持久浏览器下载配置。
- 证据范围：转发器只验证真实编辑器 HTML 的分支响应改写，不包含正式登录、预览票据或完整主站。幻灯片合成作品在对照和分支均显示保存内容异常；设计画布截图时两者均显示 Loading。此自查仅证明标记执行与 CSP，不证明作品完整可用或文件导出成功。
- 仍待部署验收：真实 PPTX/PDF、设计导出文件落地且能打开；飞书内置浏览器；正式页面启动无插件加载失败。以上均未记为通过。
