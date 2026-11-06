# 同步主干后的品牌核对

本轮基于主干 `58133ccf79` 重新核对。保留侧栏下载按钮修复，并将桌面品牌资源清单合并为两边的并集，包含时区脚本、小尺寸 logo 与标签图标。B 玻璃方向和生成素材未改。

- 网页截图：使用已登录浏览器的新标签页，临时替换分支的 `brand.js`、`brand.css`、`pet.js` 与 SVG 响应；未部署。
- `web-sidebar-*`：22 px 简化 logo 无高光；`web-hero-*`：40 px 完整 logo 有两个高光点。
- `web-sidebar-collapsed-*`：折叠侧栏品牌。
- `web-download-expanded-*`：展开时显示“下载客户端”；`web-download-collapsed-*`：折叠时按钮 36×36、图标 18 px、文字隐藏，保留无障碍名称。
- `overview-*`：九种状态、各尺寸、标签及桌面栏预览。浏览器断言核对多实例 ID 唯一、渐变引用存在、渐变使用 userSpaceOnUse、眨眼及切换表情隐藏高光。

本轮重新执行：

```sh
node --check crysound/brand/pet.js
node --check crysound/brand/brand.js
node --check crysound/brand/timezone.js
node --check crysound/brand/logo-src/src/gen.mjs
node --check crysound/brand/logo-src/src/verify.mjs
node --check apps/desktop/scripts/electron-builder-config.mjs
node --check apps/desktop/src/crysound/partner.ts # Node 24
node crysound/brand/logo-src/src/verify.mjs # LOGO_SHARP_MODULE 指向已有 sharp
sh -n crysound/scripts/tests/brand-image.sh
sh crysound/scripts/tests/brand-image.sh
git diff --check
```

全部通过。另以只读断言核对桌面资源清单包含合并双方的每一项，且每项对应文件存在。图标核对涵盖扫光实际像素、每个 ICO 帧、PNG 尺寸、Mac 留边、maskable 安全区和再次生成无差异。没有安装依赖或运行整套测试、应用构建、镜像构建。

未验收：重建后的线上页面、原生浏览器标签、实际 Dock/任务栏、桌面安装包、飞书后台上传。桌面栏和标签图标截图仅为预览。
