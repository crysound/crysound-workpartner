// 在已登录的自有标签页中预览真实运行时；只替换当前标签页响应，不安装插件、不新建或发送会话。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { patchDataMarket } from "../../config/patch-data-market.mjs";
import { dataCategories } from "../gateway/treg-catalog.mjs";

const [tab, platformsFile, outputDir, basePatchFile] = process.argv.slice(2);
if (!tab || !platformsFile || !outputDir) throw new Error("用法：browser-preview.mjs <自有 CDP 标签> <公共 platforms JSON> <截图目录> [市场基础补丁]");
const categories = dataCategories(JSON.parse(fs.readFileSync(platformsFile, "utf8")));
const basePatch = basePatchFile ? (await import(pathToFileURL(path.resolve(basePatchFile)).href)).patchMarketUi : (text) => text;
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json/list`)).json();
const page = pages.find((value) => value.id === tab);
if (!page) throw new Error("自有浏览器标签不存在");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 0, catalogFailure = false;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || "浏览器验证表达式失败");
  return value.result?.value;
};
const until = async (expression) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("浏览器预览等待超时");
};
function replaceOnce(text, find, replacement) {
  assert.equal(text.split(find).length, 2, "预览观察点必须唯一命中");
  return text.replace(find, () => replacement);
}
ws.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const promise = pending.get(message.id);
    if (promise) { pending.delete(message.id); message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result); }
    return;
  }
  if (message.method !== "Fetch.requestPaused") return;
  const value = message.params;
  try {
    let body, status = 200, headers = value.responseHeaders ?? [{ name: "content-type", value: "application/json" }];
    if (value.request.url.endsWith("/_zp/market/data.json")) {
      status = catalogFailure ? 503 : 200;
      body = JSON.stringify(catalogFailure ? { error: "数据目录暂时无法读取，请联系管理员" } : { categories, registry: "https://partner.example.test/_zp/npm/" });
    } else if (value.request.url.endsWith("/_zp/market/index.json")) {
      body = JSON.stringify({ format: 1, plugins: [{ name: "@crysound/data", versions: [{ version: "0.1.0" }] }] });
    } else {
      const result = await send("Fetch.getResponseBody", { requestId: value.requestId });
      body = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8").toString();
      const position = body.indexOf('id: "@deepseek-ai/dsh-client-ui-plugin-manager"');
      const start = body.lastIndexOf("window.__ModuleLoader__.load({", position);
      let end = body.indexOf("window.__ModuleLoader__.load({", position + 1); if (end < 0) end = body.length;
      assert.ok(position >= 0 && start >= 0, "必须是实际插件管理器模块");
      let client = patchDataMarket(basePatch(body.slice(start, end)));
      client = replaceOnce(client, 'const face = controller.inject(configLedger, tabLedgerSource(ctx), (text) => ctx.locale.resolveText(text));',
        'const face = controller.inject(configLedger, tabLedgerSource(ctx), (text) => ctx.locale.resolveText(text)); window.__dataPreview = { ctx, controller };');
      client = replaceOnce(client, 'dataCtx.uiWorkspace.startSession(undefined, { prompt: card.prompt, whenDraftExists: "append" })',
        '(window.__dataDraft = { prompt: card.prompt, whenDraftExists: "append" })');
      client = replaceOnce(client, 'props.openPackage("@crysound/data")', '(window.__dataOpenPackage = "@crysound/data")');
      client = replaceOnce(client, 'else if (version) props.install(', 'else if (version) window.__dataInstall = (');
      body = body.slice(0, start) + client + body.slice(end);
    }
    await send("Fetch.fulfillRequest", { requestId: value.requestId, responseCode: status,
      responseHeaders: headers.filter((header) => !["content-encoding", "content-length", "etag"].includes(header.name.toLowerCase())),
      body: Buffer.from(body).toString("base64") });
  } catch (error) { errors.push(String(error)); await send("Fetch.continueRequest", { requestId: value.requestId }); }
});

try {
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: [
    { urlPattern: "*plugins/*dsh-client-ui-plugin-manager/client.js*", requestStage: "Response" },
    { urlPattern: "*/_zp/market/data.json", requestStage: "Request" },
    { urlPattern: "*/_zp/market/index.json", requestStage: "Request" },
  ] });
  await send("Page.reload", { ignoreCache: true });
  await until("!!window.__dataPreview");
  await evaluate('window.__dataPreview.ctx.locale.publish("zh", false); window.__dataPreview.ctx.pluginNavigation.openList();');
  await until('[...document.querySelectorAll("[role=tab]")].some(node => node.textContent === "数据")');
  const selectData = () => evaluate('[...document.querySelectorAll("[role=tab]")].find(node => node.textContent === "数据").click()');
  await selectData();
  await until('document.querySelectorAll("[data-zp-data-market] article").length === 7');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-zp-data-market] h3")].map(node => node.textContent)'), categories.map((card) => card.name));
  assert.ok((await evaluate('document.querySelector("[data-zp-data-market] footer span").textContent')).startsWith("$"));
  await until('document.querySelector("[data-zp-data-market] article button")?.textContent === "安装后使用" && !document.querySelector("[data-zp-data-market] article button").disabled');
  await evaluate('document.querySelector("[data-zp-data-market] article button").click()');
  const install = await evaluate("window.__dataInstall");
  assert.equal(install.spec, "@crysound/data@0.1.0"); assert.equal(install.registry, "https://partner.example.test/_zp/npm/");
  await evaluate('window.__dataOriginalPackages=window.__dataPreview.controller.getSnapshot().packages; window.__dataPreview.controller.patch({ packages: [{name:"@crysound/data",enabled:true,rows:[{enabled:true}]}] });');
  await until('document.querySelector("[data-zp-data-market] article button").textContent === "使用"');
  await evaluate('document.querySelector("[data-zp-data-market] article button").click()');
  assert.deepEqual(await evaluate("window.__dataDraft"), { prompt: categories[0].prompt, whenDraftExists: "append" });
  await evaluate('const note=document.createElement("p");note.textContent="界面预览 · 公共目录 · 尚未上线验收";note.style="font-size:12px;color:#887148";document.querySelector("[data-zp-data-market] header").append(note);');
  fs.mkdirSync(outputDir, { recursive: true });
  const shot = async (name, width, height) => {
    await evaluate('window.__dataPreview.ctx.locale.publish("zh", false)');
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const clip = await evaluate('(()=>{const r=document.querySelector("[data-zp-data-market]").getBoundingClientRect();return {x:r.left,y:Math.max(0,r.top-84),width:r.width,height:r.height+Math.min(84,r.top),scale:1};})()');
    assert.ok(!(await evaluate("document.documentElement.scrollWidth > innerWidth")), "页面不应横向溢出");
    const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
    fs.writeFileSync(path.join(outputDir, name), Buffer.from(image.data, "base64"));
  };
  await shot("data-desktop.png", 1440, 1600);
  await shot("data-narrow.png", 820, 2600);
  await evaluate('window.__dataPreview.controller.patch({ packages: [{name:"@crysound/data",enabled:false,rows:[{enabled:false}]}] });');
  await until('document.querySelector("[data-zp-data-market] article button").textContent === "启用插件"');
  await evaluate('document.querySelector("[data-zp-data-market] article button").click()');
  assert.equal(await evaluate("window.__dataOpenPackage"), "@crysound/data");
  await evaluate("window.__dataPreview.controller.patch({packages:window.__dataOriginalPackages})");
  catalogFailure = true;
  const reloadTab = async () => {
    await evaluate('[...document.querySelectorAll("[role=tab]")].find(node => ["已安装", "Installed"].includes(node.textContent)).click()');
    await selectData();
  };
  await reloadTab();
  await until('document.querySelector("[data-zp-data-market]")?.textContent.includes("暂时无法读取")');
  assert.equal(await evaluate('document.querySelectorAll("[data-zp-data-market] article").length'), 0);
  catalogFailure = false;
  await evaluate('[...document.querySelectorAll("[data-zp-data-market] button")].find(node => node.textContent === "重新加载").click()');
  await until('document.querySelectorAll("[data-zp-data-market] article").length === 7');
  assert.deepEqual(errors, []);
  console.log("通过：真实运行时七类卡片、美元价格、安装目标、启用入口、草稿不发送、目录失败与恢复、宽窄截图。点击动作仅观察参数，未执行安装或创建会话。");
} finally {
  await send("Fetch.disable"); await send("Network.setCacheDisabled", { cacheDisabled: false });
  await send("Emulation.clearDeviceMetricsOverride"); ws.close();
}
