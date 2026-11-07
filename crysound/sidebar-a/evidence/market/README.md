# 市场入口预览

本轮使用手册指定的持久浏览器专用标签页，只替换本分支的侧栏、工作区和品牌响应。页面及业务接口来自已登录的真实伙伴服务，未改服务器、用户记录或安装包；外观和视图偏好隔离到标签页的会话存储。

[验证报告](verification.json) 记录柔和/经典 × 浅色/深色 × 展开/收起/手机共十二种情况：市场有图标，无小字，无障碍名称只有“市场”；展开和手机的可见文字只有“市场”，收起隐藏文字。截图等待抽屉动画结束后仅裁市场行，不含个人资料。复跑入口为 `SIDEBAR_MARKET_ONLY=1` 的 `search.browser.mjs`，详见上级说明。浏览器脚本未捕获异常。

| 外观 | 展开 | 收起 | 手机（390px） |
| --- | --- | --- | --- |
| 柔和浅色 | [截图](soft-light-desktop.png) | [截图](soft-light-collapsed.png) | [截图](soft-light-mobile.png) |
| 柔和深色 | [截图](soft-dark-desktop.png) | [截图](soft-dark-collapsed.png) | [截图](soft-dark-mobile.png) |
| 经典浅色 | [截图](default-light-desktop.png) | [截图](default-light-collapsed.png) | [截图](default-light-mobile.png) |
| 经典深色 | [截图](default-dark-desktop.png) | [截图](default-dark-collapsed.png) | [截图](default-dark-mobile.png) |

原始固定版发布模块及皮肤检查 14/14 通过。市场组件旧断言“市场 · 插件·技能”改为“市场”，并检查可见文本、小字不存在、收起无障碍名称及文案清理。前序核对使用 `40b795cd06` 的导航 v1/工作区 v2 和 #153 提交 `984b4dd519` 的导航 v2/工作区 v3；两条精确升级路径与全新打补丁的完整模块逐字节一致，第二次运行不变，修改或重复旧文案的前序被拒绝。固定包版本不符、未命中不写入、硬链接和权限保留沿用发布模块测试。

这些是分支响应预览，没有重建伙伴镜像、启动 Electron 或运行模型回合，因此没有 GIF。发布镜像和实际 macOS/Windows 安装包仍须由伙伴助理验收。部署为重建伙伴镜像，桌面随下一安装包；回退为上一镜像或安装包，无数据迁移。
