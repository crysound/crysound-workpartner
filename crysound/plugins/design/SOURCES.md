# 来源与删改记录

## 固定来源

- huashu-design：<https://github.com/alchaincyf/huashu-design/tree/b2460b031c33ff32d2bf3b97263527daa231e4de>，版本 3.2.0，MIT。保留根 LICENSE；此提交没有 NOTICE，包内 NOTICE 补充署名与修改说明。
- frontend-design：<https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design>，Apache-2.0。SKILL.md 原文放 `references/frontend-design.md`，LICENSE.txt 原文放 `licenses/frontend-design-Apache-2.0.txt`；该技能无单独 NOTICE。
- 默认品牌：本仓库 `crysound/brand/zp-mark.svg`（包内逐字节副本）、`crysound/brand/brand.css`。品牌层无字体文件，DESIGN.md 明示系统字体建议及其来源，不宣称另有公司字体规范。

## 保留

保留 huashu 的 typography、content-guidelines、critique-guide 正文（content-guidelines 清理行尾空格）；design-styles 只保留 web / app / info / east 分区及通用指导，删去 PPT 和小红书分区。保留四分区 JPG 样张、四张总览、iOS / Android / 浏览器 / macOS / 设计画布 JSX 外壳参考。

改编 huashu SKILL、directions、网页、信息图、App 和 verification 流程为本包技能与模块手册：保留先六候选再三方向真实初稿、用户选定后迭代、截图复核的核心。技能通过公司 provider 供工具与斜杠命令调用。审美底线读取 frontend-design 原文。

## 排除与替换

采用明确白名单导入，不拷贝完整上游树。`assets/style-specimens/xhs/_kit/stickers/`（PolyForm Shield）及其整个 xhs 分区和总览均排除，避免残留受限素材的派生样张；`scripts/cloud/` 整体排除。不引入 baoyu-design、CL4R1T4S、guizang 的内容。

排除幻灯片/PPTX 全链路、视频/音频/配音、外部云脚本、所有上游 Python/JS/shell 执行脚本、demos、自动安装流程与原依赖清单。只保留样张 JPG，不打包可能访问 CDN/字体网络的样张 HTML。无 pdf-lib、pptxgenjs 或额外 playwright 依赖。

重写为零安装依赖的 Node 渲染入口：读取已有 SLIDESTUDIO_PLAYWRIGHT_RUNTIME，离线截图、报错与基础体检；两个固定回环端口保留浏览器槽，跨进程最多两个。系统自动回收崩溃进程的端口。无 Python 运行依赖，现有镜像已有 Python 但本包无需新增系统包。未保留上游全局偏好/账本写入，只在当前项目记录用户选择。

## 重现导入

维护脚本不发布到 npm 包。先把上面两个固定提交的文件取到本地，再在本包目录运行：

```sh
node maintain/import-upstream.mjs <huashu固定提交的检出目录> <frontend-design的SKILL.md> <frontend-design的LICENSE.txt>
node maintain/check-package.mjs
```

`maintain/upstream-files.json` 记录导入文件 SHA-256；重复导入应无差异。本地改编手册和公司运行时代码不会被导入脚本覆盖。更新来源必须重新审核许可证、白名单与改编内容。
