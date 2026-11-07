# 设置页改版验收（#150）

记忆页使用 dsh Button / Switch，字段与说明使用 `--dsw-*` 变量，标题与主动提醒页同为 16px / 500。列表标题和添加入口组成一行，危险操作放在列表下方；空列表隐藏清空入口和删除说明，失败时仍可刷新重试。编辑字段采用独立标签关联，已有内容不会混入字段名称。

主动提醒沿用 `crysound-daily-check` 注册身份、原接口和个人记录格式，只更换可见名称与铃铛图标。记忆使用书签图标。插件市场的第二个图标来自 dshmarket 1.73.12：其样式只隐藏导航按钮的直接 SVG，而设置壳已把 SVG 包进装饰性容器。本次在已有启动修补里同时隐藏这个容器，保留市场自己的方块图标，不修改 dsh 本体。

## 浏览器证据

沿用规则指定的持久浏览器，只操作自行创建的标签页。原生设置壳、React 和控件来自真实网页，记忆和飞书设置模块替换为本分支源码；所有记忆、提醒与授权请求在该标签页内拦截，指向临时 SQLite 和真实 HTTP 处理器，授权写操作拒绝。截图只截设置弹窗，内容均为合成测试数据。退出时先清除路由再转空白页，未操作线上个人数据、设置、额度或消息。

柔和配色使用已合入的 #146 / PR #153 的 `crysound/brand/skin.css`（来源提交 `984b4dd51990f0d46fc2445a36da54bdc17ff4d1`，与当前主分支文件摘要一致），只改变本标签页的主题属性，不写入个人外观偏好。最终复核基于合入后的主分支；矩阵中的“默认”指原默认外观，现在设置中称“经典”，兆华柔和仍按 #146 作为默认外观。皮肤文件摘要、请求路径、实际字号、导航图标与结果见 [acceptance.json](acceptance.json)。每张桌面截图都包含完整设置入口列表。

| 外观 | 记忆列表 | 空状态 | 清空确认 | 主动提醒与完整入口 |
| --- | --- | --- | --- | --- |
| 默认 · 浅色 | [截图](default-light-memory.png) | [截图](default-light-memory-empty.png) | [截图](default-light-memory-clear.png) | [截图](default-light-reminders.png) |
| 默认 · 深色 | [截图](default-dark-memory.png) | [截图](default-dark-memory-empty.png) | [截图](default-dark-memory-clear.png) | [截图](default-dark-reminders.png) |
| 兆华柔和 · 浅色 | [截图](soft-light-memory.png) | [截图](soft-light-memory-empty.png) | [截图](soft-light-memory-clear.png) | [截图](soft-light-reminders.png) |
| 兆华柔和 · 深色 | [截图](soft-dark-memory.png) | [截图](soft-dark-memory-empty.png) | [截图](soft-dark-memory-clear.png) | [截图](soft-dark-reminders.png) |

另有 [390px 窄屏截图](narrow-memory.png)。未嵌入 GIF：本轮以四种外观的静态截图审阅排版，操作结果由可重跑的浏览器脚本直接断言，不把截图轮播当成交互录像。

## 重跑与覆盖

在 Node 24 下运行 `node crysound/scripts/verify-settings-pages.mjs`。必填 `CDP_TAB`（本人创建的标签页编号）与 `APP_ORIGIN`（已登录的应用来源）；`PLAYWRIGHT_MODULE` 可指定现有 Playwright 模块，`CDP_ENDPOINT` 默认为本机 9222。`PREVIEW_SKIN_CSS` 可指定待审皮肤文件，否则用本分支皮肤；`SETTINGS_EVIDENCE` 可指定输出目录。不安装依赖，不启动新浏览器，不修改登录会话。

- 浏览器：四种外观下的开关、添加、编辑、单条删除和清空；打开确认与取消均不删除条目；空状态无删除说明；实际标题字号一致；无横向溢出；记忆和提醒分别使用书签与铃铛；市场只显示一个图标。提醒预先保存启用状态、10:45 时间和一条运行记录，读取页面前后文件逐字节不变，另检查开关与时间保存后历史保留。没有调用模型或读取真实飞书资料。
- Node 24：`node --test crysound/plugins/memory/tests/client.test.mjs crysound/plugins/memory/tests/memory.test.mjs crysound/feishu/native.test.mjs crysound/daily-check/service.test.mjs` 全部 40 项通过，覆盖临时真实数据库、HTTP、版本冲突、开关持久化、回执、每日检查去重和 Host 投递。另尝试 `tools.test.mjs`，因检出未安装 `@deepseek-ai/schemastery` 未启动；本机按手册不装依赖，不把这项记为通过。
- 修改的 JS / MJS 通过 `node --check`；在浏览器实际加载的 dshmarket 模块临时副本上运行启动修补两次，第二次文件内容不变。

以上证明分支界面与隔离数据交互，正式部署、既有用户真实数据和桌面安装包仍待验收；未构建镜像或桌面版。界面分诊通过后才交伙伴助理发布与上线。

## 部署与回退

1. 由伙伴助理以已定的官方发布账号将 `@crysound/memory` 0.1.3 发布到兆华市场并完成审批，确认包包含本版 client.js 与原语外部依赖声明。不能先上线指向尚未发布版本的预装清单。
2. 同步服务器共用配置中的 `plugins.json`（记忆固定为 0.1.3）、`plugin-patches.mjs` 和使用说明；不更改部署参数、资格、权限或钥匙。重建伙伴镜像并按既定策略更新个人容器，使原生设置与提醒 Host 文案生效；重建网关容器以重新载入提醒服务提示的名称。桌面版随下一安装包，桌面本机模式仍不启动每日任务。
3. 对已有测试账号先记录记忆条目与开关、提醒开关/时间/历史，更新后逐项对照；补拍正式环境四种外观。删除和清空只在获准的合成测试数据上验收，不删除真实个人条目。确认没有“插件修补未命中”，设置市场入口只有一个图标。
4. 回退时恢复上一镜像与共用配置，记忆预装固定回 0.1.2，并恢复原提醒模块；数据格式没有变化，不迁移或清空数据库、提醒记录或会话。若要同时撤回市场图标修补，须从同版本 dshmarket 官方包恢复它的运行时 client.js；只撤回修补脚本不会还原已修补的个人依赖文件。桌面回到上一安装包。
