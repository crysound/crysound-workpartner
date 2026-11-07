// Shared, pinned browser artifact patch. Never mutate the pnpm store through a hard link.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sidebarPanels, sidebarGrouping } from './sidebar-policy.mjs';

const VERSION = '0.2.2-rc.1';

function editor(text, kind, version = 1) {
  const marker = `/* CRYSOUND sidebar A ${kind} v${version} */`;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error(`Sidebar A ${kind}: expected one match for ${needle.slice(0, 90)}`);
    text = text.replace(needle, () => next);
  };
  return { marker, done: text.includes(marker), replace, finish: () => marker + '\n' + text };
}

/** Patch navigation while retaining the original panel, command and drawer owners. */
function patchSidebarNavigationV1(text) {
  const edit = editor(text, 'navigation');
  if (edit.done) return text;
  const { replace } = edit;
  replace('const inject = [', 'const inject = ["remote", "remote.pluginInventory", "remoteAccess",');
  replace('function HeaderLeadingControls({ toggleSidebar,', 'function HeaderLeadingControls({ searchSessions, toggleSidebar,');
  replace('className: HeaderLeadingControls_module_css_default.controls,', 'className: HeaderLeadingControls_module_css_default.controls, "data-zp-header-controls": true,');
  replace('}), desktop && canStartSession && (0, react_jsx_runtime.jsx)', `}), desktop && (0, react_jsx_runtime.jsx)("button", {
    type: "button", className: HeaderLeadingControls_module_css_default.iconButton,
    "data-zp-sidebar-search": true, "aria-label": t("zp.search"), onClick: searchSessions,
    children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 16 })
  }), desktop && canStartSession && (0, react_jsx_runtime.jsx)`);
  // The existing market patch may have run first; accept exactly that known predecessor.
  const oldPanels = 'const panels = usePanels((snapshot) => snapshot).slice().sort((a, b) => { const rank = (id) => id === "plugins" ? 0 : id === "schedules" ? 1 : 2; return rank(a.id) - rank(b.id); });';
  replace(text.includes(oldPanels) ? oldPanels : 'const panels = usePanels((snapshot) => snapshot);',
    'const panels = usePanels((snapshot) => snapshot); const company = sidebarPanels(panels);');
  replace('function SidebarRoot({ collapsed,', `${sidebarPanels.toString()}\nfunction SidebarRoot({ searchSessions, collapsed,`);
  replace('const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));\n\t\t\tconst canStartSession',
    'const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));\nconst searchShortcut = useShortcuts(rows => rows.find(row => row.id === "session.search"));\n\t\t\tconst canStartSession');
  replace('startSession: (workspaceId) => {\n\t\t\t\t\tworkspaceNavigation.startSession(workspaceId);',
    'searchSessions: () => { workspaceNavigation.requestSearch(); },\nstartSession: (workspaceId) => {\n\t\t\t\t\tworkspaceNavigation.startSession(workspaceId);');
  replace('className: clsx(SidebarRoot_module_css_default.root,', '"data-zp-sidebar": true, className: clsx(SidebarRoot_module_css_default.root,');
  replace('})(), !darwinDesktop && toggle]', `})(), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
    label: t("zp.search"), shortcutKeys: searchShortcut?.keys, portal: drawer,
    children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: SidebarRoot_module_css_default.iconButton,
      "data-zp-sidebar-search": true, "aria-label": t("zp.search"), "aria-keyshortcuts": searchShortcut?.aria,
      onClick: searchSessions, children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 18 }) })
  }), !darwinDesktop && toggle]`);
  replace('panels.filter(({ id }) => id === "plugins" || !unpinned.includes(id)).map', 'company.visible.map');
  replace('hasEntryActions && (0, react_jsx_runtime.jsx)(PanelMoreMenu, {', 'company.extras.length > 2 && (0, react_jsx_runtime.jsx)(PanelMoreMenu, {');
  replace('entries: panels.filter(({ id }) => id !== "plugins").map', 'entries: company.extras.map');
  replace('children: renderSlot("sidebar.workspaces", {', 'children: [(wide && company.fixed.length < 3 && (0, react_jsx_runtime.jsx)("small", { className: "zp-sidebar-restore", children: t("zp.restore") })), renderSlot("sidebar.workspaces", {');
  replace('if (collapsed) toggleSidebar();\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t})', 'if (collapsed) toggleSidebar();\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t})]');
  replace('children: renderSlot("sidebar.panellist.actions", {\n\t\t\t\t\tentries,\n\t\t\t\t\tonOpen,\n\t\t\t\t\tonPinnedChange,\n\t\t\t\t\tonDismiss\n\t\t\t\t})',
    'items: entries.map(entry => ({ id: entry.id, label: entry.label })), selectedIds: entries.filter(entry => entry.active).map(entry => entry.id), onSelect: id => { onOpen(id); onDismiss(); }');
  replace('className: SidebarRoot_module_css_default.panelRow,\n\t\t\t\t\t\t"aria-label": label,',
    'className: clsx(SidebarRoot_module_css_default.panelRow, entries.some(entry => entry.active) && SidebarRoot_module_css_default.panelActive),\n\t\t\t\t\t\t"aria-label": label,');
  replace('"aria-label": label,\n\t\t\t\t\t"aria-current": active',
    '"data-zp-panel": id, "aria-label": id === "plugins" ? label + " · " + t("zp.marketHint") : label,\n\t\t\t\t\t"aria-current": active');
  replace('function PanelRow({ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot })',
    'function PanelRow({ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot, t })');
  replace('children: label\n\t\t\t\t\t})]', 'children: id === "plugins" ? (0, react_jsx_runtime.jsxs)("span", { className: "zp-sidebar-market-title", children: [label, (0, react_jsx_runtime.jsx)("small", { children: t("zp.marketHint") })] }) : label\n\t\t\t\t\t})]');
  replace('company.visible.map(({ id, label }) => (0, react_jsx_runtime.jsx)(PanelRow, {\n\t\t\t\t\t\t\tid,\n\t\t\t\t\t\t\tlabel,', 'company.visible.map(({ id, label }) => (0, react_jsx_runtime.jsx)(PanelRow, { t, id, label: id === "schedules" ? t("zp.automation") : label,');
  replace('const panels = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]);',
    'const panels = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]); let pluginNames = new Map();');
  replace('entriesOfSlot("sidebar.panellist").map(({ options }) => {', 'entriesOfSlot("sidebar.panellist").map(({ options, registrant }) => {');
  replace('order: options.order ?? 0,\n\t\t\t\t\t\tlabel:', 'owner: registrant, pluginName: pluginNames.has(registrant) ? ctx.locale.resolveText(pluginNames.get(registrant)) : undefined, order: options.order ?? 0,\n\t\t\t\t\t\tlabel:');
  replace('panel.label === candidate.label;', 'panel.label === candidate.label && panel.owner === candidate.owner && panel.pluginName === candidate.pluginName;');
  // Inventory only supplies display text. It never installs, enables, or writes a plugin.
  replace('const panelPins = createPanelPins();', `ctx.remoteAccess.whenAccess("pluginInventory/list", function* () {
    let live = true; let generation = 0;
    yield () => { live = false; };
    const refresh = async () => {
      const request = ++generation;
      try {
        const result = await ctx.remote.pluginInventory.list();
        if (!live || request !== generation) return;
        if (!result.ok) throw new Error(result.error.message);
        pluginNames = new Map(result.value.entries.map(entry => [entry.moduleName.replace(/\\/client$/, ""), entry.meta?.title || entry.moduleName]));
        syncPanels();
      } catch (error) { if (live) ctx.logger.warn("Sidebar plugin names: " + String(error)); }
    };
    yield ctx.remote.$on("plugin-manager/changed", refresh);
    void refresh();
  });
const panelPins = createPanelPins();`);
  replace('const zh = {', 'const zh = { "zp.restore": "缺少入口？可在设置或市场中启用。", "zp.automation": "自动化", "zp.search": "搜索对话", "zp.marketHint": "插件·技能",');
  replace('const en = {', 'const en = { "zp.restore": "Missing an entry? Enable it in Settings or Market.", "zp.automation": "Automation", "zp.search": "Search conversations", "zp.marketHint": "Plugins · skills",');
  // Remaining dictionaries get accessible English copy through the locale fallback.
  if (text.includes('"session.new": "新会话"')) replace('"session.new": "新会话"', '"session.new": "新对话"');
  else if (!text.includes('"session.new": "新对话"')) throw new Error('Sidebar A: New conversation copy not found');
  replace('"session.new.label": "新建会话"', '"session.new.label": "新对话"');
  return edit.finish();
}

