# 插件市场设置图标复核（#167）

公司启动修补将 dshmarket 1.73.12 的既有 `MarketLogo` 注册到 `settings.section.icon`，以 `market` 匹配原设置分区。旧 `settings-nav-icon.ts` 构建区域整体移除，不再注入隐藏齿轮、`::before` 方块或按文字寻找导航行的观察器。不改上游外壳，不发布新版 dshmarket，不新增图标设计。原始模块和之前打过公司隐藏规则的模块都可升级，重复运行不再改文件。

## 真实外壳与对照

沿用手册配置的持久浏览器，只操作自建标签页。设置外壳直接加载已登录网页的真实构建模块，没有替换外壳、导航行或 `settings.section.icon` 包装。市场浏览器模块来自该网页的实际响应，在临时副本上运行本分支启动修补两次，然后只在本标签页内替换模块响应。记忆和飞书模块使用本分支源码，所有记忆、提醒、授权请求保持原验证器的隔离：临时数据库、真实 HTTP 处理器和合成提醒记录，拒绝授权写操作。不改个人偏好、不发消息。

旧线上模块的真实结构为 `button > span[aria-hidden=true] > span[data-slot="settings.section.icon"] > svg`。未应用市场修补时，同一检查明确报错“插件市场: exactly one visible icon，2 !== 1”；不是只断言没有 SVG。开启修补后，检查每行可见 SVG 和伪元素之和恰好为 1，图标处于真实插槽内，各行图标横坐标一致。其他七行分别保留原齿轮、模型、内置插件、Agent 预设、飞书链接、铃铛和书签图标。

| 外观 | 浅色 | 深色 |
| --- | --- | --- |
| 经典 | [截图](default-light-market-icon.png) | [截图](default-dark-market-icon.png) |
| 兆华柔和 | [截图](soft-light-market-icon.png) | [截图](soft-dark-market-icon.png) |

[四种外观的逐行测量](market-icons.json)与[失败对照](negative-control.json)随本次修复保存。截图只截设置弹窗，展示合成提醒数据；未放 GIF，因为变化是静态图标重复，四种外观截图和同一个检查的失败/通过对照直接覆盖验收目标。

## 重跑

沿用父目录验证器的 `CDP_TAB`、`APP_ORIGIN`、`PLAYWRIGHT_MODULE` 和可选 `CDP_ENDPOINT` 配置，在 Node 24 下运行：

```sh
SETTINGS_ICONS_ONLY=1 SETTINGS_EVIDENCE=/tmp/market-icons node crysound/scripts/verify-settings-pages.mjs
```

加 `SETTINGS_MARKET_CONTROL=1` 跳过市场模块修补，检查应拒绝未修复页面的两个图标。去掉 `SETTINGS_ICONS_ONLY` 则继续运行完整设置页交互矩阵，包括临时数据上的记忆增删改和提醒持久化。每轮结束清除路由、转空白页并断开自动化连接，不关闭共享浏览器。

保存网页实际加载的 dshmarket 模块副本后，可运行：

```sh
MARKET_ICON_CLIENT=/tmp/market-client.js node --test crysound/config/plugin-market-icon.test.mjs
```

本轮三个测试均通过，覆盖原图标注册、释放句柄、未知或重复模块结构拒绝、真实发布模块及旧公司补丁副本升级、二次执行不变。真实模块临时副本通过 `node --check`。修改过的 JS/MJS 通过语法检查。

## 交付边界

本轮证明本分支模块在真实网页外壳中的效果，未部署正式环境，未构建或验收桌面安装包。伙伴助理须同步共用 `plugin-patches.mjs`，随下一批伙伴镜像重建并按既定策略更新个人容器，桌面版随下一安装包；重开设置确认市场仅一个方块，其余图标不变。回退须撤回本 PR 后重建镜像，并从同版 dshmarket 官方包恢复已修补的个人依赖文件；只换回旧脚本不会恢复已移除的模块区域。没有数据迁移或删除。
