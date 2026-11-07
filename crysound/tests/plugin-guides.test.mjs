import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { installCompanyGuides } from "../scripts/patch-market-guide-client.mjs";
import { patchMarketGuides, patchGuideUse, patchGuidePlaceholder, installCompanyMarketNavigation } from "../scripts/patch-market-guides.mjs";
import { patchCompanyMarketRuntime } from "../scripts/patch-market-ui.mjs";
import { patchMarketEntry } from "../scripts/patch-market-entry.mjs";
import { patchMarketCatalog } from "../scripts/patch-market-catalog.mjs";
import { patchDataUse } from "../config/patch-data-use.mjs";
import { companyGuideResponse } from "../../apps/desktop/src/crysound/plugin-guides.ts";
import { parsePluginGuide } from "../web/gateway/plugin-guide.mjs";

const guidance = {
  zh: { summary: "制作公司品牌的网页、海报和原型", prompt: "请使用 /design 技能完成以下需求。", examples: ["设计产品介绍页", "制作展会海报", "检查页面设计"] },
  en: { summary: "Create branded pages, posters and prototypes", prompt: "Use the /design skill for the following request.", examples: ["Design a product page", "Create an event poster", "Review a page design"] },
};
const guide = { name: "@crysound/design", version: "0.2.1", title: "兆华设计", home: true, guide: guidance };
const jsx = (type, props, key) => ({ type, props, key });
const store = value => ({ getSnapshot: () => value, set: next => { value = next; }, subscribe: () => () => {} });

async function fixture(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ guides: [guide, ...Array.from({ length: 5 }, (_, i) => ({ ...guide, name: `@crysound/example${i}` }))] });
  t.after(() => { globalThis.fetch = original; });
  const registrations = new Map(), events = new Map(), disposers = [], sent = [], notices = [], calls = [];
  const inputState = store({ draft: "", draftRev: 0, phase: "plain", attachmentIds: [], occurrences: [] });
  const sessionState = store({ blank: true, running: false, promptAttempted: false });
  let savedClaim, source, enabled = true, installed = true, version = guide.version, language = "zh", remoteFailure = false;
  const input = {
    state: inputState, notify: (...args) => notices.push(args), focus() {},
    beginCommand(claim) { savedClaim = claim; inputState.set({ ...inputState.getSnapshot(), draft: claim.token, claim: { name: claim.name, token: claim.token }, phase: "claimed" }); return true; },
    insertText(text, span) { assert.equal(span.start, 2); const state = inputState.getSnapshot(); inputState.set({ ...state, draft: state.draft + text }); return true; },
    submit() { const state = inputState.getSnapshot(); inputState.set({ ...state, phase: "submitting" }); calls.push("submit"); },
  };
  const scope = { get: name => { assert.equal(name, "conversation"); return { input: { for: () => input } }; }, bail(self, event, request) { assert.equal(request.guard.span.end, 1); const state = inputState.getSnapshot(); inputState.set({ ...state, draft: state.draft.slice(state.claim.token.trimEnd().length), claim: undefined, phase: "plain" }); } };
  const locale = store({ active: "zh" });
  const ctx = {
    locale: { ...locale, resolveText: value => value[language] },
    remote: { $on: () => () => {}, pluginManager: {
      listBundles: async () => remoteFailure ? { ok: false, error: { message: "unavailable" } } : { ok: true, value: installed ? [{ name: guide.name, version, enabled, rows: [{ entryId: "design", moduleName: guide.name }] }] : [] },
      listPlugins: async () => ({ ok: true, value: [{ entryId: "design", enabled, fiberPhase: "active" }] }),
    } },
    sessions: { scope: () => scope, scopeOf: () => "blank", binding: () => ({ session: { prompt: async (content, mode) => { sent.push({ content, mode }); return { ok: true }; } } }), list: store({ byId: { current: { id: "current", retainedBy: { mainView: 1 } } } }) },
    workspaces: { list: store({ items: [{ workspaceId: "work", sessionIds: ["current"] }] }) },
    uiWorkspace: { openWorkspace: async (id, prepare) => { calls.push(id); prepare("blank"); } },
    slots: { inject: (name, register) => register(), register: (definition, Component) => { registrations.set(definition.name, { definition, Component }); } },
    inputTriggers: { registerSource: value => { source = value; return () => { source = undefined; }; } },
    get: () => ({ openList: () => calls.push("market"), openBundle: name => calls.push(name) }),
    bail: (self, event, ...args) => { calls.push({ event, args }); return events.get(event)?.(...args); },
    on: (event, callback) => { events.set(event, callback); return () => events.delete(event); },
    effect: action => { const dispose = action(); if (typeof dispose === "function") disposers.push(dispose); },
  };
  installCompanyGuides(ctx, store, jsx, jsx);
  await new Promise(resolve => setImmediate(resolve));
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  const props = name => {
    const { definition } = registrations.get(name), face = definition.inject("blank");
    return { ...face, useInput: selector => selector(inputState.getSnapshot()), useSession: selector => selector(sessionState.getSnapshot()), useCompanyGuides: selector => selector(face.hooks.companyGuides.getSnapshot()), useGuideLocale: selector => selector(ctx.locale.getSnapshot()) };
  };
  const render = name => registrations.get(name).Component(props(name));
  return { ctx, sent, notices, calls, render, props, inputState, sessionState, events, source: () => source, claim: () => savedClaim,
    installed: value => { installed = value; }, enabled: value => { enabled = value; }, remoteFailure: value => { remoteFailure = value; }, version: value => { version = value; }, language: value => { language = value; locale.set({ active: value }); } };
}

