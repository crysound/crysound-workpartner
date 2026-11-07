import { marketCardHelpers } from "./patch-market-cards.mjs";
import { marketLocales } from "../brand/market-locales.mjs";
// Reuse native search, filtering, installation and cards; only the company Discover tab changes.
/**
 * Patch only the pinned company Discover module.
 * @param {string} text Published browser module.
 * @returns {string} Patched module, or unchanged bytes on a repeat run.
 */
export function patchMarketCatalog(text) {
  const marker = "/* CRYSOUND market catalog v3 */";
  if (text.includes(marker)) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error("市场卡片补丁未唯一命中");
    text = text.replace(needle, () => next);
  };
  if (text.includes("/* CRYSOUND market catalog v2 */")) {
    replace('count === undefined ? null : t("zpDownloadCount", { count: new Intl.NumberFormat(language).format(count) })',
      'count > 0 ? t("zpDownloadCount", { count: new Intl.NumberFormat(language).format(count) }) : null');
    return text.replace("/* CRYSOUND market catalog v2 */", marker);
  }
  replace('ctx.effect(() => ctx.locale.register(NS, {', `Object.assign(zh, ${JSON.stringify(marketLocales.zh)}); Object.assign(en, ${JSON.stringify(marketLocales.en)});
ctx.effect(() => ctx.locale.register(NS, {`);
  replace('const { status } = entry.installation;', `const { status } = entry.installation;
    const nativeT = t;
    t = (key, params) => ["statusUpdate", "statusProvided", "statusInstalled", "openInstalled"].includes(key)
      ? nativeT("zpUse") + (params?.name ? ": " + params.name : "") : nativeT(key, params);`);
  const cardStart = text.indexOf('function EntryCard(');
  const cardEnd = text.indexOf('\n\t\t/**', cardStart);
  if (cardStart < 0 || cardEnd < 0) throw new Error("市场卡片组件未命中");
  replace(text.slice(cardStart, cardEnd), marketCardHelpers() + `
  function EntryCard({ entry, t, face, language, onOpen, onInstall, onOpenInstalled }) {
    const title = entryTitle(entry, face);
    const count = entry.metadata.sortKeys["crysound-installs"];
    const meta = [t(entry.metadata.labels.includes("crysound-official") ? "zpOfficial" : "zpThirdParty"),
      entry.author || t("zpUnknownAuthor"), count > 0 ? t("zpDownloadCount", { count: new Intl.NumberFormat(language).format(count) }) : null].filter(Boolean).join(" · ");
    return (0, react_jsx_runtime.jsxs)("li", { className: "zp-market-card", "data-market-entry": entry.name,
      onClick: event => { if (!event.target.closest("button,a,input")) onOpen(); }, children: [
      (0, react_jsx_runtime.jsx)(ZpIcon, { name: entry.name, title, src: entry.icon }),
      (0, react_jsx_runtime.jsxs)("div", { className: "zp-card-title", children: [
        (0, react_jsx_runtime.jsx)("button", { type:"button", onClick:onOpen, children:title }),
        (0, react_jsx_runtime.jsx)("button", { type:"button", className:"zp-card-chevron", "aria-label":t("openEntry", {name:title}), onClick:onOpen, children:"›" })] }),
      (0, react_jsx_runtime.jsx)("div", { className:"zp-card-meta", title:meta, children:meta }),
      (0, react_jsx_runtime.jsx)("div", { className:"zp-card-description", children:entry.description === undefined ? "" : face.resolveText(entry.description) }),
      (0, react_jsx_runtime.jsx)("div", { className:"zp-card-action", children:(0, react_jsx_runtime.jsx)(EntryAction,{entry,title,t,onInstall,onOpenInstalled}) })
    ] });
  }`);
  // Native index order is official first, then newest; search and category filters remain server-owned.
  const listStart = text.indexOf('(0, react_jsx_runtime.jsx)("ul", {\n\t\t\t\t\tclassName: DiscoverSection_module_css_default.cards,\n\t\t\t\t\t"aria-busy": busy,');
  const listEnd = text.indexOf('}), value.nextOffset === null', listStart);
  if (listStart < 0 || listEnd < 0) throw new Error("市场分区列表补丁未命中");
  const original = text.slice(listStart, listEnd + 2);
  const listCardStart = original.indexOf('value.entries.map(');
  if (listCardStart < 0) throw new Error("市场原生卡片补丁未命中");
  replace(original, original.replace('value.entries.map(', 'value.entries.filter(entry => !zpOnlyOfficial || entry.metadata.labels.includes("crysound-official")).map(')
    .replace('className: DiscoverSection_module_css_default.cards,', 'className: "zp-card-grid",'));
  replace('const { query, value } = listing;', `const { query, value } = listing;
    const [zpOnlyOfficial, zpSetOfficial] = (0, react.useState)(false);`);
  const toolbar = '(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tclassName: DiscoverSection_module_css_default.toolbar,';
  replace(toolbar, toolbar.replace('children: [', `children: [(0, react_jsx_runtime.jsx)(ZpHeader, { language, total:value?.entries.length ?? 0,
    officialCount:value?.entries.filter(entry => entry.metadata.labels.includes("crysound-official")).length ?? 0,
    active:zpOnlyOfficial,onSelect:zpSetOfficial }),`));
  // Maintenance declarations are display metadata, not an end-user filter.
  replace('items: declarations.labels.map((item) => ({', 'items: declarations.labels.filter((item) => !item.id.startsWith("crysound-maintainer:")).map((item) => ({');
  return marker + "\n" + text;
}
