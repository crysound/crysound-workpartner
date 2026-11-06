// 公司市场的构建期补丁：网页版 npm 运行时与桌面打包运行时使用同一份，不修改上游插件源码。
import fs from "node:fs";
import path from "node:path";
import { patchMarketCatalog } from "./patch-market-catalog.mjs";
import { patchMarketEntry } from "./patch-market-entry.mjs";
import { pathToFileURL } from "node:url";
import { marketLocales } from "../brand/market-locales.mjs";

/**
 * 修补已构建的 ui-plugin-manager client.js；补丁完整命中或抛错，重复执行不改变结果。
 * @param {string} text dsh 0.2.2-rc.1 的浏览器模块内容。
 * @returns 默认打开公司市场、按公司顺序和中英文名称显示标签的模块内容。
 */
export function patchMarketUi(text) {
  const marker = "/* CRYSOUND market tabs v3 */";
  if (text.includes(marker)) return text;
  const replace = (find, replacement) => {
    if (text.split(find).length !== 2) throw new Error("市场界面补丁未唯一命中，请核对 dsh 版本");
    text = text.replace(find, replacement);
  };
  // 未加载完 slots 时保留默认意图；用户主动选择标签后，不再抢回公司市场。
  replace('tab: "installed"', 'tab: "zp-market-default"');
  replace('const tab = tabs.some((item) => item.id === selectedTab) ? selectedTab : INSTALLED_TAB;',
    'const tab = selectedTab === "zp-market-default" ? (tabs.some((item) => item.id === "discover") ? "discover" : INSTALLED_TAB) : tabs.some((item) => item.id === selectedTab) ? selectedTab : INSTALLED_TAB;');
  replace('if (tab !== selectedTab) setTab(tab);',
    'if (tab !== selectedTab && !(selectedTab === "zp-market-default" && tab === INSTALLED_TAB)) setTab(tab);');
  replace('if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") instance.actions.setView({ kind: "list" });',
    'if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") { instance.actions.setView({ kind: "list" }); instance.actions.setTab("zp-market-default"); }');
  const items = /items: \[\{\s+value: INSTALLED_TAB,[\s\S]*?\}\)\)\]/g;
  const matches = [...text.matchAll(items)];
  if (matches.length !== 1) throw new Error("市场标签列表补丁未唯一命中，请核对 dsh 版本");
  const list = matches[0][0];
  const renamed = list.replace('label: item.label,', 'label: item.id === "discover" ? t("zpCompanyMarket") : item.id === "dsh-market" ? t("zpThirdPartyMarket") : item.label,');
  if (renamed === list) throw new Error("市场标签名称补丁未命中");
  replace(list, renamed + '.sort((a, b) => { const rank = (id) => id === "discover" ? 0 : id === "dsh-market" ? 1 : id === INSTALLED_TAB ? 3 : 2; return rank(a.value) - rank(b.value); })');
  replace('ctx.effect(() => ctx.locale.register(NS, {',
    `Object.assign(zh, ${JSON.stringify(marketLocales.zh)}); Object.assign(en, ${JSON.stringify(marketLocales.en)});\n\t\t\tctx.effect(() => ctx.locale.register(NS, {`);
  replace('"plugins.add.actions": {', '"plugins.company.create": { kind: "list", scope: "root" }, "plugins.add.actions": {');
  replace('label: () => t("panel"),', 'label: () => t("zpMarketPanel"),');
  replace('hidden: !onInstalled,', 'hidden: false,');
  const tools = '"data-plugin-toolbar": true,';
  replace(tools, tools + '\n"data-company-market-toolbar": true,');
  // Keep Installed controls native; the Creator action is shared across all three tabs.
  const start = text.indexOf('"data-company-market-toolbar": true,');
  const end = text.indexOf('tabs.length > 0 ?', start);
  const section = text.slice(start, end);
  const next = section.replace('children: [', 'children: [renderSlot("plugins.company.create"),').replace('updates === void 0 ? null :', '!onInstalled || updates === void 0 ? null :').replace('(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {', 'onInstalled && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {').replace('state.install.requestId === void 0 ?', '!onInstalled ? null : state.install.requestId === void 0 ?');
  if (section === next || end < 0) throw new Error("市场工具栏补丁未命中");
  replace(section, next);
  return marker + "\n" + text;
}

/**
 * 修补独立运行时文件，保留权限并断开 pnpm 硬链接。
 * @param {string} file ui-plugin-manager/lib/client.js 的路径。
 * @returns {void}
 */
export function patchMarketUiFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const next = patchMarketUi(text);
  if (text !== next) {
    // pnpm 的硬链接不能原地改写，避免影响其他安装。
    const mode = fs.statSync(file).mode;
    fs.unlinkSync(file);
    fs.writeFileSync(file, next, { mode });
    fs.chmodSync(file, mode);
  }
}

/**
 * Patch four pinned browser modules before runtime integrity records are generated.
 * @param {string} root Materialized runtime node_modules directory.
 * @returns {void}
 */
export function patchCompanyMarketRuntime(root) {
  const files = [
    ["ui-plugin-manager", patchMarketUi], ["ui-plugin-market", patchMarketCatalog],
    ["ui-entry-customization", patchMarketEntry], ["ui-sidebar", patchMarketSidebar],
  ];
  const changes = files.map(([name, patch]) => {
    const file = path.join(root, `@deepseek-ai/dsh-client-${name}/lib/client.js`);
    const before = fs.readFileSync(file, "utf8");
    return { file, before, after: patch(before), mode: fs.statSync(file).mode };
  });
  for (const { file, before, after, mode } of changes) {
    if (before === after) continue;
    fs.unlinkSync(file);
    fs.writeFileSync(file, after, { mode });
    fs.chmodSync(file, mode);
  }
}

/**
 * Keep native plugin pages after Market and Automation tasks in every locale.
 * @param {string} text Published sidebar browser module.
 * @returns {string} Patched module with native ordering and Chinese New Session copy.
 */
export function patchMarketSidebar(text) {
  const marker = "/* CRYSOUND market sidebar v1 */";
  if (text.includes(marker)) return text;
  const needle = 'const panels = usePanels((snapshot) => snapshot);';
  if (text.split(needle).length !== 2 || text.split('"session.new": "新会话"').length !== 2) throw new Error("市场侧栏补丁未唯一命中");
  return marker + "\n" + text.replace(needle, 'const panels = usePanels((snapshot) => snapshot).slice().sort((a, b) => { const rank = (id) => id === "plugins" ? 0 : id === "schedules" ? 1 : 2; return rank(a.id) - rank(b.id); });').replace('"session.new": "新会话"', '"session.new": "新对话"');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--runtime" && process.argv[3]) patchCompanyMarketRuntime(process.argv[3]);
  else if (process.argv[2]) patchMarketUiFile(process.argv[2]);
  else throw new Error("用法：patch-market-ui.mjs --runtime <运行时 node_modules>");
}
