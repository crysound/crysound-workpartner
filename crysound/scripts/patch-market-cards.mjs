// Shared browser helpers and CSS for the three pinned market surfaces.
import fs from 'node:fs';
import { marketLocales } from '../brand/market-locales.mjs';
const official = JSON.parse(fs.readFileSync(new URL('../config/plugins.json', import.meta.url), 'utf8')).officialPlugins;
const icons = Object.fromEntries(Object.entries(official).map(([name, value]) => [name, value.icon]));

/** Embed self-contained helpers in a released browser module, without runtime imports. */
export function marketCardHelpers() {
  return `const zpIcons = ${JSON.stringify(icons)};\nconst zpLocales = ${JSON.stringify(marketLocales)};\n${browserHelpers.toString()}\nconst { ZpIcon, ZpHeader, zpCopy } = browserHelpers(react, react_jsx_runtime, zpIcons, zpLocales);`;
}

function browserHelpers(React, { jsx, jsxs }, icons, locales) {
  function zpCopy(language) {
    return locales[String(language ?? document.documentElement.lang).startsWith('zh') ? 'zh' : 'en'];
  }
  function ZpIcon({ name, title, src }) {
    const image = icons[name] ?? src;
    const [failed, setFailed] = React.useState(null);
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return jsx('span', { className: 'zp-card-icon', 'aria-hidden': true,
      style: { backgroundColor: image && image !== failed ? "transparent" : ["#D97B48", "#BB626F", "#AC65A8", "#8B6B43", "#9B893A", "#5B984E", "#309C88"][hash % 7] },
      children: image && image !== failed ? jsx('img', { src: image, alt: '', referrerPolicy: 'no-referrer', onError: () => setFailed(image) })
        : Array.from(title.trim() || name)[0].toLocaleUpperCase(),
    });
  }
  function ZpHeader({ language, total, officialCount, active, onSelect, publishing = false }) {
    const copy = zpCopy(language);
    return jsxs('div', { className: 'zp-market-heading', children: [
      jsxs('div', { children: [jsx('h2', { children: copy.zpRecommended }), jsx('p', { children: document.documentElement.hasAttribute("data-platform") ? copy.zpInstallLocal : copy.zpInstallCloud }), publishing ? jsx('p', { 'data-company-publish-hint': true, children: copy.zpPublishHint }) : null] }),
      onSelect ? jsxs('div', { className: 'zp-market-segments', role: 'group', 'aria-label': copy.zpFilter,
        children: [[false, copy.zpAll, total], [true, copy.zpOfficial, officialCount]].map(([value, label, count]) => jsx('button', {
          type: 'button', 'aria-pressed': active === value, onClick: () => onSelect(value), children: `${label} ${count}`,
        }, String(value))) }) : total === undefined ? null : jsx("span", {className:"zp-market-segments",children:`${copy.zpThirdParty} ${total}`}),
    ] });
  }
  return { ZpIcon, ZpHeader, zpCopy };
}

