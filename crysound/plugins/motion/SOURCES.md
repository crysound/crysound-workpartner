# 来源与公司改动

来源：[alchaincyf/huashu-motion](https://github.com/alchaincyf/huashu-motion)，版本 0.3.1，固定提交 `52467f99c602b76ba86d511d37acdfe93fa1e16e`。本包保留根 MIT LICENSE；第三方 GSAP 与字体按各自许可分发，见 THIRD_PARTY.md。

`SOURCES.json` 逐文件记录上游与公司版的 SHA-256。`node scripts/vendor.mjs <固定提交的上游检出目录>` 重放导入；脚本只接受该提交，按静态相对 import 复制渲染、静帧、配乐和检查模块的依赖闭包。`node scripts/verify.mjs` 核对本地文件、许可、禁用内容和公司 logo。导入脚本不下载依赖，不改上游仓库。

删改清单：

- 未导入 `runtime/clip/lib/toon.js`、`runtime/clip/grammars/y4_storytime.js`、全部上游 templates 的 HTML、全部 examples/demo/studio、全部上游技能文案；因此不包含豆子花叔形象、storytime 模板及其引用。只保留 blank 模板里的 GSAP 和中文字体资源。公司模板单独维护。
- 未导入上游 CLI、口播模块、Kokoro Python 程序、采样下载器、网络素材抓取、分享上传、服务器等入口；公司 CLI 仅提供 new/templates/scan/check/still/sound/render。
- `render-om.js`：默认与硬上限均为 2 个浏览器；视频提取队列上限为 2。
- 渲染依赖里的子进程调用改走 `cli/process.mjs`，ffmpeg 解码/编码最多 2 线程，过滤器 1 线程。
- `cdp.js`：浏览器不再另开进程组，留在公司监督器管理的任务组；本地关闭浏览器仍调用 kill。公司监督器在退出、取消和超时后停止整个任务组并清理私有临时目录。
- `capture.js`：在开浏览器前限制尺寸，加载时间线后拒绝超过 30 秒的片长；外层监督器另设 5 分钟截止。
- 新增独立 dsh 技能注册、bundle patch、Linux flock 并发控制、品牌模板、操作说明和行为测试；不修改上游 dsh。
- 导入文本统一 LF 行尾、缩进空白和末尾换行；许可正文保持不变，原始与分发摘要分别记录。
- Logo 来自同仓库 `crysound/brand/zp-mark.svg`；确定的探头/落定节奏参考 `crysound/brand/pet.js`，不带其随机状态或实时计时器。

不包含 Remotion、guizang 或 baoyu-design 的代码、素材和技能内容。
