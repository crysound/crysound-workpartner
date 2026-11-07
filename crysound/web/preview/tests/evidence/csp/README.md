# 原生下载标记的 CSP 回归

验证时间：2026-11-07（北京时间）。沿用处理手册明确配置的持久 Chromium 入口，只操作脚本新建的独立标签，结束后关闭。页面是隔离夹具，不是线上编辑器。

- 负对照：先给验证页添加原脚本哈希、不含 `unsafe-inline` 的策略，保持旧版 `downloads.mjs`，等待启动标记失败；复现 CSP 阻止注入脚本。
- 修复后：`node --test crysound/web/preview/tests/*.test.mjs`，14 项通过。覆盖精确哈希、nonce、三种哈希算法、指令优先级、多策略、保留 inline-only 策略、报告模式不变，以及压缩 HTML 和原有代理行为。
- `verify-downloads.mjs` 在实际浏览器通过：6 类策略下标记与原编辑器夹具脚本都执行，无 CSP 错误；侧栏和独立标签页中文文本下载完成。完整结果见 `native-downloads.json`，截图见 `native-downloads.png`。
- 仍待自查：测试账号中用实际幻灯片、设计插件的 `artifact.mjs open` 启动编辑器，经过分支预览网关，在 frame 中确认标记为 true。测试入口已请求提供，尚未取得。
- 仍待部署验收：真实 PPTX/PDF、设计导出文件落地且能打开；飞书内置浏览器；正式页面启动无插件加载失败。以上均未记为通过。