/** Exactly two columns, with one column in narrow windows and narrow side panels. */
export const marketCardCss = `
[data-plugin-panel] { container-type: inline-size; --plugin-page-top-inset:16px; }
.zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { display:grid!important; grid-template-columns:repeat(2,minmax(0,1fr))!important; gap:20px!important; list-style:none; padding:0; margin:0; }
.zp-market-card { position:relative; box-sizing:border-box; min-width:0; padding:20px!important; border:1px solid var(--dsw-alias-border-l3,#dedee2)!important; border-radius:18px!important; background:var(--dsw-alias-bg-module-platform,#fafafa)!important; display:grid!important; grid-template-columns:64px minmax(0,1fr) auto; gap:0 16px!important; align-content:start; cursor:pointer; }
.zp-market-card:hover { border-color:var(--dsw-alias-label-tertiary,#a0a0a8)!important; }
.zp-card-icon { grid-column:1; grid-row:1/4; width:64px; height:64px; border-radius:15px; display:flex; align-items:center; justify-content:center; overflow:hidden; color:white; font-size:28px; font-weight:600; flex:none; }
.zp-card-icon img { width:100%; height:100%; object-fit:contain; }
.zp-card-title { grid-column:2/4; grid-row:1; min-width:0; display:flex; align-items:start; gap:10px; }
.zp-card-title button { font:inherit; font-size:16px; line-height:24px; font-weight:600; color:inherit; border:0; background:none; padding:0; text-align:start; cursor:pointer; overflow-wrap:anywhere; }
.zp-card-title .zp-card-chevron { margin-left:auto; flex:none; font-size:24px; font-weight:400; color:var(--dsw-alias-label-tertiary,#888); padding:0 0 0 8px; }
.zp-card-meta { grid-column:2/4; grid-row:2; color:var(--dsw-alias-label-tertiary,#888); font-size:12px; line-height:20px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; margin:2px 0 6px; }
.zp-card-description { grid-column:2; grid-row:3; color:var(--dsw-alias-label-secondary,#666); font-size:13px; line-height:20px; min-height:40px; max-height:40px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; margin:0; }
.zp-card-action { grid-column:3; grid-row:3; display:flex; align-items:center; justify-content:flex-end; gap:10px; align-self:center; margin:0; }
.zp-card-action button:not([role=switch]) { border:1px solid var(--dsw-alias-border-l3,#ccc)!important; border-radius:999px!important; padding:5px 14px!important; min-height:32px; background:transparent; color:inherit; cursor:pointer; }
.zp-native-action > span { display:inline-flex; border:1px solid var(--dsw-alias-border-l3,#ccc); border-radius:999px; padding:5px 14px; min-height:20px; }
.zp-market-card > .zp-card-extra { grid-column:1/-1; grid-row:4; }
.zp-market-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin:0 0 12px; }
.zp-market-heading h2 { font-size:26px; line-height:34px; font-weight:600; margin:0; }
.zp-market-heading p { font-size:12px; color:var(--dsw-alias-label-tertiary,#888); margin:3px 0 0; }
.zp-market-segments { border:1px solid var(--dsw-alias-border-l3,#ddd); border-radius:999px; padding:3px; display:flex; gap:3px; }
.zp-market-segments button { font:inherit; font-size:12px; color:inherit; padding:6px 13px; border:0; border-radius:999px; background:transparent; cursor:pointer; }
.zp-market-segments [aria-pressed=true] { background:var(--dsw-alias-interactive-bg-hover,#eee); }
.zp-market-card:focus-within { outline:2px solid var(--dsw-alias-label-secondary,#666); outline-offset:2px; }
[data-company-market-toolbar], [data-discover-toolbar] { flex-wrap:wrap; }
[data-plugin-bar] > header { gap:8px!important; }
[data-plugin-tab=discover] { gap:12px!important; }
@media(max-width:899px) { .zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { grid-template-columns:minmax(0,1fr)!important; } }
@container (max-width:650px) { .zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { grid-template-columns:minmax(0,1fr)!important; } }
@media(max-width:480px) { .zp-market-card { padding:18px!important; gap:0 14px!important; grid-template-columns:40px minmax(0,1fr) auto; } .zp-card-icon { width:40px; height:40px; border-radius:10px; } .zp-card-title button { font-size:16px; } }
`;

