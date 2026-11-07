# 飞书 crysound.2 → crysound.3 升级证据

在已有伙伴镜像内限一核运行，不构建镜像、不挂载真实用户数据、不连接机器人。先在四个隔离档案中真实安装镜像里的 crysound.2，再把归档目录替换为仅含本 PR 打出的 crysound.3。两阶段使用同一 dsh/pnpm，升级沿用 #123 的 repair 和网页安装入口；上一轮四条路径的证据保存在提交 `865f3578b919b94ffe57230e42572b0d07ea0d2e`；本轮按评审要求用字母前缀归档重跑网页旧本地地址一条路径，当前结果见 [results.json](results.json)。

复跑使用 `crysound/tests/plugin-install-smoke.mjs` 的 seed / upgrade 两阶段。准备专用临时源码副本：测试脚本的旧版 crysound.1 替换为 crysound.2、目标 crysound.2 替换为 crysound.3；副本的 plugin-artifacts.mjs 仅将 FEISHU 文件名、目标地址文件名和校验值替换为本次归档。副本的 entrypoint.sh 与本 PR 一致。生产 plugin-artifacts.mjs 和 plugins.json 不在本 PR 中修改，待伙伴助理上传新包后统一更新。

旧阶段把镜像内 crysound.2 归档只读挂到 /opt/company-plugins，新阶段该目录只提供 crysound.3，并把临时 helper 挂到 /opt/partner/plugin-artifacts.mjs。两阶段均挂临时源码到 /src、隔离档案到 /test，设置 PARTNER_TEST_ROOT=/test，分别运行 `node /src/crysound/tests/plugin-install-smoke.mjs seed` 和 `node /src/crysound/tests/plugin-install-smoke.mjs upgrade`。seed 会重建专用测试目录，不得指向用户数据。

覆盖网页旧本地地址、旧远程地址有/无校验值、桌面相对地址。远程用例先真实安装旧包再改写旧锁地址，不依赖旧包网络地址可用。每条检查两份锁、原插件选择和其他依赖，重复安装两次，从真实运行时清单读取 enabled=true、fiberPhase=active，认证后首页 200，再安装和移除另一个插件。桌面相对路径使用独立自定义档案，未运行实际 Electron 安装包。

插件在同一镜像里完成 npm ci、npm test、npm run check、npm run build、npm pack。测试 564 项，562 通过，2 项因缺 zstd 跳过，未新增跳过。归档内说明、版本和编译后的四个改动模块逐字节与当前文件比较一致。未修改生产应用权限、清单或容器；真实飞书一秒内出卡、提醒、连续逐字、无撤回和无重复仍交伙伴助理先只在指定试用账号验收。

占位卡改动此前在修复前复现 9 项失败，覆盖各入口在无模型输出时出卡、快速结束、准备失败、网页轮次插队和创建中重复结束。本轮仅将正文组件编号改为字母 p 加 18 位随机十六进制（19 位），并将编号测试扩为连续生成 1,000 个真实预览，逐一匹配 `/^[A-Za-z][A-Za-z0-9_]{0,19}$/` 且互不重复；临时还原旧生成器时，新检查因数字开头失败。

版本保持 crysound.3，在同一镜像中重新完成 npm ci、test、check、build、pack。归档内容与源码说明及本轮编译产物逐字节一致，sha512 见 results.json。新归档重新走 crysound.2 → crysound.3 网页旧本地地址路径，安装入口重复两次，真实 Loader 激活、认证后首页 200、两份锁与配置保留、后续增删插件均通过；安装后的 preview.js 也与新归档逐字节一致。未重跑其余三条升级路径，上一轮同版本归档不用于交付。