/** Patch browsing and its existing device-local preference; never change workspace records. */
function patchWorkspaceV2(text) {
  const edit = editor(text, 'workspace', 2);
  if (edit.done) return text;
  const { replace } = edit;
  const oldChoice = 'const canCreateWorkspace = useRemoteAccess("workspace/create"); const savedGroupBy = useStore((s) => s.groupBy); const [viewChoice, setViewChoice] = (0, react.useState)(null); const groupBy = viewChoice?.count === workspaces.length ? viewChoice.mode : sidebarGrouping(workspaces.length, savedGroupBy);';
  const newChoice = 'const canCreateWorkspace = useRemoteAccess("workspace/create"); const savedGroupBy = useStore((s) => s.groupBy); const explicitGroupBy = useStore((s) => s.groupByExplicit); const groupBy = sidebarGrouping(workspaces.length, savedGroupBy, explicitGroupBy);';
  // Accept the exact deployed v1 predecessor as well as the pinned original artifact.
  if (text.includes('/* CRYSOUND sidebar A workspace v1 */')) {
    replace('/* CRYSOUND sidebar A workspace v1 */\n', '');
    replace(oldChoice, newChoice);
    replace('onGroupPick: mode => { setViewChoice({ count: workspaces.length, mode }); actions.setGroupBy(mode); },', 'onGroupPick: actions.setGroupBy,');
    replace("function sidebarGrouping(workspaceCount, saved) {\n  return workspaceCount <= 1 ? 'flat' : saved === 'workspace-tree' ? saved : 'workspace';\n}", sidebarGrouping.toString());
  } else {
    replace('const SESSION_WATERMARK_BASE = 5;', 'const SESSION_WATERMARK_BASE = 12;');
    replace('const shortcutControls = createWorkspaceShortcutControls();', 'const shortcutControls = createWorkspaceShortcutControls(); uiWorkspace.requestSearch = shortcutControls.search;');
    replace('searchRoot.current?.contains(event.target) === true', 'searchRoot.current?.contains(event.target) === true || event.target instanceof Element && event.target.closest("[data-zp-sidebar-search]") !== null');
    replace('function WorkspaceBrowser({ wide,', `${sidebarGrouping.toString()}\nfunction WorkspaceBrowser({ wide,`);
    replace('const groupBy = useStore((s) => s.groupBy);', newChoice);
    replace('children: groupBy === "flat" ? t("section.sessions") : t("section.workspaces")', 'children: t("zp.recent")');
    replace('className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),',
      '"data-zp-conversations": true, "data-search-expanded": searchExpanded, className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),');
    // Use the view-options anchor for the existing directory picker as well.
    replace('function ViewOptionsMenu({ groupBy,', 'function ViewOptionsMenu({ addWorkspace, manageWorkspace, anchorRef, groupBy,');
    replace('items: [\n\t\t\t\t\t{\n\t\t\t\t\t\ttype: "label",',
      'items: [...(addWorkspace ? [{ id: "zp-add", label: t("workspace.add") }] : []), ...(manageWorkspace ? [{ id: "zp-manage", label: t("zp.manage") }] : []),\n\t\t\t\t\t{\n\t\t\t\t\t\ttype: "label",');
    replace('if (id === "workspace" || id === "workspace-tree" || id === "flat") onGroupPick(id);',
      'if (id === "zp-add") addWorkspace(); else if (id === "zp-manage") manageWorkspace(); else if (id === "workspace" || id === "workspace-tree" || id === "flat") onGroupPick(id);');
    replace('className: clsx(WorkspaceBrowser_module_css_default.iconButton, WorkspaceBrowser_module_css_default.wide),',
      'ref: anchorRef, className: clsx(WorkspaceBrowser_module_css_default.iconButton, WorkspaceBrowser_module_css_default.wide),');
    replace('children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {\n\t\t\t\t\t\t\t\t\tgroupBy,',
      `children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {
      anchorRef: wsPlusRef, addWorkspace: directoryFlowAvailable && canCreateWorkspace ? requestAddWorkspace : undefined,
      manageWorkspace: workspaces.length === 1 ? () => { const w = workspaces[0]; const rect = wsPlusRef.current.getBoundingClientRect(); openWorkspaceMenu(w.workspaceId, w.path, w.title, { x: rect.left, y: rect.bottom }); } : undefined,
      groupBy,`);
    // Keep the rail's native add button; expanded creation lives in display options.
    replace('}), directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
      '}), !wide && directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {');
    replace('const zh = {', 'const zh = { "zp.recent": "最近对话", "zp.manage": "管理工作区",');
    replace('const en = {', 'const en = { "zp.recent": "Recent conversations", "zp.manage": "Manage workspace",');
  }
  // Optional boolean in dsh.workspace.view.v5: true = manual, false = reset to auto.
  // Missing preserves legacy flat/tree; ambiguous legacy workspace uses automatic projection.
  replace('d.groupBy = mode;', 'd.groupBy = mode; d.groupByExplicit = true;');
  return edit.finish();
}

