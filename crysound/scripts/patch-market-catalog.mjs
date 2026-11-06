// Reuse native search, filtering, installation and cards; only the company Discover tab changes.
/**
 * Patch only the pinned company Discover module.
 * @param {string} text Published browser module.
 * @returns {string} Patched module, or unchanged bytes on a repeat run.
 */
export function patchMarketCatalog(text) {
  const marker = "/* CRYSOUND market catalog v1 */";
  if (text.includes(marker)) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error("市场卡片补丁未唯一命中");
    text = text.replace(needle, () => next);
  };
  replace('ctx.effect(() => ctx.locale.register(NS, {', `Object.assign(zh, { zpOfficial: "兆华官方", zpAll: "全部插件", zpUse: "使用" });
    Object.assign(en, { zpOfficial: "CRYSOUND official", zpAll: "All plugins", zpUse: "Use" });
    ctx.effect(() => ctx.locale.register(NS, {`);
  replace('const { status } = entry.installation;', `const { status } = entry.installation;
    const nativeT = t;
    t = (key, params) => ["statusUpdate", "statusProvided", "statusInstalled", "openInstalled"].includes(key)
      ? nativeT("zpUse") + (params?.name ? ": " + params.name : "") : nativeT(key, params);`);
  replace('"data-market-entry": entry.name,', '"data-market-entry": entry.name, "data-company-official": entry.metadata.labels.includes("crysound-official") || undefined,');
  replace('labels.filter((label) => entry.metadata.labels.includes(label.id)).map(',
    'labels.filter((label) => !label.id.startsWith("crysound-maintainer:") && entry.metadata.labels.includes(label.id)).map(');
  // Add native declared maintenance/category text beside the original author/version/date metadata.
  const meta = 'children: entry.author === void 0 ? t("entryMeta", {';
  replace(meta, 'children: [labels.filter((label) => label.id.startsWith("crysound-maintainer:") && entry.metadata.labels.includes(label.id)).map((label) => label.title).join(" · "), face.companyCategory(entry), entry.author === void 0 ? t("entryMeta", {');
  const finish = 'author: entry.author,\n\t\t\t\t\t\t\t\t\tdate\n\t\t\t\t\t\t\t\t})';
  replace(finish, finish + '].filter(Boolean).join(" · ")');
  // Native index order is official first, then newest; search and category filters remain server-owned.
  const listStart = text.indexOf('(0, react_jsx_runtime.jsx)("ul", {\n\t\t\t\t\tclassName: DiscoverSection_module_css_default.cards,\n\t\t\t\t\t"aria-busy": busy,');
  const listEnd = text.indexOf('}), value.nextOffset === null', listStart);
  if (listStart < 0 || listEnd < 0) throw new Error("市场分区列表补丁未命中");
  const original = text.slice(listStart, listEnd + 2);
  const cardStart = original.indexOf('value.entries.map(');
  if (cardStart < 0) throw new Error("市场原生卡片补丁未命中");
  const grouped = original.replace('value.entries.map(', 'value.entries.filter((entry) => entry.metadata.labels.includes("crysound-official") === official).map(')
    .replace('className: DiscoverSection_module_css_default.cards,', 'className: DiscoverSection_module_css_default.cards + (official ? " zp-official-cards" : ""),');
  replace(original, `[true, false].map((official) => (0, react_jsx_runtime.jsxs)("section", {
    className: "zp-market-group", "data-company-market-group": official ? "official" : "all",
    children: [(0, react_jsx_runtime.jsx)("h3", { children: t(official ? "zpOfficial" : "zpAll") }), ${grouped}]
  }, String(official)))`);
  replace('const { query, value } = listing;', `const { query, value } = listing;
    face = { ...face, companyCategory: (entry) => {
      const category = value?.metadata.categories[entry.metadata.category];
      return category === undefined ? "" : face.resolveText(category.title);
    } };`);
  // Maintenance declarations are display metadata, not an end-user filter.
  replace('items: declarations.labels.map((item) => ({', 'items: declarations.labels.filter((item) => !item.id.startsWith("crysound-maintainer:")).map((item) => ({');
  replace('function apply(ctx) {', `function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(catalogCss)};
      document.head.appendChild(style);
      return () => style.remove();
    }, "CRYSOUND market card styles");`);
  return marker + "\n" + text;
}

const catalogCss = `
.zp-market-group { min-width: 0; margin-block: 12px 24px; }
.zp-market-group h3 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
.zp-official-cards { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 16px !important; }
[data-company-official] { background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l3); border-radius: 16px; padding: 20px !important; align-items: start !important; flex-wrap: wrap; margin: 0 !important; }
[data-company-official] > span { display: none; }
[data-company-official] > span:has(img) { display: flex; width: 100%; height: 140px; border: 0; border-radius: 8px; overflow: hidden; }
[data-company-official] > span img { width: 100%; height: 100%; object-fit: contain; }
[data-company-official] > div:first-of-type { flex-basis: 100%; }
[data-company-official] > div:last-of-type { margin-top: 12px; margin-left: auto; }
[data-company-official] [class*=description] { -webkit-line-clamp: 2; }
[data-company-market-toolbar] { flex-wrap: wrap; }
`;
