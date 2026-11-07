# 飞书发行包升级回归

本次在既有伙伴镜像的隔离测试档案中运行，没有连接真实用户或飞书账号，也没有构建镜像。旧阶段只读覆盖归档目录，只提供下载站的 `0.17.0-crysound.1`；新阶段恢复镜像原有的 `0.17.0-crysound.2`，并只读覆盖候选修复脚本。两阶段的 dsh/pnpm 相同，模拟本次仅替换飞书归档的升级。

先复现旧版安装后移除旧归档，再安装新版：原生安装器报告旧 tgz 不存在并退出 254。修复后的四条路径见 results.json；每条都从真实安装的 crysound.1 开始，升级后检查 package.json、两份锁文件、配置及其他插件，重复安装检查，从运行时插件清单确认 Feishu enabled=true、fiberPhase=active，认证后网页响应 200，再真实 add/remove 另一个插件。未配置机器人凭据，active 只证明 Cordis 插件已加载，实际飞书连线与收发仍待上线验收。

复跑按 web/README.md 的两阶段方式，在只读挂载本检出的旧、新镜像分别执行 `node /src/crysound/tests/plugin-install-smoke.mjs seed`、`node /src/crysound/tests/plugin-install-smoke.mjs upgrade`。`PARTNER_TEST_ROOT` 必须是专用可丢弃目录；seed 会重建其四个测试档案。镜像公开 CLI 将 desktop 留给 Electron，桌面相对路径使用独立自定义 profile；真实桌面准备函数另由轻量测试覆盖。

`node --test crysound/tests/plugin-artifacts.test.mjs` 使用现有 yaml 和镜像内校验过的归档，31 项全部通过、无跳过。生产 helper 和测试脚本通过 node --check，入口脚本通过 sh -n。完整候选镜像构建、完整清单安装、Mac/Windows 安装包升级与真实飞书交互仍由伙伴助理验收。
