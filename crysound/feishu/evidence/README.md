# 原生设置截图预览

全部截图使用测试授权状态和本分支界面代码，放在真实 dsh 设置壳内渲染。没有连接或断开真实授权。项目状态只提供连接与否，因此截图按真实接口显示授权时间未记录。浏览器和桌面分支预览不证明提供方授权、真机或安装包行为。

| 场景 | 未连接 | 已连接 |
|---|---|---|
| 网页宽屏 | ![未连接](web-wide-disconnected.png) | ![已连接](web-wide-connected.png) |
| 网页窄屏 | ![未连接](web-narrow-disconnected.png) | ![已连接](web-narrow-connected.png) |
| 深色主题 | ![未连接](web-dark-disconnected.png) | ![已连接](web-dark-connected.png) |
| 内置浏览器分支预览，非真机 | ![未连接](embedded-preview-disconnected.png) | ![已连接](embedded-preview-connected.png) |
| 桌面分支预览，非安装包 | ![未连接](desktop-preview-disconnected.png) | ![已连接](desktop-preview-connected.png) |

导航选中见宽屏截图，未选中如下：

![导航未选中](navigation-unselected.png)

可使用上级目录的 `verify-browser.mjs` 重跑。同一浏览器入口中只操作本任务专用标签页，授权接口使用夹具。脚本实际断言图标、选中状态、授权地址、焦点自动刷新和断开确认／取消；移动端和桌面仅切换客户端分支。授权完成页的返回标记与运行时引导修补由轻量处理器测试覆盖。

截图对应的界面文件 SHA-256：

- `crysound/feishu/native/client.js`：`4849526f3166a8561f27f98fac4e828dca71fd81e5c738961081d0d0a6f08950`
- `crysound/brand/brand.js`：`b171773c07592dbe3851916688afc459b8535440e2c753be3aabaeb113eaa638`
- `crysound/config/plugin-patches.mjs`：`1eac75eec2fcfd0558ca28b5d0be11f462ed4903467d30e33ddf196c119a6fa9`