/** Patch the installed package cards; keep enable switches, errors and native details. */
export function patchInstalledCards(text) {
  const marker = '/* CRYSOUND installed cards v1 */';
  if (text.includes(marker)) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error('已安装卡片补丁未唯一命中');
    text = text.replace(needle, () => next);
  };
  replace('function CardHead(', marketCardHelpers() + '\nfunction CardHead(');
  const start = text.indexOf('function PackageCard('), end = text.indexOf('\n\t\t/**', start);
  let card = text.slice(start, end);
  const headStart = card.indexOf('(0, react_jsx_runtime.jsx)(CardHead, {');
  const headEnd = card.indexOf('(0, react_jsx_runtime.jsx)(MetadataError,', headStart);
  const oldHead = card.slice(headStart, headEnd);
  const switchStart = oldHead.indexOf('end: '), switchEnd = oldHead.lastIndexOf('\n\t\t\t\t\t}),');
  const enable = oldHead.slice(switchStart + 5, switchEnd).trim();
  const tagsStart = oldHead.indexOf('tags: '), tagsEnd = oldHead.indexOf('\n\t\t\t\t\t\tdescription,',tagsStart);
  if(tagsStart<0 || tagsEnd<0) throw new Error('已安装卡片状态标签未命中');
  const tags = oldHead.slice(tagsStart+6,tagsEnd).trim().replace(/,$/,'');
  if (!enable.includes('EnableSwitch')) throw new Error('已安装卡片开关补丁未命中');
  card = card.replace('"data-plugin-package": pkg.name,', '"data-plugin-package": pkg.name, "data-company-card": true, onClick: event => { if (!event.target.closest("button,a,input,[role=switch]")) onOpen(); },');
  card = card.replace('className: `${PluginManagerPage_module_css_default.card} ${PluginManagerPage_module_css_default.cardLink}`', 'className: "zp-market-card"');
  card = card.replace(oldHead, `(0, react_jsx_runtime.jsx)(ZpIcon, { name:pkg.name, title, src:pkg.meta?.icon }),
    (0, react_jsx_runtime.jsxs)("div", { className:"zp-card-title", children:[
      (0, react_jsx_runtime.jsx)("button", { type:"button", onClick:onOpen, children:title }),
      (0, react_jsx_runtime.jsx)("button", { type:"button", className:"zp-card-chevron", "aria-label":t("openDetail",{name:title}), onClick:onOpen, children:"›" })] }),
    (0, react_jsx_runtime.jsx)("div", { className:"zp-card-meta", children:[t(pkg.official || zpIcons[pkg.name] ? "zpOfficial" : "zpThirdParty"), zpIcons[pkg.name] ? t("zpCompanyAuthor") : t("zpUnknownAuthor")].filter(Boolean).join(" · ") }),
    (0, react_jsx_runtime.jsx)("div", { className:"zp-card-description", children:description }),
    (0, react_jsx_runtime.jsx)("div", {className:"zp-card-extra",children:${tags}}),
    (0, react_jsx_runtime.jsxs)("div", { className:"zp-card-action", children:[${enable}, (0, react_jsx_runtime.jsx)("button", {type:"button",onClick:onOpen,children:t("zpUse")})] }),
    `);
  replace(text.slice(start, end), card);
  const itemStart = text.indexOf('function ItemCard('), itemEnd = text.indexOf('\n\t\t/**',itemStart);
  replace(text.slice(itemStart,itemEnd), `function ItemCard({item,t,onOpen,renderSlot}) {
    return (0,react_jsx_runtime.jsxs)("li",{className:"zp-market-card","data-plugin-item":item.id,
      onClick:event=>{if(!event.target.closest("button,a,input")) onOpen();},children:[
      (0,react_jsx_runtime.jsx)("span",{className:"zp-card-icon","aria-hidden":true,children:itemArtwork(item.id)}),
      (0,react_jsx_runtime.jsxs)("div",{className:"zp-card-title",children:[
        (0,react_jsx_runtime.jsx)("button",{type:"button",onClick:onOpen,children:item.label}),
        (0,react_jsx_runtime.jsx)("button",{type:"button",className:"zp-card-chevron","aria-label":t("openDetail",{name:item.label}),onClick:onOpen,children:"›"})]}),
      (0,react_jsx_runtime.jsx)("div",{className:"zp-card-meta",children:[t("zpOfficial"),t("zpBuiltIn")].join(" · ")}),
      (0,react_jsx_runtime.jsx)("div",{className:"zp-card-description",children:renderSlot("plugins.item",{view:"summary"},{only:item.id})}),
      (0,react_jsx_runtime.jsx)("div",{className:"zp-card-action",children:(0,react_jsx_runtime.jsx)("button",{type:"button",onClick:onOpen,children:t("zpUse")})})]});
  }`);
  replace('const language = props.useLocale((snapshot) => snapshot.active);','const language = props.useLocale((snapshot) => snapshot.active); const [zpInstalledOfficial,zpSetInstalledOfficial] = (0,react.useState)(false);');
  replace('const renderGroup = (id, heading, cards) => {','const renderGroup = (id, heading, cards) => { if(zpInstalledOfficial) cards = cards.filter(card=>card.props.item || card.props.pkg.official || zpIcons[card.props.pkg.name]);');
  replace('children: [showsMoreList ?', `children: [(0, react_jsx_runtime.jsx)(ZpHeader, { language, total:basicCards.length+extensions.length+mine.length,
    officialCount:basicCards.length+[...extensions,...mine].filter(pkg=>pkg.official||zpIcons[pkg.name]).length,
    active:zpInstalledOfficial,onSelect:zpSetInstalledOfficial }), showsMoreList ?`);
  replace('function apply(ctx) {', `function apply(ctx) { Object.assign(zh,zpLocales.zh); Object.assign(en,zpLocales.en); ctx.effect(() => { const style=document.createElement("style"); style.textContent=${JSON.stringify(marketCardCss)}; document.head.append(style); return () => style.remove(); });`);
  return marker + '\n' + text;
}

