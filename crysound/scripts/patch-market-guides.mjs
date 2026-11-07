import { installCompanyGuides } from "./patch-market-guide-client.mjs";

/**
 * Add guide slots while preserving native Creator and third-party menus.
 * @param {string} text Pinned entry-customization browser module.
 * @returns {string} Idempotently patched module; unsupported input throws.
 */
export function patchMarketGuides(text) {
  const marker = "/* CRYSOUND package guides v3 */";
  if (text.includes(marker)) return text;
  if (text.includes("/* CRYSOUND package guides v2 */")) {
    const start = text.indexOf("function installCompanyGuides(");
    const end = text.indexOf("\nfunction apply(ctx) {", start);
    if (start < 0 || end < 0) throw new Error("插件引导导航升级未唯一命中");
    return (text.slice(0, start) + installCompanyGuides.toString() + text.slice(end)).replace("/* CRYSOUND package guides v2 */", marker);
  }
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
  const marker = "/* CRYSOUND guide use v3 */";
  if (text.includes(marker)) return text;
  if (text.includes("/* CRYSOUND guide use v2 */")) {
    const start = text.indexOf("function installCompanyMarketNavigation(");
    const end = text.indexOf(")(ctx, controller, face,", start);
    if (start < 0 || end < 0) throw new Error("公司市场来源定位升级未唯一命中");
    return (text.slice(0, start) + installCompanyMarketNavigation.toString() + text.slice(end)).replace("/* CRYSOUND guide use v2 */", marker);
  }
  if (!text.includes("/* CRYSOUND guide use v1 */")) {
    const first = 'function DiscoverSection(props) {';
    const face = 'const face = controller.face((text) => ctx.locale.resolveText(text));';
    if (text.split(first).length !== 2 || text.split(face).length !== 2) throw new Error("插件引导使用入口未唯一命中");
    text = "/* CRYSOUND guide use v1 */\n" + text.replace(first, `${first}
      const original = props; props = { ...props, openPackage: name => original.openCompanyGuide(name, () => original.openPackage(name)) };`)
      .replace(face, `${face}\nface.openCompanyGuide = (name, fallback) => { if (ctx.bail(ctx, "company-guide/open", name, fallback) !== true) fallback(); };`);
  }
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error("市场详情导航补丁未唯一命中");
    text = text.replace(before, () => after);
  };
  replace('const face = controller.face((text) => ctx.locale.resolveText(text));',
    `const face = controller.face((text) => ctx.locale.resolveText(text));
    (${installCompanyMarketNavigation.toString()})(ctx, controller, face, _deepseek_ai_dsh_client_store.createSnapshotStore, INITIAL_QUERY);`);
  replace('function Browser({ state, listing, t, face, hooks, language, onInstall, openPackage }) {',
    'function Browser({ state, listing, t, face, hooks, language, onInstall, openPackage, companyTarget }) {');
  replace('const state = props.useDiscover((snapshot) => snapshot);',
    'const state = props.useDiscover((snapshot) => snapshot);\nconst companyTarget = props.useCompanyMarket((snapshot) => snapshot.name);');
  replace('listing: state.listing,', 'listing: state.listing, companyTarget,');
  replace('if (text === query.text) return void 0;', 'if (companyTarget !== null || text === query.text) return void 0;');
  replace('text,\n\t\t\t\tquery,', 'text, companyTarget,\n\t\t\t\tquery,');
  replace('const openEntry = opened === null ? void 0 : value?.entries.find((entry) => entry.name === opened.name) ?? opened;',
    'const openEntry = companyTarget !== null ? value?.entries.find((entry) => entry.name === companyTarget) : opened === null ? void 0 : value?.entries.find((entry) => entry.name === opened.name) ?? opened;');
  replace('setOpened(null);', 'setOpened(null); if (companyTarget !== null) { setText(""); face.closeCompanyEntry(); }');
  return text.replace("/* CRYSOUND guide use v1 */", marker);
}

/**
 * Select an official entry through the native market query and detail view, including a cold catalog.
 * @param {object} ctx Company market client context.
 * @param {object} controller Native market controller with its observable listing.
 * @param {object} face Native injected market actions.
 * @param {Function} createSnapshotStore Native observable-store factory.
 * @param {object} initialQuery Native unfiltered query.
 * @returns {void}
 */
export function installCompanyMarketNavigation(ctx, controller, face, createSnapshotStore, initialQuery) {
  const target = createSnapshotStore({ name: null });
  let pending = false;
  const prepare = () => {
    if (!pending) return;
    const state = controller.store.getSnapshot();
    const company = state.indexes.find(row => new URL(row.url).pathname === "/_zp/market/index.json");
    if (!company) return;
    if (state.selected !== company.url) { face.select(company.url); return; }
    if (state.listing?.url !== company.url) return;
    pending = false;
    face.search({ ...initialQuery, text: target.getSnapshot().name ?? "" });
  };
  face.hooks = { ...face.hooks, companyMarket: target };
  face.closeCompanyEntry = () => { target.set({ name: null }); face.search(initialQuery); };
  ctx.effect(() => {
    const dispose = controller.store.subscribe(() => queueMicrotask(prepare));
    return () => { pending = false; dispose(); };
  });
  ctx.effect(() => ctx.on("company-market/select", name => {
    target.set({ name }); pending = true;
    face.ensure();
    // Let the native index load finish its initial selection before changing sources.
    queueMicrotask(prepare);
    return true;
  }));
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
