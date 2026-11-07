# 固定摘要标题的悬停遮挡检查

[审查意见](https://github.com/crysound/crysound-workpartner/pull/159#discussion_r4500998348)指出：`MessageItem.module.css` 的展开摘要标题使用 sticky 定位，悬停时依靠 `--dsw-alias-interactive-bg-hover-solid` 遮住滚动到下方的正文。半透明黑 5% / 白 6% 会破坏该用途。

主分支已通过 [PR163](https://github.com/crysound/crysound-workpartner/pull/163) 将此 solid token 改为不透明合成色：浅色 `#E6E6E1`（`#F2F2ED` 上叠加黑色 5%），深色 `#262626`（`#181818` 上叠加白色 6%），各通道四舍五入。均来自 Cindy surface + surface-hover，普通悬停保留原透明墨色。本补充仅记录来源、提供像素检查及证据；皮肤与色板检查沿用主分支现有写法。

复跑：在手册配置的持久浏览器打开专用空白标签页，运行 `CDP_TAB=<标签页> SOLID_HOVER_EVIDENCE_DIR=<输出目录> node crysound/brand/tests/solid-hover.browser.mjs`。脚本只覆盖该空白页：直接读取上游 `MessageItem.module.css` 与分支皮肤，构造合成摘要并滚动，让标题固定在滚动区域顶部；强制悬停，将标题下的正文背景依次改为洋红和绿色，比较标题区域截图。禁用动画和过渡后，修复前两种主题的像素都随下方内容变化，修复后两种均保持完全相同。

持久浏览器报告 hover:none，因此样例将上游 `(hover: hover)` 条件替换为恒真的宽度条件，显式激活桌面悬停规则，再强制该按钮的 hover 状态；没有声称此环境是实际鼠标设备。报告中的 hover:false 是浏览器原始能力，不代表样例未激活规则。

[旧版报告](before-verification.json)通过 `EXPECT_HOVER_LEAK=1` 和修复前的 CSS 文件（PR159 合入后的版本）复跑确认浅深均透底；[主分支修复报告](verification.json)使用 PR163 合入后的十六进制颜色复跑，确认浅深均不透底。[浅色标题](light.png)、[深色标题](dark.png)仅包含合成标题。此为隔离 CSS 复现，不是实际会话、重建镜像或 Electron；没有业务数据或账号信息。实际发布和安装包验收仍由伙伴助理完成。
