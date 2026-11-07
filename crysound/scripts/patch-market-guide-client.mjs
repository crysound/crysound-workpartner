// Embedded in the pinned entry-customization module; components use existing session slots and input claims.
/**
 * Register package guidance on native session slots and command claims.
 * @param {object} ctx Pinned entry-customization client context.
 * @param {Function} createSnapshotStore Native observable-store factory.
 * @param {Function} jsx Native React single-child element factory.
 * @param {Function} jsxs Native React multiple-child element factory.
 * @returns {void}
 */
export function installCompanyGuides(ctx, createSnapshotStore, jsx, jsxs) {
  const copy = {
    zh: { market: "去市场看看", cancel: "取消能力", unavailable: "请先安装或启用这个插件的已批准版本", draft: "请先发送或清空新对话中的草稿，再选择能力", failed: "插件引导暂时无法读取，请重试", retry: "重试", example: "试试这样问" },
    en: { market: "Explore the market", cancel: "Remove capability", unavailable: "Install or enable the approved plugin version first", draft: "Send or clear the new conversation draft before choosing a capability", failed: "Could not load plugin guidance. Try again", retry: "Retry", example: "Try asking" },
  };
  const catalog = createSnapshotStore({ guides: [], error: false });
  const language = () => ctx.locale.resolveText({ zh: "zh", en: "en" }) === "zh" ? "zh" : "en";
  const text = key => copy[language()][key];
  const token = guide => `/zp-guide-${guide.name.split("/")[1]} `;
  let disposed = false, generation = 0;
  const abort = new AbortController();
  async function load() {
    const request = ++generation;
    try {
      const response = await fetch("/_zp/market/guides.json", { credentials: "same-origin", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("guide response");
      const body = await response.json();
      if (!Array.isArray(body.guides)) throw new Error("guide data");
      if (!disposed && request === generation) catalog.set({ guides: body.guides, error: false });
    } catch (error) {
      if (!disposed && request === generation) catalog.set({ guides: [], error: true });
    }
  }
  async function active(guide) {
    const [bundles, plugins] = await Promise.all([ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()]);
    const bundle = bundles.find(row => row.name === guide.name);
    return bundle?.enabled && !bundle.error && bundle.version === guide.version && bundle.rows.some(row =>
      row.moduleName === guide.name && plugins.some(plugin => plugin.entryId === row.entryId && plugin.enabled && plugin.fiberPhase === "active"));
  }
  function claim(guide) {
    return {
      name: `zp-guide:${guide.name}`, token: token(guide), attachments: true,
      async submit(args, actx, attachments) {
        const row = guide.guide[language()];
        if (!await active(guide)) return { kind: "error", text: text("unavailable") };
        const id = ctx.sessions.scopeOf(actx), binding = ctx.sessions.binding(id);
        if (!binding) return { kind: "error", text: text("failed") };
        const answer = await binding.session.prompt([{ type: "text", text: `${row.prompt}\n\n${args}` }, ...attachments], "queue");
        return answer.ok ? { kind: "success" } : { kind: "error", text: answer.error.message };
      },
    };
  }
  const find = spelling => catalog.getSnapshot().guides.find(guide => token(guide).trim() === spelling);
  function select(sessionId, guide) {
    const scope = ctx.sessions.scope(sessionId);
    if (!scope) throw new Error(text("failed"));
    const input = scope.conversation.input.for(scope), state = input.state.getSnapshot();
    if (state.draft.trim() || state.attachmentIds.length || state.phase !== "plain") throw new Error(text("draft"));
    if (!input.beginCommand(claim(guide), { start: 0, end: 0, draftRev: state.draftRev })) throw new Error(text("draft"));
    input.focus();
  }
  async function open(name, fallback) {
    const guide = catalog.getSnapshot().guides.find(row => row.name === name);
    if (!guide || !await active(guide)) return fallback();
    const current = Object.values(ctx.sessions.list.getSnapshot().byId).find(row => (row.retainedBy.mainView ?? 0) > 0);
    const workspace = ctx.workspaces.list.getSnapshot().items.find(row => row.sessionIds.includes(current?.id));
    if (!workspace) return fallback();
    await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, id => select(id, guide));
  }
  const face = sessionId => ({
    hooks: { companyGuides: catalog, guideLocale: ctx.locale },
    copy: text,
    guideLanguage: language,
    browse: () => ctx.get("pluginNavigation")?.openList(),
    choose: name => { void open(name, () => ctx.get("pluginNavigation")?.openBundle(name)).catch(() => {
      const scope = ctx.sessions.scope(sessionId); scope?.conversation.input.for(scope).notify("error", text("draft"));
    }); },
    cancel: state => {
      const scope = ctx.sessions.scope(sessionId);
      scope?.bail(scope, "slash/input-consume-token", { guard: { kind: "span", span: { start: 0, end: 1, draftRev: state.draftRev } } });
    },
    example: (guide, example) => {
      const scope = ctx.sessions.scope(sessionId);
      if (!scope) return;
      const input = scope.conversation.input.for(scope);
      const state = input.state.getSnapshot();
      if (state.phase !== "claimed" || state.claim?.name !== `zp-guide:${guide.name}` || state.attachmentIds.length || state.draft.slice(token(guide).length).trim()) return;
      const end = state.draft.length - token(guide).trimEnd().length + 1;
      if (input.insertText(example, { start: end, end, draftRev: state.draftRev })) input.submit();
    },
    retry: () => { void load(); },
  });
  function selected(props) {
    const input = props.useInput(state => state);
    const { guides } = props.useCompanyGuides(state => state);
    props.useGuideLocale(state => state);
    return { input, guide: guides.find(row => input.claim?.name === `zp-guide:${row.name}`) };
  }
  function Shortcuts(props) {
    const blank = props.useSession(state => state.blank && !state.running && !state.promptAttempted);
    const { input } = selected(props), { guides, error } = props.useCompanyGuides(state => state);
    if (!blank || input.draft !== "" || input.attachmentIds.length) return null;
    return jsxs("div", { className: "zp-guide-shortcuts", children: [
      ...guides.filter(row => row.home).slice(0, 4).map(guide => jsx("button", { type: "button", onClick: () => props.choose(guide.name), children: guide.title }, guide.name)),
      jsx("button", { type: "button", onClick: props.browse, children: props.copy("market") }),
      error && jsx("button", { type: "button", onClick: props.retry, children: props.copy("retry"), title: props.copy("failed") }),
    ] });
  }
  function Tag(props) {
    const { input, guide } = selected(props);
    return !guide ? null : jsxs("span", { className: "zp-guide-tag", children: [guide.title,
      jsx("button", { type: "button", disabled: input.phase !== "claimed", "aria-label": props.copy("cancel"), onClick: () => props.cancel(input), children: "×" }),
    ] });
  }
  function Guide(props) {
    const blank = props.useSession(state => state.blank && !state.running && !state.promptAttempted);
    const { input, guide } = selected(props);
    if (!blank || !guide) return null;
    const row = guide.guide[props.guideLanguage()];
    return jsxs("section", { className: "zp-guide-card", "aria-label": guide.title, children: [
      jsx("h3", { children: guide.title }), jsx("p", { children: row.summary }),
      jsx("p", { className: "zp-guide-caption", children: props.copy("example") }),
      ...row.examples.map(example => jsx("button", { type: "button", disabled: input.phase !== "claimed" || input.attachmentIds.length > 0 || input.draft.slice(token(guide).length).trim() !== "", onClick: () => { void props.example(guide, example); }, children: example }, example)),
    ] });
  }
  ctx.effect(() => {
    void load();
    return () => { disposed = true; abort.abort(); };
  });
  ctx.effect(() => ctx.remote.$on("plugin-manager/changed", () => { void load(); }));
  ctx.effect(() => ctx.on("connection/reset", () => { void load(); }));
  ctx.effect(() => ctx.on("company-guide/open", (name, fallback) => { void open(name, fallback).catch(fallback); return true; }));
  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "/", name: "zp-guide", order: -10, candidates: async () => [], onPick: () => undefined,
    async matchClaim(session, spelling, signal) { if (!spelling.startsWith("/zp-guide-")) return; await load(); signal.throwIfAborted(); const guide = find(spelling); return guide ? claim(guide) : undefined; },
    async matchEnter(session, line) { if (!line.startsWith("/zp-guide-")) return; const guide = find(line.split(/\s/u)[0]); if (!guide) throw new Error(text("failed")); return { claim: claim(guide) }; },
  }));
  for (const [name, Component] of [["conversation.composer.dock", Shortcuts], ["conversation.input.left", Tag], ["conversation.input.dock", Guide]]) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: "zp-guide", inject: face }, Component));
  }
}