test("首页未安装入口打开对应市场详情，已启用进入说明卡，逛市场打开公司列表", async t => {
  const f = await fixture(t), face = f.props("conversation.composer.dock");
  f.installed(false); face.choose(guide.name);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [{ event: "company-market/open", args: [guide.name] }]);
  assert.equal(f.render("conversation.input.dock"), null);
  f.calls.length = 0; f.installed(true); face.choose(guide.name);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["work"]);
  assert.equal(f.render("conversation.input.dock").props.children[0].props.children, guide.title);
  f.calls.length = 0; face.browse();
  assert.deepEqual(f.calls, [{ event: "company-market/open", args: [null] }]);
  assert.equal(f.sent.length, 0);
});

test("冷启动与旧筛选下都定位官方包，返回列表清掉定位，释放后不再处理", t => {
  let state = { indexes: [], selected: null, listing: null };
  const listeners = new Set(), events = new Map(), disposers = [], queries = [];
  const publish = next => { state = next; for (const listener of listeners) listener(); };
  const initial = { text: "", category: null, labels: [], sort: { kind: "index" } };
  const face = { hooks: {}, ensure() {}, select() {}, search: query => queries.push(query) };
  const ctx = { effect: fn => disposers.push(fn()), on: (event, fn) => { events.set(event, fn); return () => events.delete(event); } };
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  installCompanyMarketNavigation(ctx, { store: { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } } }, face, store, initial);
  events.get("company-market/select")(guide.name);
  assert.deepEqual(queries, []);
  publish({ indexes: [{ url: "company" }], selected: "company", listing: { url: "company", query: initial } });
  assert.deepEqual(queries, [{ ...initial, text: guide.name }]);
  assert.equal(face.hooks.companyMarket.getSnapshot().name, guide.name);
  face.closeCompanyEntry(); assert.deepEqual(queries.at(-1), initial);
  assert.equal(face.hooks.companyMarket.getSnapshot().name, null);
  state.listing.query = { ...initial, text: "old search", category: "other" };
  events.get("company-market/select")(guide.name);
  assert.deepEqual(queries.at(-1), { ...initial, text: guide.name });
  events.get("company-market/select")(null);
  assert.deepEqual(queries.at(-1), initial);
  for (const dispose of disposers.splice(0).reverse()) dispose();
  assert.equal(events.size, 0); assert.equal(listeners.size, 0);
});

test("仅空白新对话显示最多四个官方入口，草稿、附件和历史对话隐藏入口", async t => {
  const f = await fixture(t), name = "conversation.composer.dock";
  assert.equal(f.render(name).props.children.length, 6);
  assert.equal(f.render(name).props.children.filter(Boolean).length, 5);
  for (const change of [{ draft: "unsent" }, { attachmentIds: ["image"] }]) {
    const before = f.inputState.getSnapshot(); f.inputState.set({ ...before, ...change }); assert.equal(f.render(name), null); f.inputState.set(before);
  }
  f.sessionState.set({ blank: false }); assert.equal(f.render(name), null);
});