/** Keep the third-party marketplace's complete original card in an accessible detail dialog. */
export function patchThirdPartyCards(text) {
  const marker = '/* CRYSOUND third-party cards v1 */';
  if (text.includes(marker)) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error('第三方卡片补丁未唯一命中');
    text = text.replace(needle, () => next);
  };
  replace('function Masonry({ items, render }) {','function Masonry({ items, render, companyCards }) {');
  replace('if (!wide) return /* @__PURE__ */', 'if (companyCards) return (0,react_jsx_runtime.jsx)("div",{className:"zp-card-grid",children:items.map(render)}); if (!wide) return /* @__PURE__ */');
  const render = 'render: (plugin) => pluginCard(plugin)';
  if (text.split(render).length !== 4) throw new Error('第三方卡片列表未完整命中');
  text = text.split(render).join('companyCards:true, ' + render);
  replace('function CardDesc(', marketCardHelpers() + `
  function ZpThirdPartyCard({ plugin, title, language, description, renderAction, original }) {
    const [opened, setOpened] = (0, react.useState)(false);
    const dialog = (0, react.useRef)(null);
    const titleId = (0, react.useId)();
    const copy = zpCopy(language);
    (0, react.useEffect)(() => {
      if (opened) dialog.current.showModal();
    }, [opened]);
    const statistic = downloadStatistic(plugin);
    const meta = [copy.zpThirdParty, plugin.owner || copy.zpUnknownAuthor,
      statistic ? copy.zpDownloadCount.replace("{count}", new Intl.NumberFormat(language).format(statistic.count)) : null].filter(Boolean).join(" · ");
    return (0, react_jsx_runtime.jsxs)("div", { className:"zp-market-card", "data-third-party-entry":plugin.url,
      onClick:event => { if (!event.target.closest("button,a,input,dialog")) setOpened(true); }, children:[
      (0, react_jsx_runtime.jsx)(ZpIcon,{name:plugin.name,title,src:plugin.icon}),
      (0, react_jsx_runtime.jsxs)("div",{className:"zp-card-title",children:[
        (0, react_jsx_runtime.jsx)("button",{type:"button",onClick:()=>setOpened(true),children:title}),
        (0, react_jsx_runtime.jsx)("button",{type:"button",className:"zp-card-chevron","aria-label":title,onClick:()=>setOpened(true),children:"›"})]}),
      (0, react_jsx_runtime.jsx)("div",{className:"zp-card-meta",title:meta,children:meta}),
      (0, react_jsx_runtime.jsx)("div",{className:"zp-card-description",children:description}),
      (0, react_jsx_runtime.jsx)("div",{className:"zp-card-action",children:(0,react_jsx_runtime.jsx)("span",{className:"zp-native-action",children:renderAction()})}),
      opened ? (0, react_jsx_runtime.jsxs)("dialog",{ref:dialog,className:"zp-market-dialog","aria-labelledby":titleId,
        onCancel:()=>setOpened(false),onClose:()=>setOpened(false),children:[
        (0, react_jsx_runtime.jsx)("h2",{id:titleId,children:title}),
        (0, react_jsx_runtime.jsx)("button",{type:"button",autoFocus:true,onClick:()=>setOpened(false),children:copy.zpClose}),original]}) : null
    ]});
  }
  function CardDesc(`);
  const start = text.indexOf('const pluginCard = (p, menuKey = p.url) => {');
  const end = text.indexOf('\n\t\t\tconst installedNameOf', start);
  if (start < 0 || end < 0) throw new Error('第三方卡片组件未命中');
  let card = text.slice(start, end);
  card = card.replace('return /* @__PURE__ */', 'const original = /* @__PURE__ */');
  const tail = card.lastIndexOf('\n\t\t\t};');
  card = card.slice(0, tail) + `
    return (0, react_jsx_runtime.jsx)(ZpThirdPartyCard, {plugin:p,title:pluginName(p.name,p.npm),language:lang,description:desc,renderAction:()=>installAction(p),original},p.url);
` + card.slice(tail);
  replace(text.slice(start, end), card);
  replace('"data-dsh-market-fullscreen": tab === "themes" && themesFullscreen ? "true" : void 0,\n\t\t\t\tchildren: [',
    '"data-dsh-market-fullscreen": tab === "themes" && themesFullscreen ? "true" : void 0,\nchildren: [(0, react_jsx_runtime.jsx)("style",{children:' + JSON.stringify(marketCardCss + '\n.zp-market-dialog { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l3); border-radius:18px; max-width:min(760px,90vw); max-height:80vh; padding:24px; } .zp-market-dialog::backdrop { background:#0006; }') + '}), tab === "discover" ? (0, react_jsx_runtime.jsx)(ZpHeader,{language:lang,total:plugins.length}) : null,');
  return marker + '\n' + text;
}
