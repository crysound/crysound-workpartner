// Run against a blank native dsh page in a dedicated, already authenticated CDP tab.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { patchMarketGuides, patchGuideUse, patchGuidePlaceholder } from "../../scripts/patch-market-guides.mjs";

const tab = process.env.CDP_TAB;
if (!tab) throw new Error("CDP_TAB must identify a dedicated test tab");
const output = path.resolve(process.argv[2] ?? ".playwright-mcp/guide-boot");
fs.mkdirSync(output, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/list`)).json();
const target = pages.find(page => page.id === tab);
if (!target) throw new Error("Test tab does not exist");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0, negative = false, executionContext;
const pending = new Map(), errors = [], applied = new Set(), interceptions = new Set();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Page evaluation failed");
  return result.result?.value;
};
const clean = text => String(text).replace(/https?:\/\/[^\s)]+/gu, "<runtime>");
async function intercept(params) {
  try {
    const raw = await send("Fetch.getResponseBody", { requestId: params.requestId });
    let body = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString() : raw.body;
    let changed = false;
    body = body.split(/(?=window\.__ModuleLoader__\.load\(\{)/u).map(part => {
      for (const [name, patch] of [["ui-entry-customization", patchMarketGuides], ["ui-plugin-market", patchGuideUse], ["ui-conversation", patchGuidePlaceholder]]) {
        if (!part.startsWith(`window.__ModuleLoader__.load({\n\tid: "@deepseek-ai/dsh-client-${name}"`)) continue;
        let next = patch(part);
        if (name === "ui-entry-customization") {
          if (negative) next = next.replace('"remote", "remote.pluginManager"', '"remote.pluginManager"');
          // Preserve the underlying activation exception that the native boot screen summarizes.
          next = next.replace("installCompanyGuides(ctx, _deepseek_ai_dsh_client_store.createSnapshotStore, react_jsx_runtime.jsx, react_jsx_runtime.jsxs);",
            'try { installCompanyGuides(ctx, _deepseek_ai_dsh_client_store.createSnapshotStore, react_jsx_runtime.jsx, react_jsx_runtime.jsxs); } catch (error) { console.error("guide activation", error.stack); throw error; }');
        }
        applied.add(name); changed = true; return next;
      }
      return part;
    }).join("");
    if (changed) await send("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: params.responseStatusCode ?? 200,
      responseHeaders: (params.responseHeaders ?? []).filter(header => !["content-length", "content-encoding", "etag"].includes(header.name.toLowerCase())),
      body: Buffer.from(body).toString("base64"),
    });
    else await send("Fetch.continueRequest", { requestId: params.requestId });
  } catch (error) {
    errors.push(clean(error.stack));
    await send("Fetch.continueRequest", { requestId: params.requestId });
  }
}
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback?.reject(message.error); else callback?.resolve(message.result);
  } else if (message.method === "Runtime.executionContextCreated" && message.params.context.auxData?.isDefault) {
    executionContext = message.params.context.id;
    errors.length = 0;
  } else if (message.method === "Runtime.executionContextsCleared") {
    executionContext = undefined;
  } else if (message.method === "Runtime.exceptionThrown" && message.params.exceptionDetails.executionContextId === executionContext) {
    errors.push(clean(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error" && message.params.executionContextId === executionContext) {
    errors.push(message.params.args.map(arg => clean(arg.value ?? arg.description)).join(" "));
  } else if (message.method === "Fetch.requestPaused") {
    const task = intercept(message.params);
    interceptions.add(task);
    void task.then(() => interceptions.delete(task), error => { errors.push(clean(JSON.stringify(error))); interceptions.delete(task); });
  }
});
async function until(expression) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native page did not reach expected state");
}
async function screenshot(name, crop) {
  const clip = crop ? await evaluate(`(() => { const r=document.querySelector('[data-conversation-region="composer"]').getBoundingClientRect(); return {x:r.x,y:0,width:innerWidth-r.x,height:innerHeight,scale:1}; })()`) : undefined;
  const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(shot.data, "base64"));
}
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/plugins/*ui-*/client.js*", requestStage: "Response" }] });
  negative = true; errors.length = 0;
  await send("Page.reload", { ignoreCache: true });
  await until('(document.body?.innerText ?? "").includes("Failed to load plugins")');
  assert.ok(errors.some(error => error.includes('cannot get property "remote" without inject')));
  await screenshot("before", false);
  const before = { failedToLoadPlugins: true, errors: [...errors] };
  negative = false; errors.length = 0; applied.clear();
  await send("Page.reload", { ignoreCache: true });
  await until('document.querySelectorAll(".zp-guide-shortcuts button").length > 1');
  assert.equal(await evaluate('(document.body?.innerText ?? "").includes("Failed to load plugins")'), false);
  assert.deepEqual([...applied].sort(), ["ui-conversation", "ui-entry-customization", "ui-plugin-market"]);
  assert.deepEqual(errors, []);
  const home = await evaluate('Array.from(document.querySelectorAll(".zp-guide-shortcuts button"),button=>button.textContent)');
  await screenshot("after", true);
  const result = {
    method: "full native page reload with tab-local response substitution; real remote API and guide endpoint; no component/session stubs",
    screenshot: "after.png crops out the sidebar and account; before.png is the native boot failure",
    before, after: { failedToLoadPlugins: false, errors: [...errors], patchedModules: [...applied].sort(), home },
    pending: ["approved installed package: shortcut to guide", "approved installed package: market Use to guide", "real model submission", "packaged desktop"],
  };
  fs.writeFileSync(path.join(output, "boot.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("Native startup regression passed; package interaction acceptance remains separate");
} finally {
  await Promise.allSettled([...interceptions]);
  await send("Fetch.disable");
  await send("Network.setCacheDisabled", { cacheDisabled: false });
  ws.close();
  await new Promise(resolve => ws.addEventListener("close", resolve, { once: true }));
}