test("选择能力不发消息；标签、包内三示例与双语同步；取消只移出能力保留草稿附件", async t => {
  const f = await fixture(t);
  await f.events.get("company-guide/open")(guide.name, () => assert.fail("fallback"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0);
  assert.equal(f.render("conversation.input.left").props.children[0], guide.title);
  assert.equal(f.render("conversation.input.dock").props.children[1].props.children, guidance.zh.summary);
  f.language("en");
  assert.equal(f.render("conversation.input.dock").props.children[1].props.children, guidance.en.summary);
  const state = f.inputState.getSnapshot(); f.inputState.set({ ...state, draft: state.draft + "my draft", attachmentIds: ["file"] });
  f.props("conversation.input.left").cancel(f.inputState.getSnapshot());
  assert.equal(f.inputState.getSnapshot().draft.trim(), "my draft");
  assert.deepEqual(f.inputState.getSnapshot().attachmentIds, ["file"]);
  assert.equal(f.render("conversation.input.left"), null);
});

test("示例走原生输入提交路径，连续点击不会重复提交，既有草稿不会被替换", async t => {
  const f = await fixture(t); f.events.get("company-guide/open")(guide.name, () => assert.fail("fallback"));
  await new Promise(resolve => setImmediate(resolve));
  const face = f.props("conversation.input.dock"); face.example(guide, guidance.zh.examples[0]); face.example(guide, guidance.zh.examples[0]);
  assert.equal(f.calls.filter(call => call === "submit").length, 1);
  assert.match(f.inputState.getSnapshot().draft, /设计产品介绍页$/);
});

test("能力提交携带真实指令与附件；停用或版本不符拒绝，恢复认领使用同一来源", async t => {
  const f = await fixture(t), source = f.source();
  const claim = await source.matchClaim({ sessionId: "blank" }, "/zp-guide-design", new AbortController().signal);
  const attachments = [{ type: "file", receiptId: "fixture" }, { type: "image", mediaType: "image/png", data: "fixture" }];
  const scope = f.ctx.sessions.scope("blank");
  assert.equal((await claim.submit("make it", scope, attachments)).kind, "success");
  assert.deepEqual(f.sent[0].content, [{ type: "text", text: guidance.zh.prompt + "\n\nmake it" }, ...attachments]);
  f.language("en");
  assert.equal((await claim.submit("make it", scope, [])).kind, "success");
  assert.equal(f.sent[1].content[0].text, guidance.en.prompt + "\n\nmake it");
  f.enabled(false); assert.equal((await claim.submit("make it", scope, [])).kind, "error");
  f.enabled(true); f.version("0.1.0"); assert.equal((await claim.submit("make it", scope, [])).kind, "error");
  assert.equal(f.sent.length, 2);
  assert.equal(await source.matchEnter({}, "/ordinary"), undefined);
  f.version(guide.version); f.remoteFailure(true);
  assert.equal((await claim.submit("make it", scope, [])).kind, "error");
  assert.equal(f.sent.length, 2);
});

test("缺引导、未启用和旧版本均回到原生设置；打开新对话保留已有草稿", async t => {
  const f = await fixture(t); let fallback = 0;
  f.events.get("company-guide/open")("@crysound/unknown", () => fallback++);
  f.enabled(false); f.events.get("company-guide/open")(guide.name, () => fallback++);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(fallback, 2);
  f.enabled(true); f.inputState.set({ ...f.inputState.getSnapshot(), draft: "keep this" });
  f.events.get("company-guide/open")(guide.name, () => fallback++);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.inputState.getSnapshot().draft, "keep this");
  assert.equal(f.sent.length, 0);
});

