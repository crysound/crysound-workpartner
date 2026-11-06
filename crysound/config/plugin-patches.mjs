// 第三方插件的本地修补，每次启动时由 entrypoint 运行。每条写明文件、原文和替换文；已打过的跳过，原文找不到就提示（多半是插件升级了，该条要重看）。
// 用法：node plugin-patches.mjs <插件安装目录，即 profiles/web/node_modules>
import fs from "node:fs";
import path from "node:path";

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

const PATCHES = [
  // dshmarket 1.73.12: dsh now wraps the fallback gear in the native icon seat.
  {
    file: "dshmarket/client/client.js",
    find: '[${NAV_ICON_MARKER}] > svg { display: none; }',
    replace: '[${NAV_ICON_MARKER}] > :first-child { display: none; }',
  },
  // The native narrow settings shell owns its horizontal navigation and grid.
  {
    file: "dshmarket/client/client.js",
    find: '@media (max-width:560px){[role=dialog]:has([data-dsh-market-root])>nav{display:none}[role=dialog]:has([data-dsh-market-root])>div{flex:100%;width:100%;min-width:0}}',
    replace: '/* CRYSOUND: keep native narrow settings navigation */',
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
for (const root of roots) for (const p of PATCHES) {
  const file = path.join(root, p.file);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(p.replace)) continue;
  if (!text.includes(p.find)) {
    if (!text.includes(p.replace)) console.log(`插件修补未命中，可能插件已升级：${p.file}`);
    continue;
  }
  const next = p.all ? text.split(p.find).join(p.replace) : text.replace(p.find, p.replace);
  // pnpm 用硬链接共享文件，先删再写，只改本人这一份。
  fs.rmSync(file);
  fs.writeFileSync(file, next);
}