/** Put the search destination after New conversation, retaining the rail command. */
export function patchSidebarModule(text) {
  const edit = editor(patchSidebarNavigationV1(text), 'navigation', 2);
  if (edit.done) return text;
  const { replace } = edit;
  replace('const panels = usePanels((snapshot) => snapshot); const company = sidebarPanels(panels);',
    'const [searchHost, setSearchHost] = (0, react.useState)(null); const panels = usePanels((snapshot) => snapshot); const company = sidebarPanels(panels);');
  replace(`})(), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
    label: t("zp.search"), shortcutKeys: searchShortcut?.keys, portal: drawer,
    children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: SidebarRoot_module_css_default.iconButton,
      "data-zp-sidebar-search": true, "aria-label": t("zp.search"), "aria-keyshortcuts": searchShortcut?.aria,
      onClick: searchSessions, children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 18 }) })
  }), !darwinDesktop && toggle]`, '})(), !darwinDesktop && toggle]');
  replace('panels.length > 0 && (0, react_jsx_runtime.jsxs)("nav", {', `(0, react_jsx_runtime.jsx)("div", { ref: setSearchHost, hidden: !wide, "data-zp-search-host": true }),
    !wide && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
      label: t("zp.search"), shortcutKeys: searchShortcut?.keys, portal: drawer,
      children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: SidebarRoot_module_css_default.panelRow,
        "data-zp-sidebar-search": true, "aria-label": t("zp.search"), "aria-keyshortcuts": searchShortcut?.aria,
        onClick: searchSessions, children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 18 }) })
    }), panels.length > 0 && (0, react_jsx_runtime.jsxs)("nav", {`);
  replace('renderSlot("sidebar.workspaces", {', 'renderSlot("sidebar.workspaces", { searchHost,');
  replace('"zp.search": "搜索对话"', '"zp.search": "搜索"');
  return edit.finish();
}

