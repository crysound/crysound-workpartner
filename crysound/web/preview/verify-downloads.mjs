/** Browser smoke using an explicitly supplied CDP endpoint; all responses stay in an owned tab. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { installPreviewClient } from "./client.mjs";
import { previewDownloadBody } from "./downloads.mjs";

const [endpoint, evidenceDir] = process.argv.slice(2);
if (!endpoint || !evidenceDir) throw new Error("Usage: node verify-downloads.mjs <browser-CDP-URL> <evidence-directory>");
fs.mkdirSync(evidenceDir, { recursive: true });
const tab = await (await fetch(new URL("/json/new?about:blank", endpoint), { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
let id = 0;
const pending = new Map(), events = [], errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const key = ++id;
  pending.set(key, { resolve, reject });
  ws.send(JSON.stringify({ id: key, method, params }));
});
const evaluate = async (expression, contextId) => {
  const result = await send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
const until = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for browser state");
};
const previewHost = "preview.issue-113.test";
const sandbox = "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const main = `<!doctype html><meta charset="utf-8"><title>预览下载验证</title>
<script>(${installPreviewClient.toString()})({previewHost:'${previewHost}',scope:'test'})</script>
<h1>跨源侧栏下载验证</h1>
<iframe id="editor" sandbox="${sandbox}" src="https://${previewHost}/editor" style="width:700px;height:250px"></iframe>
<iframe id="external" sandbox="${sandbox}" src="https://external.issue-113.test/" style="height:30px"></iframe>`;
const editor = `<!doctype html><html><head><meta charset="utf-8">
<script>window.startupFlag=window.__baoyuNativeDownloads;</script></head><body>
<h2>中文演示导出</h2><button id="download">下载中文文件</button><p id="flag"></p><script>
document.getElementById('flag').textContent='原生下载标记：'+window.startupFlag;
document.getElementById('download').onclick=async()=>{
  await Promise.resolve();
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['中文下载内容'],{type:'text/plain'}));
  a.download='中文下载验证.txt'; a.click();
};</script></body></html>`;
const reply = Object.assign(Readable.from([Buffer.from(editor)]), { statusCode: 200 });
const chunks = [];
for await (const chunk of previewDownloadBody(reply, { "content-type": "text/html; charset=utf-8" })) chunks.push(chunk);
const rewritten = Buffer.concat(chunks).toString();
ws.addEventListener("message", async ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const job = pending.get(message.id);
    if (job) {
      pending.delete(message.id);
      if (message.error) job.reject(new Error(JSON.stringify(message.error)));
      else job.resolve(message.result);
    }
    return;
  }
  events.push(message);
  if (message.method !== "Fetch.requestPaused") return;
  const url = message.params.request.url;
  const text = url.startsWith("https://main.issue-113.test/") ? main
    : url.startsWith(`https://${previewHost}/`) ? rewritten : '<!doctype html><title>外部网页</title>';
  try {
    await send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(text).toString("base64") });
  } catch (error) { errors.push(error.message); }
});
try {
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://*.issue-113.test/*" }] });
  await send("Page.navigate", { url: "https://main.issue-113.test/" });
  await until(() => evaluate("document.querySelector('#editor')?.sandbox.contains('allow-downloads')"));
  assert.equal(await evaluate("document.querySelector('#external').sandbox.contains('allow-downloads')"), false);
  const destroyed = () => new Set(events.filter((e) => e.method === "Runtime.executionContextDestroyed").map((e) => e.params.executionContextId));
  const context = await until(() => events.filter((e) => e.method === "Runtime.executionContextCreated"
    && e.params.context.origin === `https://${previewHost}` && !destroyed().has(e.params.context.id)).at(-1)?.params.context.id);
  await until(() => evaluate("window.startupFlag === true", context));
  const frame = await evaluate("(()=>{const r=document.querySelector('#editor').getBoundingClientRect();return {x:r.x,y:r.y}})()");
  const button = await evaluate("(()=>{const r=document.querySelector('#download').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()", context);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: frame.x + button.x + 2, y: frame.y + button.y + 2, button: "left", clickCount: 1 });
  }
  const download = await until(() => events.find((e) => e.method === "Page.downloadWillBegin"));
  assert.equal(download.params.suggestedFilename, "中文下载验证.txt");
  const complete = await until(() => events.find((e) => e.method === "Page.downloadProgress"
    && e.params.guid === download.params.guid && e.params.state === "completed"));
  assert.equal(complete.params.receivedBytes, Buffer.byteLength("中文下载内容"));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(evidenceDir, "native-downloads.png"), Buffer.from(shot.data, "base64"));
  await evaluate("document.querySelector('#editor').src='https://external.issue-113.test/other'");
  await until(() => evaluate("!document.querySelector('#editor').sandbox.contains('allow-downloads')"));
  const firstEvent = events.length;
  await send("Page.navigate", { url: `https://${previewHost}/editor` });
  await until(() => evaluate("window.startupFlag === true && !!document.querySelector('#download')"));
  const standalone = await evaluate("(()=>{const r=document.querySelector('#download').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...standalone, button: "left", clickCount: 1 });
  }
  const standaloneDownload = await until(() => events.slice(firstEvent).find((e) => e.method === "Page.downloadWillBegin"));
  assert.equal(standaloneDownload.params.suggestedFilename, "中文下载验证.txt");
  await until(() => events.slice(firstEvent).find((e) => e.method === "Page.downloadProgress"
    && e.params.guid === standaloneDownload.params.guid && e.params.state === "completed"));
  assert.deepEqual(errors, []);
  assert(!events.some((e) => e.method === "Runtime.exceptionThrown"));
  const result = { startupFlag: true, externalUnchanged: true, revokedOnExternalNavigation: true, standaloneDownload: true,
    filename: download.params.suggestedFilename, download: complete.params };
  fs.writeFileSync(path.join(evidenceDir, "native-downloads.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await send("Fetch.disable");
  ws.close();
  await fetch(new URL(`/json/close/${tab.id}`, endpoint));
}
