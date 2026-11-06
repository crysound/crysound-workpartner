# @crysound/design

为兆华工作伙伴制作公司品牌网页、App 原型、信息图、海报，并做设计体检。支持技能工具和 `/design`：默认先展示三个真实方向，用户选择后迭代；幻灯片交给 SlideStudio。

## 安装与使用

在已登录公司的工作伙伴中安装获批版本：`dsh plugin add @crysound/design@0.1.0`。最低 dsh 0.2.2-rc.1、Node 24.9。插件 patch 注册 bundled skill provider；不改上游 dsh，不自动安装给所有同事。

示例：“用公司品牌为演示用的测量工具做官网首页”“做一个可点击的演示 App 原型”“为演示活动做一张海报”。品牌默认 DESIGN.md，用户项目已有规范时优先沿用。没有真实产品数据时明确标“演示”。

## 运行配置、权限与限制

渲染复用镜像已有的 `SLIDESTUDIO_PLAYWRIGHT_RUNTIME`，要求提供 `launchPinnedChromium()`；缺少时明确失败，不下载浏览器。无新 npm、Python 或系统依赖。桌面版未附带此运行时，需管理员提供已有兼容运行时后才能执行截图；没有运行时仍可读取技能，但不得声称完成截图验收。

`node scripts/render.mjs <local.html> <output-dir> [--viewports 1440x900,375x812]` 写 PNG 与 report.json，默认禁止远程网络请求。只在用户指定的工作区读取/写入文件，不读取令牌、不连接公司业务接口、不写全局偏好。输入 HTML 的本地脚本会在浏览器中执行，应仅用于自己制作或信任的原型，不作为执行不可信文件的隔离环境。

同一主机的全部本包渲染进程通过回环端口 43871 / 43872 预留两个浏览器槽，单进程逐视口执行。端口已占用就等，60 秒仍未取得槽则报错；崩溃后由系统回收。不向外网监听。该限制只涵盖本包入口，其他插件的浏览器由各插件管理。不要绕过入口启动额外设计浏览器。

体检先触发并等待懒加载图片解码，再核对页面错误、破图、溢出、极小文字和远程依赖；真实加载失败仍报破图。审美、对比度、键盘与业务交互仍须看真实截图及点击核对。无幻灯片、视频、配音、云端素材或模型下载功能。

## 自查、打包与发布

```sh
node maintain/check-package.mjs
node --test tests/*.test.mjs
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

已有共用浏览器运行时的环境另跑 `node tests/browser-smoke.mjs`，覆盖真实页面检查、点击与页外懒加载图片（成功与真实失败各一张）。

公司插件统一由长期保留的测试发布账号发布，后续版本仍使用同一账号。在该账号登录的工作伙伴中，按 `crysound/config/skills/publish-zhaohua-market/SKILL.md` 发布到兆华市场：

```sh
: "${CRYSOUND_MARKET_REGISTRY:?请在工作伙伴中执行}"
: "${CRYSOUND_NPM_USERCONFIG:?请在工作伙伴中执行}"
NPM_CONFIG_USERCONFIG="$CRYSOUND_NPM_USERCONFIG" npm publish --registry "$CRYSOUND_MARKET_REGISTRY"
```

发布后等待管理员审批；不在公共 npm 发布，不读取或复制凭据。首发所有权归发布者，版本不可覆盖。构建无需步骤，本包直接发布 ESM 和静态资源。

上线验收：在测试账号安装，确认 `/design` 与技能工具可读；用公司品牌各做官网首页、App 原型、海报，保留方向选择和真实截图，网页与 App 点通关键路径，将三份截图交负责人审阅。发布、安装和设计质量验收由伙伴助理执行，本地自查不替代这些步骤。

许可证、固定提交与删改清单见 SOURCES.md、NOTICE、LICENSE 和 licenses/。