/** Portal the existing input into the navigation row; keep search and result ownership intact. */
export function patchWorkspaceModule(text) {
  text = patchWorkspaceV2(text);
  const edit = editor(text, 'workspace', 3);
  if (edit.done) return text;
  const { replace } = edit;
  replace('let react = require("react");', 'let react = require("react"); const { createPortal } = require("react-dom");');
  replace('function WorkspaceBrowser({ wide,', 'function WorkspaceBrowser({ searchHost, wide,');
  const start = text.indexOf('wide && (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\t\tclassName: clsx(WorkspaceBrowser_module_css_default.searchSlot,');
  const end = text.indexOf('(0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\t\t\tclassName: clsx(WorkspaceBrowser_module_css_default.headerActions,', start);
  if (start < 0 || end < 0) throw new Error('Sidebar search: missing pinned search slot');
  const oldSearch = text.slice(start, end);
  let search = oldSearch.replace('wide && (0, react_jsx_runtime.jsx)("div", {', 'wide && searchHost && createPortal((0, react_jsx_runtime.jsx)("div", {');
  const tail = search.lastIndexOf('}),');
  search = search.slice(0, tail) + '}), searchHost),' + search.slice(tail + 3);
  replace(oldSearch, search);
  replace('ref: searchRoot,', 'ref: searchRoot, "data-zp-inline-search": true, "data-expanded": searchExpanded,');
  replace('className: WorkspaceBrowser_module_css_default.searchButton,\n\t\t\t\t\t\t\t\t\t\t\t\t"aria-label":',
    'className: WorkspaceBrowser_module_css_default.searchButton, onFocus: () => { if (!searchExpanded) requestSearch(); },\n\t\t\t\t\t\t\t\t\t\t\t\t"aria-label":');
  replace('children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: searchExpanded ? 11 : 14 })',
    'children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 16 }), !searchExpanded && (0, react_jsx_runtime.jsx)("span", { children: t("zp.searchRow") })]');
  replace('placeholder: t("search.placeholder"),', '"aria-label": t("search.sessions.aria"), placeholder: t("search.placeholder"),');
  replace('setQuery(sanitizeSearchQuery(e.target.value));', 'setQuery(sanitizeSearchQuery(e.target.value)); if (e.target.value === "") { changeSearchExpanded(false); e.target.blur(); }');
  replace('if (e.key !== "Escape") return;', 'if (e.key !== "Escape" || e.nativeEvent.isComposing) return; e.stopPropagation(); e.preventDefault(); e.currentTarget.blur();');
  replace('e.stopPropagation();\n\t\t\t\t\t\t\t\t\t\t\t\tsetQuery("");', 'e.stopPropagation(); searchInput.current?.blur(); e.currentTarget.blur();\n\t\t\t\t\t\t\t\t\t\t\t\tsetQuery("");');
  replace('WorkspaceBrowser_module_css_default.wide, searchExpanded && WorkspaceBrowser_module_css_default.sectionLabelHidden', 'WorkspaceBrowser_module_css_default.wide');
  replace('WorkspaceBrowser_module_css_default.headerActions, wide && searchExpanded && WorkspaceBrowser_module_css_default.headerActionsHidden', 'WorkspaceBrowser_module_css_default.headerActions');
  replace('const zh = {', 'const zh = { "zp.searchRow": "搜索",');
  replace('const en = {', 'const en = { "zp.searchRow": "Search",');
  return edit.finish();
}

/** Verify both package versions and transform everything before the first write. */
export function patchCompanySidebarRuntime(root) {
  const changes = [['ui-sidebar', patchSidebarModule], ['ui-workspace', patchWorkspaceModule]].map(([name, patch]) => {
    const dir = path.join(root, '@deepseek-ai/dsh-client-' + name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (manifest.version !== VERSION) throw new Error(`Sidebar A: unsupported ${name} version ${manifest.version}`);
    const file = path.join(dir, 'lib/client.js');
    const before = fs.readFileSync(file, 'utf8');
    return { file, before, after: patch(before), mode: fs.statSync(file).mode };
  });
  for (const { file, before, after, mode } of changes) {
    if (before === after) continue;
    fs.unlinkSync(file);
    fs.writeFileSync(file, after, { mode });
    fs.chmodSync(file, mode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: patch-sidebar.mjs <runtime node_modules>');
  patchCompanySidebarRuntime(process.argv[2]);
}
