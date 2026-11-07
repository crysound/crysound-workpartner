// 第三方插件的本地修补，每次启动时由 entrypoint 运行。每条写明文件、原文和替换文；已打过的跳过，原文找不到就提示（多半是插件升级了，该条要重看）。
// 用法：node plugin-patches.mjs <插件安装目录，即 profiles/web/node_modules>
import fs from "node:fs";
import path from "node:path";

// BEGIN generated market cards
function patchThirdPartyCards(text) {
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
  replace('function CardDesc(', "const zpIcons = {\"@crysound/design\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImRlc2lnbi1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIHN0b3AtY29sb3I9IiNGMjlBNTciLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNERjYwM0QiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNkZXNpZ24tYmcpIi8+PHBhdGggZD0ibTE5IDM0IDIwLTIwYTQgNCAwIDAgMSA2IDBsNSA1YTQgNCAwIDAgMSAwIDZMMzAgNDVsLTE1IDV6IiBmaWxsPSJ3aGl0ZSIvPjxwYXRoIGQ9Im0zNiAxOSA5IDlNMTkgMzVsMTAgMTAiIHN0cm9rZT0iI0Q2NUIzOCIgc3Ryb2tlLXdpZHRoPSI0Ii8+PC9zdmc+\",\"@crysound/motion\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9Im1vdGlvbi1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIHN0b3AtY29sb3I9IiNGMjkyQjEiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNEQzUxODciLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNtb3Rpb24tYmcpIi8+PHBhdGggZD0iTTI1IDE2YTMgMyAwIDAgMC01IDN2MjZhMyAzIDAgMCAwIDUgM2wyMy0xM2EzLjUgMy41IDAgMCAwIDAtNnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+\",\"@crysound/artifacts\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImFydGlmYWN0cy1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIHN0b3AtY29sb3I9IiNFOTg4NzYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNDOTUzNEIiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNhcnRpZmFjdHMtYmcpIi8+PHBhdGggZD0iTTIyIDE4di0zYTQgNCAwIDAgMSA0LTRoMTJhNCA0IDAgMCAxIDQgNHYzaC01di0ySDI3djJ6TTEzIDMzaDM4djE0YTQgNCAwIDAgMS00IDRIMTdhNCA0IDAgMCAxLTQtNHoiIGZpbGw9IndoaXRlIi8+PHJlY3QgeD0iMTIiIHk9IjIxIiB3aWR0aD0iNDAiIGhlaWdodD0iOSIgcng9IjMiIGZpbGw9IndoaXRlIi8+PHJlY3QgeD0iMjgiIHk9IjI4IiB3aWR0aD0iOCIgaGVpZ2h0PSIxMCIgcng9IjIiIGZpbGw9IiNEMzY0NTciLz48L3N2Zz4=\",\"@crysound/design-system\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImRlc2lnbi1zeXN0ZW0tYmciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBzdG9wLWNvbG9yPSIjRDg5M0Q4Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjQUE1MEI3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9InVybCgjZGVzaWduLXN5c3RlbS1iZykiLz48cmVjdCB4PSIxNCIgeT0iMTQiIHdpZHRoPSIxNSIgaGVpZ2h0PSIxNSIgcng9IjQiIGZpbGw9IndoaXRlIi8+PGNpcmNsZSBjeD0iNDIuNSIgY3k9IjIxLjUiIHI9IjcuNSIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJtMjEuNSAzNCA5IDE2aC0xOHoiIGZpbGw9IndoaXRlIi8+PHJlY3QgeD0iMzUiIHk9IjM1IiB3aWR0aD0iMTUiIGhlaWdodD0iMTUiIHJ4PSI0IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==\",\"@crysound/slides\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9InNsaWRlcy1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIHN0b3AtY29sb3I9IiNFREM4NUIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNDRjk0MjciLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNzbGlkZXMtYmcpIi8+PHJlY3QgeD0iMTIiIHk9IjE0IiB3aWR0aD0iNDAiIGhlaWdodD0iMzEiIHJ4PSI1IiBmaWxsPSJ3aGl0ZSIvPjxwYXRoIGQ9Ik0zMiA0NXY4bTAtNy0xMCA3bTEwLTcgMTAgNyIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cmVjdCB4PSIxOSIgeT0iMjIiIHdpZHRoPSIyNSIgaGVpZ2h0PSI0IiByeD0iMiIgZmlsbD0iI0Q2QTEzMyIvPjxyZWN0IHg9IjE5IiB5PSIzMSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjRDZBMTMzIi8+PC9zdmc+\",\"@crysound/dashboard\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImRhc2hib2FyZC1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIHN0b3AtY29sb3I9IiM5NEM5NkEiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM1NTlENDkiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNkYXNoYm9hcmQtYmcpIi8+PHJlY3QgeD0iMTMiIHk9IjE0IiB3aWR0aD0iMzgiIGhlaWdodD0iMzYiIHJ4PSI2IiBmaWxsPSJ3aGl0ZSIvPjxyZWN0IHg9IjIwIiB5PSIzMCIgd2lkdGg9IjUiIGhlaWdodD0iMTMiIHJ4PSIyIiBmaWxsPSIjNjhBQTUyIi8+PHJlY3QgeD0iMjkuNSIgeT0iMjEiIHdpZHRoPSI1IiBoZWlnaHQ9IjIyIiByeD0iMiIgZmlsbD0iIzY4QUE1MiIvPjxyZWN0IHg9IjM5IiB5PSIyNiIgd2lkdGg9IjUiIGhlaWdodD0iMTciIHJ4PSIyIiBmaWxsPSIjNjhBQTUyIi8+PC9zdmc+\",\"@crysound/data\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImRhdGEtYmciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBzdG9wLWNvbG9yPSIjNTlDNkIyIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMjc5Qjg3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9InVybCgjZGF0YS1iZykiLz48cGF0aCBkPSJNMTUgMjJjMyA3IDMxIDcgMzQgMHYxMGMtMyA4LTMxIDgtMzQgMHptMCAxNGMzIDcgMzEgNyAzNCAwdjEwYzAgOS0zNCA5LTM0IDB6IiBmaWxsPSJ3aGl0ZSIvPjxlbGxpcHNlIGN4PSIzMiIgY3k9IjE3IiByeD0iMTciIHJ5PSI3IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==\",\"@crysound/image\":\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImltYWdlLWJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agc3RvcC1jb2xvcj0iI0M0OUFFNCIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzkzNTZCQSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjE1IiBmaWxsPSJ1cmwoI2ltYWdlLWJnKSIvPjxyZWN0IHg9IjEyIiB5PSIxMyIgd2lkdGg9IjQwIiBoZWlnaHQ9IjM4IiByeD0iNiIgZmlsbD0id2hpdGUiLz48Y2lyY2xlIGN4PSI0MCIgY3k9IjI0IiByPSI1IiBmaWxsPSIjQTU2Q0M4Ii8+PHBhdGggZD0ibTE2IDQ0IDExLTE0IDkgMTEgNS02IDcgOXYzSDE2eiIgZmlsbD0iI0E1NkNDOCIvPjwvc3ZnPg==\"};\nconst zpLocales = {\"zh\":{\"zpCompanyMarket\":\"兆华市场\",\"zpThirdPartyMarket\":\"第三方\",\"zpMarketPanel\":\"市场\",\"zpRecommended\":\"推荐\",\"zpAll\":\"全部\",\"zpOfficial\":\"官方\",\"zpThirdParty\":\"第三方\",\"zpUse\":\"使用\",\"zpInstallLocal\":\"安装到：当前电脑\",\"zpInstallCloud\":\"安装到：我的工作伙伴\",\"zpFilter\":\"筛选插件\",\"zpPublishHint\":\"自己做的插件，对工作伙伴说‘发布到兆华市场’，管理员批准后全公司都能装。\",\"zpUnknownAuthor\":\"未提供作者\",\"zpDownloadCount\":\"{count} 次下载\",\"zpClose\":\"关闭详情\",\"zpCompanyAuthor\":\"兆华工作伙伴\",\"zpBuiltIn\":\"内置插件\"},\"en\":{\"zpCompanyMarket\":\"CRYSOUND market\",\"zpThirdPartyMarket\":\"Third-party\",\"zpMarketPanel\":\"Market\",\"zpRecommended\":\"Recommended\",\"zpAll\":\"All\",\"zpOfficial\":\"Official\",\"zpThirdParty\":\"Third-party\",\"zpUse\":\"Use\",\"zpInstallLocal\":\"Install to: This computer\",\"zpInstallCloud\":\"Install to: My WorkPartner\",\"zpFilter\":\"Filter plugins\",\"zpPublishHint\":\"Share your own plugin: tell WorkPartner ‘publish to CRYSOUND market’; everyone can install it after admin approval.\",\"zpUnknownAuthor\":\"Author unavailable\",\"zpDownloadCount\":\"{count} downloads\",\"zpClose\":\"Close details\",\"zpCompanyAuthor\":\"CRYSOUND WorkPartner\",\"zpBuiltIn\":\"Built-in plugin\"}};\nfunction browserHelpers(React, { jsx, jsxs }, icons, locales) {\n  function zpCopy(language) {\n    return locales[String(language ?? document.documentElement.lang).startsWith('zh') ? 'zh' : 'en'];\n  }\n  function ZpIcon({ name, title, src }) {\n    const image = icons[name] ?? src;\n    const [failed, setFailed] = React.useState(null);\n    let hash = 0;\n    for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;\n    return jsx('span', { className: 'zp-card-icon', 'aria-hidden': true,\n      style: { backgroundColor: image && image !== failed ? \"transparent\" : [\"#D97B48\", \"#BB626F\", \"#AC65A8\", \"#8B6B43\", \"#9B893A\", \"#5B984E\", \"#309C88\"][hash % 7] },\n      children: image && image !== failed ? jsx('img', { src: image, alt: '', referrerPolicy: 'no-referrer', onError: () => setFailed(image) })\n        : Array.from(title.trim() || name)[0].toLocaleUpperCase(),\n    });\n  }\n  function ZpHeader({ language, total, officialCount, active, onSelect, publishing = false }) {\n    const copy = zpCopy(language);\n    return jsxs('div', { className: 'zp-market-heading', children: [\n      jsxs('div', { children: [jsx('h2', { children: copy.zpRecommended }), jsx('p', { children: document.documentElement.hasAttribute(\"data-platform\") ? copy.zpInstallLocal : copy.zpInstallCloud }), publishing ? jsx('p', { 'data-company-publish-hint': true, children: copy.zpPublishHint }) : null] }),\n      onSelect ? jsxs('div', { className: 'zp-market-segments', role: 'group', 'aria-label': copy.zpFilter,\n        children: [[false, copy.zpAll, total], [true, copy.zpOfficial, officialCount]].map(([value, label, count]) => jsx('button', {\n          type: 'button', 'aria-pressed': active === value, onClick: () => onSelect(value), children: `${label} ${count}`,\n        }, String(value))) }) : total === undefined ? null : jsx(\"span\", {className:\"zp-market-segments\",children:`${copy.zpThirdParty} ${total}`}),\n    ] });\n  }\n  return { ZpIcon, ZpHeader, zpCopy };\n}\nconst { ZpIcon, ZpHeader, zpCopy } = browserHelpers(react, react_jsx_runtime, zpIcons, zpLocales);" + `
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
    '"data-dsh-market-fullscreen": tab === "themes" && themesFullscreen ? "true" : void 0,\nchildren: [(0, react_jsx_runtime.jsx)("style",{children:' + JSON.stringify("\n[data-plugin-panel] { container-type: inline-size; --plugin-page-top-inset:16px; }\n.zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { display:grid!important; grid-template-columns:repeat(2,minmax(0,1fr))!important; gap:20px!important; list-style:none; padding:0; margin:0; }\n.zp-market-card { position:relative; box-sizing:border-box; min-width:0; padding:20px!important; border:1px solid var(--dsw-alias-border-l3,#dedee2)!important; border-radius:18px!important; background:var(--dsw-alias-bg-module-platform,#fafafa)!important; display:grid!important; grid-template-columns:64px minmax(0,1fr) auto; gap:0 16px!important; align-content:start; cursor:pointer; }\n.zp-market-card:hover { border-color:var(--dsw-alias-label-tertiary,#a0a0a8)!important; }\n.zp-card-icon { grid-column:1; grid-row:1/4; width:64px; height:64px; border-radius:15px; display:flex; align-items:center; justify-content:center; overflow:hidden; color:white; font-size:28px; font-weight:600; flex:none; }\n.zp-card-icon img { width:100%; height:100%; object-fit:contain; }\n.zp-card-title { grid-column:2/4; grid-row:1; min-width:0; display:flex; align-items:start; gap:10px; }\n.zp-card-title button { font:inherit; font-size:16px; line-height:24px; font-weight:600; color:inherit; border:0; background:none; padding:0; text-align:start; cursor:pointer; overflow-wrap:anywhere; }\n.zp-card-title .zp-card-chevron { margin-left:auto; flex:none; font-size:24px; font-weight:400; color:var(--dsw-alias-label-tertiary,#888); padding:0 0 0 8px; }\n.zp-card-meta { grid-column:2/4; grid-row:2; color:var(--dsw-alias-label-tertiary,#888); font-size:12px; line-height:20px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; margin:2px 0 6px; }\n.zp-card-description { grid-column:2; grid-row:3; color:var(--dsw-alias-label-secondary,#666); font-size:13px; line-height:20px; min-height:40px; max-height:40px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; margin:0; }\n.zp-card-action { grid-column:3; grid-row:3; display:flex; align-items:center; justify-content:flex-end; gap:10px; align-self:center; margin:0; }\n.zp-card-action button:not([role=switch]) { border:1px solid var(--dsw-alias-border-l3,#ccc)!important; border-radius:999px!important; padding:5px 14px!important; min-height:32px; background:transparent; color:inherit; cursor:pointer; }\n.zp-native-action > span { display:inline-flex; border:1px solid var(--dsw-alias-border-l3,#ccc); border-radius:999px; padding:5px 14px; min-height:20px; }\n.zp-market-card > .zp-card-extra { grid-column:1/-1; grid-row:4; }\n.zp-market-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin:0 0 12px; }\n.zp-market-heading h2 { font-size:26px; line-height:34px; font-weight:600; margin:0; }\n.zp-market-heading p { font-size:12px; color:var(--dsw-alias-label-tertiary,#888); margin:3px 0 0; }\n.zp-market-segments { border:1px solid var(--dsw-alias-border-l3,#ddd); border-radius:999px; padding:3px; display:flex; gap:3px; }\n.zp-market-segments button { font:inherit; font-size:12px; color:inherit; padding:6px 13px; border:0; border-radius:999px; background:transparent; cursor:pointer; }\n.zp-market-segments [aria-pressed=true] { background:var(--dsw-alias-interactive-bg-hover,#eee); }\n.zp-market-card:focus-within { outline:2px solid var(--dsw-alias-label-secondary,#666); outline-offset:2px; }\n[data-company-market-toolbar], [data-discover-toolbar] { flex-wrap:wrap; }\n[data-plugin-bar] > header { gap:8px!important; }\n[data-plugin-tab=discover] { gap:12px!important; }\n@media(max-width:899px) { .zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { grid-template-columns:minmax(0,1fr)!important; } }\n@container (max-width:650px) { .zp-card-grid, [data-plugin-group] > ul:has(.zp-market-card), [data-dsh-market-root] [class*=_grid]:has(.zp-market-card) { grid-template-columns:minmax(0,1fr)!important; } }\n@media(max-width:480px) { .zp-market-card { padding:18px!important; gap:0 14px!important; grid-template-columns:40px minmax(0,1fr) auto; } .zp-card-icon { width:40px; height:40px; border-radius:10px; } .zp-card-title button { font-size:16px; } }\n" + '\n.zp-market-dialog { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l3); border-radius:18px; max-width:min(760px,90vw); max-height:80vh; padding:24px; } .zp-market-dialog::backdrop { background:#0006; }') + '}), tab === "discover" ? (0, react_jsx_runtime.jsx)(ZpHeader,{language:lang,total:plugins.length}) : null,');
  return marker + '\n' + text;
}
// END generated market cards

// A DOM event connects the company adapter to released plugin code without global mutable state.
const PREVIEW_URL = `function zpPreviewUrl(value) {
  if (typeof document === "undefined") return value;
  const detail = { url: value };
  document.dispatchEvent(new CustomEvent("zp-preview-url", { detail }));
  return detail.url;
}`;
const PREVIEW_CLICKS = `
  ctx.effect(() => {
    const follow = (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      const source = anchor.dataset.zpPreviewSource || anchor.href;
      const url = zpPreviewUrl(source);
      if (url === source) return;
      anchor.dataset.zpPreviewSource = source;
      anchor.href = url;
      if (event.type !== "click" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = ctx.sidebarRight.commandTarget(anchor);
      if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation();
      ctx.sidebarRight.openTabIn(target.sessionId, "browser", { params: { url } });
    };
    for (const type of ["click", "pointerdown", "contextmenu", "auxclick"]) document.addEventListener(type, follow, true);
    return () => { for (const type of ["click", "pointerdown", "contextmenu", "auxclick"]) document.removeEventListener(type, follow, true); };
  }, "crysound.preview-links");
`;

/**
 * Replace dshmarket 1.73.12's DOM/CSS icon adapter with the native settings slot.
 * @param {string} text Released client module, including previously patched copies.
 * @returns {string} Idempotently patched module; rejects an unsupported layout.
 */
export function patchMarketSettingsIcon(text) {
  const marker = '/* CRYSOUND market settings icon v1 */';
  if (text.includes(marker)) return text;
  const call = 'installSettingsNavIcon(ctx, () => t("nav"));';
  const region = /\/\/#region src\/client\/settings-nav-icon\.ts[\s\S]*?\/\/#endregion/g;
  if (text.split(call).length !== 2 || [...text.matchAll(region)].length !== 1 || !text.includes('function MarketLogo(')) {
    throw new Error('市场设置图标补丁未唯一命中，请核对 dshmarket 版本');
  }
  return marker + '\n' + text.replace(region, '').replace(call,
    'ctx.slots.inject("settings.section.icon", () => ctx.slots.register({ name: "settings.section.icon", id: "market" }, MarketLogo));');
}

/**
 * Patch the released company Artifacts page without changing editors or stored artifacts.
 * @param {string} text Artifacts 1.0.0 client, including the page-title patch.
 * @returns {string} Idempotently patched client; rejects a changed release layout.
 */
export function patchArtifactOpening(text) {
  const marker = '/* CRYSOUND artifact opening v1 */';
  if (text.includes(marker)) return text;
  const replace = (find, value) => {
    if (text.split(find).length !== 2) throw new Error('作品打开补丁未唯一命中，请核对插件版本');
    text = text.replace(find, value);
  };
  // Prefer the repaired shared page even if a companion creation plugin loads first.
  replace('var PAGE_VERSION = 6;', 'var PAGE_VERSION = 7;');
  const start = 'if (!ownPluginThere(view)) return;\n\t\t    store.set({ opening: view.root, toast: null });';
  replace(start, `if (!ownPluginThere(view)) return;
    const newTab = ctx.get("configForms").get("ui-chat").getSnapshot().value?.linkOpening === "new-tab";
    const desktop = globalThis.dshDesktop?.protocolVersion === 1;
    const browserTab = newTab && !desktop ? window.open("about:blank", "_blank") : null;
    if (newTab && !desktop && !browserTab) { toast(t("open.popupBlocked"), "error"); return; }
    if (browserTab) browserTab.opener = null;
    store.set({ opening: view.root, toast: null });`);
  const block = text.match(/const url = body\.url;[\s\S]*?\n\s*reload\(\);/g);
  if (block?.length !== 1) throw new Error('作品打开补丁未唯一命中，请核对插件版本');
  replace(block[0], `const url = zpPreviewUrl(body.url);
        const address = new URL(url);
        if (!desktop && address.protocol === "http:" && ["127.0.0.1", "localhost"].includes(address.hostname)) throw new Error(t("open.noPreview"));
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : view.sessionId;
        const sessions = ctx.get("sessions");
        const workspaces = ctx.get("workspaces");
        const workspace = ctx.get("uiWorkspace");
        const sidebar = ctx.get("sidebarRight");
        const tabs = ctx.get("sidebarRightTabs");
        const listed = sessions?.list.getSnapshot();
        const state = linkState(sessionId, listed, workspaces?.list.getSnapshot());
        if (newTab) {
          if (browserTab) browserTab.location.replace(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        } else {
          if (!workspace || !sidebar || !tabs?.get("browser")) throw new Error(t("open.noBrowser"));
          let target = state === "available" ? sessionId : Object.values(listed?.byId ?? {})
            .find((item) => (item.retainedBy.mainView ?? 0) > 0)?.id;
          if (!target) target = await sessions.create();
          workspace.openSession(target);
          if (!await openInSidebar(sidebar, target, url)) throw new Error(t("open.noBrowser"));
        }
        store.set({ opening: null });
        if (state === "archived") {
          const action = typeof workspace?.unarchiveSession === "function" ? {
            label: t("open.restore"),
            run: () => {
              archiveNotice.set({ toast: null });
              workspace.unarchiveSession(sessionId).then(() => workspace.openSession(sessionId)).catch((error) => {
                archiveNotice.set({ toast: { id: ++toastId, kind: "error", message: t("open.failed", { message: error.message }) } });
              });
            }
          } : void 0;
          archiveNotice.set({ toast: { id: ++toastId, kind: "info", message: t("open.archived"), action } });
        }
        reload();`);
  replace('toast(t("open.failed", { message: error.message }), "error");',
    'if (browserTab) browserTab.close();\n        archiveNotice.set({ toast: { id: ++toastId, kind: "error", message: t("open.failed", { message: error.message }) } });');
  replace('function mountPage(ctx) {', `${PREVIEW_URL}
function mountPage(ctx) {`);
  replace('const updates = pageUpdates(ctx);', `const updates = pageUpdates(ctx);
  const archiveNotice = createStore({ toast: null });
  const ArchiveNotice = () => {
    const notice = (0, import_react2.useSyncExternalStore)(archiveNotice.subscribe, archiveNotice.getSnapshot);
    return notice.toast && (0, import_jsx_runtime2.jsx)(ToastBar, {
      toast: notice.toast, t, onClose: () => archiveNotice.set({ toast: null })
    }, notice.toast.id);
  };
  disposers.push(toDisposer(ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay", id: "crysound-artifacts.archive-notice"
  }, ArchiveNotice))));`);
  replace('toast.undo && /* @__PURE__ */', `toast.action && (0, import_jsx_runtime2.jsx)("button", {
      type: "button", className: "bda-toast-undo", onClick: toast.action.run, children: toast.action.label
    }),
    toast.undo && /* @__PURE__ */`);
  replace('toast.undo || toast.kind === "error" ? 1e4 : 4e3', 'toast.action || toast.undo || toast.kind === "error" ? 1e4 : 4e3');
  replace('.bda-toast{position:', '.bda-toast{pointer-events:auto;position:');
  replace('"open.noSession": "原来的对话已不在，编辑器在新窗口里打开了。",', `"open.noSession": "原来的对话已不在。",
  "open.archived": "作品所在的对话已归档",
  "open.restore": "恢复对话",
  "open.popupBlocked": "请允许浏览器打开新标签页后重试。",
  "open.noPreview": "作品预览暂不可用，请稍后重试。",
  "open.noBrowser": "应用内浏览器暂不可用，请重试或在设置中改用浏览器新标签。",`);
  replace('"open.noSession": "The conversation is gone, so the editor opened in a new window.",', `"open.noSession": "The original conversation is unavailable.",
  "open.archived": "This artifact's conversation is archived.",
  "open.restore": "Restore conversation",
  "open.popupBlocked": "Allow browser popups and try again.",
  "open.noPreview": "Artifact preview is unavailable. Try again later.",
  "open.noBrowser": "The in-app browser is unavailable. Retry or choose a new browser tab in Settings.",`);
  return marker + '\n' + text;
}

/** Released plugin files patched by the shared company startup script. */
export const PATCHES = [
  {
    file: "@crysound/artifacts/lib/client.js",
    patch: patchArtifactOpening,
  },
  // Company artifacts 1.0.0: change page copy only; market metadata and storage paths stay intact.
  {
    file: "@crysound/artifacts/lib/client.js",
    find: "兆华作品",
    replace: "作品",
    all: true,
  },
  // Use the released market glyph in the shell-owned icon wrapper; remove its CSS adapter.
  {
    file: "dshmarket/client/client.js",
    patch: text => patchThirdPartyCards(patchMarketSettingsIcon(text)),
  },
  // An explicit settings return owns the viewport until it closes; first-run onboarding resumes afterwards.
  {
    file: "@deepseek-ai/dsh-client-ui-settings-general/lib/client.js",
    find: "const onboardingStep = requestedOnboarding !== void 0",
    replace: "const onboardingStep = open && activeId !== void 0 ? void 0 : requestedOnboarding !== void 0",
  },
  // dsh 0.2.2-rc.1: company adapter applies to both iframe and Electron Browser providers.
  {
    file: "@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js",
    find: "function parseBrowserAddress(input, applicationOrigin) {",
    replace: PREVIEW_URL + "\nfunction parseBrowserAddress(input, applicationOrigin) {",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js",
    find: "const trimmed = input.trim();",
    replace: "const trimmed = zpPreviewUrl(input.trim());",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js",
    find: 'const namespace = "sidebarBrowser";',
    replace: 'const namespace = "sidebarBrowser";' + PREVIEW_CLICKS,
  },
  // baoyu MIT lib only: current release opens the native Browser; older iframe releases use src directly.
  {
    file: "dsh-claude-artifacts/lib/client.js",
    find: "const url = body.url;",
    replace: 'const url = (() => { const detail = { url: body.url }; document.dispatchEvent(new CustomEvent("zp-preview-url", { detail })); return detail.url; })();',
  },
  {
    file: "dsh-claude-artifacts/lib/client.js",
    find: "src: url,",
    replace: 'src: (() => { const detail = { url }; document.dispatchEvent(new CustomEvent("zp-preview-url", { detail })); return detail.url; })(),',
    all: true,
  },
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
];

const roots = process.argv.slice(2).flatMap((root) => {
  const store = path.join(root, ".pnpm");
  return [root, ...(fs.existsSync(store) ? fs.readdirSync(store).map((entry) => path.join(store, entry, "node_modules")) : [])];
});
for (const p of PATCHES) {
  const files = roots.map(root => path.join(root, p.file)).filter(file => fs.existsSync(file));
  if (!files.length) {
    console.warn(`插件修补未命中，目标文件不存在：${p.file}`);
    continue;
  }
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (p.patch) {
      const next = p.patch(text);
      if (next !== text) {
        fs.unlinkSync(file);
        fs.writeFileSync(file, next);
      }
      continue;
    }
    if (!p.all && text.includes(p.replace)) continue;
    if (!text.includes(p.find)) {
      if (!text.includes(p.replace)) console.warn(`插件修补未命中，可能插件已升级：${p.file}`);
      continue;
    }
    const next = p.all ? text.split(p.find).join(p.replace) : text.replace(p.find, p.replace);
    // pnpm 用硬链接共享文件，先删再写，只改本人这一份。
    fs.rmSync(file);
    fs.writeFileSync(file, next);
  }
}
