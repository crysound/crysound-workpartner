# B 玻璃品牌源稿

正式配色、造型都在 `src/gen.mjs`。修改这里后，在仓库根目录运行：

```sh
node crysound/brand/logo-src/src/gen.mjs
node crysound/brand/logo-src/src/verify.mjs
```

使用桌面工作区已有的 `sharp`；也可以用 `LOGO_SHARP_MODULE` 指向已有安装。生成脚本不下载依赖、不构建应用。它同步品牌 SVG、网页 favicon、PWA/Apple 图标、飞书上传图、桌面 SVG/PNG/ICO，以及 `pet.js` 的生成片段。不要直接改生成片段。配色调整后，插件仓库的副本另开 PR 同步，不改插件版本号。

`B.svg` 为完整版，`B-16.svg` 为 ≤32 px 简化版；侧栏 22 px、网页标签、Windows 安装图标及托盘 ICO 的 ≤32 px 帧均使用简化版。动画组件也按实例大小选择造型，渐变和裁剪 ID 带实例前缀。睁眼高光位于表情组内，眨眼隐藏高光。

`reference/` 保留原始四方向对比板及素材，供追溯，不参与正式生成。`research.md` 为原调研记录。

在仓库根目录启动静态文件服务后，打开 `crysound/brand/logo-src/preview.html`，加 `?dark` 查看深色底。预览复用产品组件，仅在预览页临时暴露其构造器，列出八个业务状态和“戳一下”交互，共九种状态；也可连续戳五次查看晕眩。桌面任务栏使用实际 ICO 中的 16/24/32 px PNG 帧。

`evidence/` 中的网页截图通过浏览器临时替换本 PR 的品牌响应生成，使用真实页面结构和组件；没有部署。截图只截品牌区域。总览使用上述预览页，包含九种状态、16/24/32/64/512 px、标签图标与桌面栏。均提供浅色、深色背景。

上线后仍需伙伴助理确认镜像中的资源、原生浏览器标签、实际 Dock/任务栏和下一版桌面安装包；桌面栏截图仅为预览。飞书上传使用 `../feishu-app-1024.png`，侧栏使用 `../feishu-sidebar-32.png`。
