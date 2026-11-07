# 插件市场设置图标复核（#167）

公司启动修补将 dshmarket 1.73.12 的既有 `MarketLogo` 注册到 `settings.section.icon`，以 `market` 匹配原设置分区。旧 `settings-nav-icon.ts` 构建区域整体移除，不再注入隐藏齿轮、`::before` 方块或按文字寻找导航行的观察器。不改上游外壳，不发布新版 dshmarket，不新增图标设计。

## 真实发布路径回归

PR #169 的补丁条目、集成测试和浏览器验证器都曾错误地使用 `dshmarket/lib/client.js`。测试把网页模块写到自建路径，导致检查通过而真实安装包被静默跳过；旧截图只能证明模块替换后的显示效果，不能证明启动修补或正式部署成功。

本次直接下载 npm 官方 dshmarket@1.73.12 tarball，并比对 registry 元数据中的 SHA-512。包内只有 `client/client.js`，没有 `lib/client.js`。`//#region src/client/settings-nav-icon.ts`、`installSettingsNavIcon(ctx, () => t("nav"));`、`function MarketLogo(` 均唯一命中。旧 CLI 在该真实包上成功退出但未改文件，已复现。

修补条目和浏览器验证器现使用真实路径。测试要求 `MARKET_ICON_PACKAGE` 指向完整解包目录，核对包名、版本和全部 dshmarket 补丁目标，不再接受单独下载的网页模块，也不再因未设置环境变量而跳过集成验证。升级测试复制完整发布包，再分别覆盖原模块和旧公司隐藏规则版本；两者运行真实启动 CLI 后得到相同内容，二次执行不变，输出文件通过语法检查。

所有补丁条目在全部给定根目录及其 pnpm 存储位置都找不到目标时，向标准错误输出“插件修补未命中，目标文件不存在”。函数补丁同样覆盖；缺失的可选或已退役插件只告警，不阻止启动。文件存在但原文不匹配仍提示插件可能已升级。

```sh
mkdir -p /tmp/market-release
curl -fsSL https://registry.npmjs.org/dshmarket/-/dshmarket-1.73.12.tgz -o /tmp/market-release/dshmarket.tgz
tar -xzf /tmp/market-release/dshmarket.tgz -C /tmp/market-release
MARKET_ICON_PACKAGE=/tmp/market-release/package node --test crysound/config/plugin-market-icon.test.mjs
```

下载包应与 `https://registry.npmjs.org/dshmarket/1.73.12` 中的 `dist.integrity` 比对。测试在 Node 24 下 6 项通过，无跳过；将目标路径改回 `lib/client.js` 的失败对照会被真实包路径检查拒绝，将缺文件告警恢复为静默跳过也会被告警测试拒绝。

## 其他补丁路径审计

本次读取 `PATCHES` 中所有条目，逐项核对下表的真实包内容；7 个不同文件全部存在，没有其他缺失路径。SlideStudio 的嵌套依赖直接包含在其官方 tarball 中，无需另装依赖。公司作品包使用此前交付保留的完整 tarball，本次未重新访问私有市场或验收线上安装。

| 包与版本 | 目标路径（相对包目录） | 依据 |
| --- | --- | --- |
| @crysound/artifacts@1.0.0 | lib/client.js | 既有交付 tarball |
| dshmarket@1.73.12 | client/client.js | npm 官方 tarball，SHA-512 一致 |
| @deepseek-ai/dsh-client-ui-settings-general@0.2.2-rc.1 | lib/client.js | npm 官方 tarball，完整性一致 |
| @deepseek-ai/dsh-client-ui-sidebar-browser@0.2.2-rc.1 | lib/client.js（3 条） | npm 官方 tarball，完整性一致 |
| dsh-claude-artifacts@2.12.0 | lib/client.js（2 条） | npm 官方 tarball，完整性一致 |
| dsh-slidestudio@0.2.9 | node_modules/@open-slidestudio/dsh-slides-host/dist/produce-request-header.js | npm 官方 tarball，完整性一致 |
| dsh-slidestudio@0.2.9 | lib/dsh-slidestudio.js | npm 官方 tarball，完整性一致 |

路径存在不代表每条旧补丁仍适用于每个历史版本。本次只改市场目标路径及缺文件告警，不更改其他补丁正文。

## 网页显示复核

原 PR 的浏览器检查使用真实网页设置外壳、临时数据与路由替换，市场图标检查要求 `button > 装饰容器 > settings.section.icon > svg`，可见 SVG 和伪元素之和恰好为 1，且各行横坐标一致。其他七行保留原图标。

| 外观 | 浅色 | 深色 |
| --- | --- | --- |
| 经典 | [原 PR 截图](default-light-market-icon.png) | [原 PR 截图](default-dark-market-icon.png) |
| 兆华柔和 | [原 PR 截图](soft-light-market-icon.png) | [原 PR 截图](soft-dark-market-icon.png) |

[原 PR 逐行测量](market-icons.json)与[原 PR 失败对照](negative-control.json)均是模块替换后的证据，本次没有重跑或将其算作正式部署通过。需要复跑时，沿用配置的浏览器入口，设置 `CDP_TAB`、`APP_ORIGIN`、`PLAYWRIGHT_MODULE` 及可选 `CDP_ENDPOINT`，在 Node 24 下运行：

```sh
SETTINGS_ICONS_ONLY=1 SETTINGS_EVIDENCE=/tmp/market-icons node crysound/scripts/verify-settings-pages.mjs
```

加 `SETTINGS_MARKET_CONTROL=1` 跳过模块修补，应拒绝两个图标。去掉 `SETTINGS_ICONS_ONLY` 可继续完整临时数据交互矩阵。此验证器不替代正式环境直接验收。

## 交付边界

伙伴助理同步共用 `plugin-patches.mjs` 并重启已确认的个人容器即可，不需要换镜像。重新打开正式设置，核对市场只显示一个方块、没有齿轮、与其他行左对齐；记忆书签、主动提醒铃铛、飞书授权图标不变。正式环境和桌面安装包尚未验收。

回退须恢复旧脚本，并从同版 dshmarket 官方包恢复已修补的运行时文件；只换旧脚本不能恢复已移除的模块区域。没有用户数据迁移或删除。
