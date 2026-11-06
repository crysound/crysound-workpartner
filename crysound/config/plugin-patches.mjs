// 第三方插件的本地修补，每次启动时由 entrypoint 运行。每条写明文件、原文和替换文；已打过的跳过，原文找不到就提示（多半是插件升级了，该条要重看）。
// 用法：node plugin-patches.mjs <插件安装目录，即 profiles/web/node_modules>
import fs from "node:fs";
import path from "node:path";

const UNBOUND_HINT = "还没有选会话。发 /new 新建一个会话，或发 /resume 进入网页里已有的会话。";

const PATCHES = [
  // SlideStudio 0.2.9 与 dsh 0.2.2-rc.1：dsh 在组装钩子之后才补工具清单，钩子里 tools 为空时按空清单处理。
  {
    file: "dsh-slidestudio/node_modules/@open-slidestudio/dsh-slides-host/dist/produce-request-header.js",
    find: "return tools.filter((tool) => tool.name !== PRODUCE_WEB_SEARCH_NAME);",
    replace: "return (tools ?? []).filter((tool) => tool.name !== PRODUCE_WEB_SEARCH_NAME);",
  },
  // SlideStudio：幻灯片助手的范围里没有 {{cwd}} 变量；这个助手不读写文件，去掉这半句。
  {
    file: "dsh-slidestudio/lib/dsh-slidestudio.js",
    find: "You are the DSH SlideStudio slides director. Working directory is {{cwd}}.",
    replace: "You are the DSH SlideStudio slides director.",
  },
  // 飞书机器人：没选会话时直接在 /data/work 用默认模型新建一个会话，把这条消息发进去，像和真人聊天一样不用先发命令。
  {
    file: "@aiwayds/dsh-feishu/lib/bot.js",
    find: `        const outcome = await this.injectPrompt(text);
        if (outcome === 'refused') {`,
    replace: `        let outcome = await this.injectPrompt(text);
        if (outcome === 'refused' && this.binder.getSessionId() === undefined) {
            try {
                const created = await this.binder.createNew(this.newSessionCwd(undefined), this.newSessionDefaultSelection(undefined), undefined);
                if (created.model !== undefined)
                    this.selectionRefs.set(created.sessionId, created.model);
                await this.store.update({ boundSessionId: created.sessionId, picker: undefined });
                outcome = await this.injectPrompt(text);
            }
            catch (error) {
                this.ctx.logger.warn('dsh-feishu: auto-new failed: %o', error);
            }
        }
        if (outcome === 'refused') {`,
  },
  // 飞书机器人只发回复正文（Jason 11-06）：不开进度卡；每轮把回复作为纯正文卡发出；正常完成不发“完成”卡，出错或被停止才发状态卡。
  {
    file: "@aiwayds/dsh-feishu/lib/bot.js",
    find: `    async openCard() {
        const chatId = this.store.get().lastChatId;`,
    replace: `    async openCard() {
        return;
        const chatId = this.store.get().lastChatId;`,
  },
  {
    file: "@aiwayds/dsh-feishu/lib/bot.js",
    find: `        const embed = shouldEmbedRoundText(roundText, this.config.bodySegmentChars);
        if (chatId !== undefined) {`,
    replace: `        const embed = shouldEmbedRoundText(roundText, this.config.bodySegmentChars);
        if (chatId !== undefined && roundText !== '')
            await this.replyLong(roundText);
        if (false) {`,
  },
  // 11-06 上午版本把结束原因当成对象判断，正常完成也会发“完成”卡；已打过那版的就地改正。
  {
    file: "@aiwayds/dsh-feishu/lib/bot.js",
    find: "if (this.runState.turnEndReason?.kind !== 'completed')",
    replace: "if (this.runState.turnEndReason !== 'completed')",
  },
  {
    file: "@aiwayds/dsh-feishu/lib/bot.js",
    find: `            // vanishing entirely. Round bodies already went out per round.
            await this.lark.sendCard(chatId, card);`,
    replace: `            // vanishing entirely. Round bodies already went out per round.
            if (this.runState.turnEndReason !== 'completed')
                await this.lark.sendCard(chatId, card);`,
  },
  // 飞书机器人：剩下的“未绑定”提示改成先推荐 /new。
  ...[
    ["@aiwayds/dsh-feishu/lib/bot.js", "尚未绑定会话。发 /resume 查看并进入一个会话；/help 查看命令。"],
    ["@aiwayds/dsh-feishu/lib/bot.js", "尚未绑定会话。先发 /resume 进入一个会话。"],
    ["@aiwayds/dsh-feishu/lib/bot.js", "尚未绑定会话。发 /resume 进入一个会话。"],
    ["@aiwayds/dsh-feishu/lib/interactive.js", "尚未绑定会话。先发 /resume 进入一个会话。"],
  ].map(([file, find]) => ({ file, find, replace: UNBOUND_HINT })),
  { file: "@aiwayds/dsh-feishu/lib/card.js", find: "'没有可恢复的会话。'", replace: "'没有可恢复的会话。发 /new 新建一个会话。'", all: true },
];

const root = process.argv[2];
for (const p of PATCHES) {
  const file = path.join(root, p.file);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(p.find)) {
    if (!text.includes(p.replace)) console.log(`插件修补未命中，可能插件已升级：${p.file}`);
    continue;
  }
  const next = p.all ? text.split(p.find).join(p.replace) : text.replace(p.find, p.replace);
  // pnpm 用硬链接共享文件，先删再写，只改本人这一份。
  fs.rmSync(file);
  fs.writeFileSync(file, next);
}
