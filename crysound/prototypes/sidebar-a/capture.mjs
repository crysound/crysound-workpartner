// Recheck the static prototype using an explicitly selected, existing CDP tab.
// Node >= 24; CDP_TAB=<own tab> node capture.mjs <prototype HTTP URL>
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base = process.argv[2];
assert(base && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(base), 'Supply the local prototype HTTP URL');
assert(process.env.CDP_TAB, 'Create your own browser tab first, then set CDP_TAB');
const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const tabs = await (await fetch(`${endpoint}/json/list`)).json();
const tab = tabs.find(t => t.id === process.env.CDP_TAB);
assert(tab, 'Selected browser tab is unavailable');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map(), errors = [], results = [];
socket.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && !m.params.response.url.endsWith('favicon.ico')) errors.push(`${m.params.response.status} ${m.params.response.url}`);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const messageId = ++id;
  pending.set(messageId, { resolve, reject });
  socket.send(JSON.stringify({ id: messageId, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 180));
const expect = async (name, expression) => { assert.equal(await evaluate(expression), true, name); results.push(name); };
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const load = async (suffix = '', width = 1440, height = 720) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await send('Page.navigate', { url: base + suffix });
  for (let i = 0; i < 60; i++) {
    await tick();
    if (await evaluate(`location.href === ${JSON.stringify(base + suffix)} && document.readyState === 'complete' && !!document.querySelector('.composer')`)) return;
  }
  throw new Error('Prototype did not finish loading');
};
const capture = async name => {
  await evaluate('document.fonts.ready');
  await tick();
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`screenshots/${name}.png`, import.meta.url), Buffer.from(r.data, 'base64'));
};
try {
  await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable'); await send('Network.enable');
  await load();
  await expect('brand assets loaded', '[...document.images].every(i=>i.complete && i.naturalWidth>0)');
  await expect('four primary entries, recent list directly below', 'document.querySelectorAll("nav [data-page]").length===4 && document.querySelector("nav").nextElementSibling.classList.contains("recent")');
  const count = await evaluate(`(()=>{const box=document.querySelector('#conversation-list').getBoundingClientRect();return [...document.querySelectorAll('.conversation-row')].filter(el=>{const r=el.getBoundingClientRect();return r.top>=box.top&&r.bottom<=box.bottom}).length})()`);
  results.push(`1440x720: ${count} fully visible prototype conversations; baseline 6 including blank`);
  await capture('light');
  await click('.search-trigger');
  await expect('search opens and focuses input', 'document.querySelector("#search-dialog").open && document.activeElement.id==="search-input"');
  await evaluate('document.querySelector("#search-input").value="产品";document.querySelector("#search-input").dispatchEvent(new Event("input"))');
  await expect('search filters matching titles', 'document.querySelectorAll("#search-results button").length===3 && [...document.querySelectorAll("#search-results button")].every(e=>e.textContent.includes("产品"))');
  await click('#search-results button');
  await expect('search result opens selected conversation', '!document.querySelector("#search-dialog").open && document.querySelector("#page-label").textContent==="整理产品调研记录" && document.querySelector(".conversation-title[aria-current]")?.textContent==="整理产品调研记录"');
  await click('[data-page="market"]'); await expect('market opens', 'document.querySelector("#page-label").textContent==="市场" && document.querySelectorAll(".card").length===4');
  await click('[data-page="automation"]'); await expect('automation remains reachable', 'document.querySelector("#page-content").textContent.includes("每周项目摘要")');
  await click('[data-page="works"]'); await expect('works opens creation results', 'document.querySelectorAll(".art-preview").length===2');
  await click('[data-tab="overview"]'); await expect('merged work overview retains three categories', '["我的飞书待办","本周日程","项目跟进"].every(t=>document.querySelector("[role=tabpanel]").textContent.includes(t))');
  await click('#review-options');
  await evaluate('document.querySelector("#theme").value="dark";document.querySelector("#theme").dispatchEvent(new Event("change"));document.querySelector("#options-dialog").close()');
  await expect('dark mode applies', 'getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()==="#19181e"');
  await capture('dark');
  await click('#account-trigger'); await expect('web download is inside personal menu', '!document.querySelector(".account-menu").hidden && !document.querySelector("#download").hidden && document.querySelector("#download").closest(".account-menu")!==null');
  await evaluate('document.querySelector("#shell").value="desktop";document.querySelector("#shell").dispatchEvent(new Event("change"))');
  await expect('desktop hides download', 'document.querySelector("#download").hidden');
  await evaluate('document.querySelector("#workspace-mode").value="multi";document.querySelector("#workspace-mode").dispatchEvent(new Event("change"))');
  await expect('multiple workspaces retain grouping', 'document.querySelectorAll(".workspace-group").length===2');
  await load();
  await click('#view-options');
  await evaluate('document.querySelector("#archive").value="show";document.querySelector("#archive").dispatchEvent(new Event("change"))');
  await expect('archived conversations remain reachable', 'document.querySelector("#conversation-list").textContent.includes("首页视觉探索 · 已归档")');
  await evaluate('document.querySelector("#list-dialog").close()');
  await click('.collapse-trigger');
  await expect('collapsed rail leaves primary navigation usable', 'document.querySelector("#sidebar").getBoundingClientRect().width===64 && [...document.querySelectorAll("nav button")].every(e=>e.getBoundingClientRect().width>0)');
  await capture('collapsed');
  await click('.search-trigger'); await expect('collapsed search works', 'document.querySelector("#search-dialog").open');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await expect('escape dismisses search', '!document.querySelector("#search-dialog").open');
  await load('', 390, 844);
  await expect('mobile fits viewport and hidden drawer is inert', 'document.documentElement.scrollWidth===390 && document.querySelector("#sidebar").inert && !document.body.classList.contains("drawer-open")');
  await click('#mobile-open');
  await expect('mobile drawer opens with focus', 'document.body.classList.contains("drawer-open") && document.querySelector("#sidebar").contains(document.activeElement) && !document.querySelector(".scrim").hidden');
  await capture('mobile');
  await click('[data-page="works"]');
  await expect('mobile selecting a page dismisses drawer', '!document.body.classList.contains("drawer-open") && document.querySelector("#page-label").textContent==="作品" && document.documentElement.scrollWidth===390');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 720, deviceScaleFactor: 1, mobile: false });
  await tick();
  await expect('resizing mobile to desktop restores sidebar interaction', '!document.querySelector("#sidebar").inert && !document.body.classList.contains("drawer-open")');
  await load();
  await send('Page.navigate', { url: new URL('compare.html', base).href });
  for (let i = 0; i < 60; i++) { await tick(); if (await evaluate('document.querySelector("#gain")?.textContent.startsWith("多 ")')) break; }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await capture('comparison');
  await expect('comparison uses real baseline and counts prototype rows', `document.querySelector('#gain').textContent==='多 '+${count - 6}+' 条' && document.querySelector('img').naturalWidth===280`);
  assert.deepEqual(errors, [], 'No page exceptions or failed assets');
  results.push('No page exceptions or failed assets');
  await writeFile(new URL('verification.json', import.meta.url), JSON.stringify({ viewport: '1440x720', checks: results, limits: ['Prototype only; no production runtime, gateway, desktop executable or real data writes exercised.', 'Baseline screenshot is from the live sidebar, with personal details and conversation titles replaced.', 'Mobile screenshot shows the open navigation drawer at 390x844.'] }, null, 2) + '\n');
  console.log(results.join('\n'));
} finally {
  await send('Emulation.clearDeviceMetricsOverride'); socket.close();
}