test("桌面代理只请求固定路径、每次使用当前登录且不向网页转发上游头或凭据", async () => {
  const session = { token: "fake-current", name: "fixture", avatar: "" };
  assert.equal((await companyGuideResponse("https://gateway.test", undefined, () => assert.fail())).status, 401);
  const response = await companyGuideResponse("https://gateway.test", session, async (url, options) => {
    assert.equal(url, "https://gateway.test/_zp/market/guides.json"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer fake-current");
    return Response.json({ guides: [guide] }, { headers: { "set-cookie": "private", authorization: "secret" } });
  });
  assert.equal(response.headers.get("set-cookie"), null); assert.equal(response.headers.get("authorization"), null);
  assert.equal((await response.json()).guides[0].name, guide.name);
  assert.equal((await companyGuideResponse("https://gateway.test", session, async () => { throw new Error("offline"); })).status, 503);
});

test("包引导拒绝缺语言、过长文本、非三个示例；只保留文本不执行代码", () => {
  assert.deepEqual(parsePluginGuide(guidance), guidance);
  for (const value of [null, {}, { zh: guidance.zh }, { ...guidance, en: { ...guidance.en, examples: ["one"] } }, { ...guidance, zh: { ...guidance.zh, prompt: "x".repeat(501) } }]) assert.throws(() => parsePluginGuide(value));
});

test("固定发布模块修补幂等、兼容数据按钮先后顺序；未知入口失败且保留原字节", { skip: !process.env.GUIDE_RUNTIME }, () => {
  const root = process.env.GUIDE_RUNTIME;
  const entry = fs.readFileSync(path.join(root, "ui-entry-customization/lib/client.js"), "utf8");
  const market = fs.readFileSync(path.join(root, "ui-plugin-market/lib/client.js"), "utf8");
  const conversation = fs.readFileSync(path.join(root, "ui-conversation/lib/client.js"), "utf8");
  const patched = patchMarketGuides(patchMarketEntry(entry));
  new vm.Script(patched); assert.equal(patchMarketGuides(patched), patched);
  for (const text of [patchDataUse(patchGuideUse(patchMarketCatalog(market))), patchGuideUse(patchDataUse(patchMarketCatalog(market)))]) new vm.Script(text);
  const next = patchGuidePlaceholder(conversation); new vm.Script(next); assert.equal(patchGuidePlaceholder(next), next);
  assert.throws(() => patchMarketGuides(entry.replace('function apply(ctx)', 'function changed(ctx)')));
});

test("旧引导升级后与新补丁字节一致；首页实际渲染快捷插槽", { skip: !process.env.GUIDE_RUNTIME }, () => {
  const root = process.env.GUIDE_RUNTIME;
  const entry = fs.readFileSync(path.join(root, "ui-entry-customization/lib/client.js"), "utf8");
  const patched = patchMarketGuides(patchMarketEntry(entry));
  const legacy = patched.replace("package guides v3", "package guides v1")
    .replace('"remote", "remote.pluginManager"', '"remote.pluginManager"')
    .replace(installCompanyGuides.toString(), "function installCompanyGuides() { throw new Error('legacy'); }");
  assert.equal(patchMarketGuides(legacy), patched);
  assert.equal(patchMarketGuides(legacy.replace("package guides v1", "package guides v2").replace('"remote.pluginManager"', '"remote", "remote.pluginManager"')), patched);
  const conversation = fs.readFileSync(path.join(root, "ui-conversation/lib/client.js"), "utf8");
  const next = patchGuidePlaceholder(conversation);
  assert.ok(!next.includes('variant === "composer" && input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {})'));
  assert.throws(() => patchMarketGuides(legacy.replace("function installCompanyGuides", "function unsupported")));
});


test("五模块先全部核对才写入，修补断开硬链接且第二次执行字节不变", { skip: !process.env.GUIDE_RUNTIME }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-guides-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ["ui-entry-customization", "ui-plugin-market", "ui-plugin-manager", "ui-sidebar", "ui-conversation"];
  const originals = names.map(name => fs.readFileSync(path.join(process.env.GUIDE_RUNTIME, name, "lib/client.js")));
  const files = names.map((name, i) => {
    const file = path.join(root, `@deepseek-ai/dsh-client-${name}/lib/client.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, originals[i]);
    fs.linkSync(file, path.join(root, name + ".original")); return file;
  });
  const modes = files.map(file => fs.statSync(file).mode);
  fs.writeFileSync(files[4], "unsupported conversation");
  assert.throws(() => patchCompanyMarketRuntime(root));
  for (let i = 0; i < 4; i++) assert.deepEqual(fs.readFileSync(files[i]), originals[i]);
  fs.writeFileSync(files[4], originals[4]);
  patchCompanyMarketRuntime(root);
  const patched = files.map(file => fs.readFileSync(file));
  patchCompanyMarketRuntime(root);
  for (const [i, file] of files.entries()) {
    new vm.Script(patched[i].toString());
    assert.deepEqual(fs.readFileSync(file), patched[i]);
    assert.equal(fs.statSync(file).mode, modes[i]);
    assert.deepEqual(fs.readFileSync(path.join(root, names[i] + ".original")), originals[i]);
  }
});
