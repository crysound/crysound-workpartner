import { installCompanyGuides } from "./patch-market-guide-client.mjs";

/**
 * Add guide slots while preserving native Creator and third-party menus.
 * @param {string} text Pinned entry-customization browser module.
 * @returns {string} Idempotently patched module; unsupported input throws.
 */
export function patchMarketGuides(text) {
  const marker = "/* CRYSOUND package guides v2 */";
  if (text.includes(marker)) return text;
  if (text.includes("/* CRYSOUND package guides v1 */")) {
    const before = '"uiWorkspace", "sessions", "workspaces", "remote.pluginManager", "conversation", "inputTriggers"\n';
    const start = text.indexOf("function installCompanyGuides(");
    const end = text.indexOf("\nfunction apply(ctx) {", start);
    if (text.split(before).length !== 2 || start < 0 || end < 0) throw new Error("插件引导依赖升级未唯一命中，请核对 dsh 版本");
    text = text.slice(0, start) + installCompanyGuides.toString() + text.slice(end);
    return text.replace("/* CRYSOUND package guides v1 */", marker)
      .replace(before, before.replace('"remote.pluginManager"', '"remote", "remote.pluginManager"'));
  }
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error("插件引导补丁未唯一命中，请核对 dsh 版本");
    text = text.replace(needle, () => next);
  };
  replace('"uiWorkspace"\n', '"uiWorkspace", "sessions", "workspaces", "remote", "remote.pluginManager", "conversation", "inputTriggers"\n');
  replace('function apply(ctx) {', `${installCompanyGuides.toString()}\nfunction apply(ctx) {
    installCompanyGuides(ctx, _deepseek_ai_dsh_client_store.createSnapshotStore, react_jsx_runtime.jsx, react_jsx_runtime.jsxs);
    ctx.effect(() => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(guideCss)}; document.head.appendChild(style); return () => style.remove(); });`);
  return marker + "\n" + text;
}

/**
 * Route company Use actions through guidance with a native settings fallback.
 * @param {string} text Pinned company catalog browser module.
 * @returns {string} Idempotently patched module; unsupported input throws.
 */
export function patchGuideUse(text) {
  const marker = "/* CRYSOUND guide use v1 */";
  if (text.includes(marker)) return text;
  const first = 'function DiscoverSection(props) {';
  const face = 'const face = controller.face((text) => ctx.locale.resolveText(text));';
  if (text.split(first).length !== 2 || text.split(face).length !== 2) throw new Error("插件引导使用入口未唯一命中");
  return marker + "\n" + text.replace(first, `${first}
    const original = props; props = { ...props, openPackage: name => original.openCompanyGuide(name, () => original.openPackage(name)) };`)
    .replace(face, `${face}\nface.openCompanyGuide = (name, fallback) => { if (ctx.bail(ctx, "company-guide/open", name, fallback) !== true) fallback(); };`);
}

/**
 * Replace the localized home placeholder.
 * @param {string} text Pinned conversation browser module.
 * @returns {string} Idempotently patched module; unsupported input throws.
 */
export function patchGuidePlaceholder(text) {
  const changes = [
    ['variant === "composer" && input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {})', 'input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {})'],
    ['"placeholder.hero": "描述你想要构建的内容, / 调用指令, @ 文件或对话"', '"placeholder.hero": "例如：帮我整理会议纪要，列出下一步行动"'],
    ['"placeholder.hero": "Describe what you want to build, / commands, @ files or sessions"', '"placeholder.hero": "For example: Summarize these meeting notes and list the next actions"'],
  ];
  for (const [before, after] of changes) {
    if (!text.includes(before) && text.includes(after)) continue;
    if (text.split(before).length !== 2) throw new Error("首页例句补丁未唯一命中");
    text = text.replace(before, after);
  }
  return text;
}

const guideCss = `
.zp-guide-shortcuts { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; padding:12px 0; }
.zp-guide-shortcuts button,.zp-guide-card button { font:inherit; text-align:left; border:1px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-module-platform); color:inherit; border-radius:12px; padding:8px 12px; cursor:pointer; }
.zp-guide-shortcuts button:hover,.zp-guide-card button:hover { background:var(--dsw-alias-bg-hover); }
.zp-guide-tag { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--dsw-alias-border-l3); border-radius:10px; padding:3px 8px; font-size:12px; white-space:nowrap; }
.zp-guide-tag button { font:inherit; background:none; border:0; color:inherit; cursor:pointer; }
[data-composer-command^="zp-guide:"] { display:none; }
.zp-guide-card { display:grid; gap:8px; border:1px solid var(--dsw-alias-border-l3); border-radius:16px; padding:20px; margin-bottom:12px; }
.zp-guide-card h3,.zp-guide-card p { margin:0; }
.zp-guide-card .zp-guide-caption { opacity:.65; font-size:12px; margin-top:8px; }
.zp-guide-card button:disabled { opacity:.5; cursor:default; }
`;
