// Per-tab response preview against the existing authenticated server. Never deploys or writes user records.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { patchSidebarModule, patchWorkspaceModule } from '../patch-sidebar.mjs';

const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const tabId = process.env.CDP_TAB;
const groupingOnly = process.env.SIDEBAR_GROUPING_ONLY === '1';
if (!tabId) throw new Error('Open a dedicated tab with the configured browser entry, then set CDP_TAB');
const out = path.resolve(process.env.SIDEBAR_EVIDENCE_DIR ?? '.playwright-mcp/sidebar-a');
fs.mkdirSync(out, { recursive: true });
const brand = fileURLToPath(new URL('../../brand/brand.css', import.meta.url));
const skin = fs.readFileSync(new URL('../../brand/skin.css', import.meta.url), 'utf8');
const tabs = await (await fetch(endpoint + '/json/list')).json();
const tab = tabs.find(item => item.id === tabId);
if (!tab) throw new Error('Dedicated tab not found');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map(), errors = [], patched = new Set(), checks = [];
let previousSkin;
let preferencePreviewScript;
let mainNavigations = 0;
let visibleRows;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
// Send data as CDP arguments, never as fragments of executable JavaScript.
const call = async (functionDeclaration, ...values) => {
  const global = await send('Runtime.evaluate', { expression: 'globalThis' });
  const objectId = global.result.objectId;
  try {
    const result = await send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: values.map(value => ({ value })), returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } finally {
    await send('Runtime.releaseObject', { objectId });
  }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reloadPage() {
  const before = mainNavigations;
  await send('Page.reload', { ignoreCache: true });
  const limit = Date.now() + 20000;
  while (mainNavigations === before && Date.now() < limit) await pause(100);
  assert.ok(mainNavigations > before, 'Reload must navigate before checking the new document');
}
async function until(expression, label) {
  const limit = Date.now() + 20000;
  while (Date.now() < limit) {
    if (await evaluate(expression)) { checks.push(label); return; }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function click(selector) {
  const rect = await call('function(selector){const r=document.querySelector(selector)?.getBoundingClientRect();return r&&{x:r.x+r.width/2,y:r.y+r.height/2}}', selector);
  assert.ok(rect, 'Missing control: ' + selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
async function key(key) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}
async function screenshot(name, clip) {
  if (groupingOnly) return;
  await until('!document.getAnimations().some(a=>a.playState==="running" && a.effect?.getTiming().iterations!==Infinity && a.effect?.target?.closest?.("[data-zp-sidebar]"))', 'finite sidebar animations settle: ' + name);
  await pause(100);
  const result = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function skinScreenshot(name, clip, newSessionHeight) {
  await evaluate('document.documentElement.dataset.zpSkin="soft"');
  await until(`Math.round(document.querySelector('[data-zp-sidebar] button[class*="_newSession"]').getBoundingClientRect().height)===${newSessionHeight}`, 'soft skin preserves new-conversation density: ' + name);
  assert.equal(await evaluate('getComputedStyle(document.body).getPropertyValue("--dsw-specific-sidebar-fill").trim()'), name.includes('dark') || name.includes('collapsed') ? '#141414' : '#EEEEE9');
  await screenshot(name, clip);
  await evaluate('document.documentElement.dataset.zpSkin="default"');
}
ws.onmessage = async event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    return;
  }
  if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) mainNavigations++;
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    errors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').split('\n')[0]);
  }
  if (message.method !== 'Fetch.requestPaused') return;
  const paused = message.params;
  try {
    const result = await send('Fetch.getResponseBody', { requestId: paused.requestId });
    let body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
    if (paused.request.url.includes('/plugins/')) {
      for (const [name, patch] of [['ui-sidebar', patchSidebarModule], ['ui-workspace', patchWorkspaceModule]]) {
        const index = body.indexOf('id: "@deepseek-ai/dsh-client-' + name + '"');
        if (index < 0) continue;
        const moduleStart = at => {
          const marker = body.slice(Math.max(0, at - 256), at).match(/(?:\/\* CRYSOUND [^\n]* \*\/\n)+$/);
          return at - (marker?.[0].length ?? 0);
        };
        const start = moduleStart(body.lastIndexOf('window.__ModuleLoader__.load({', index));
        const next = body.indexOf('window.__ModuleLoader__.load({', index);
        const end = next < 0 ? next : moduleStart(next);
        assert.ok(start >= 0);
        const chunk = body.slice(start, end < 0 ? undefined : end);
        body = body.slice(0, start) + patch(chunk) + (end < 0 ? '' : body.slice(end));
        patched.add(name);
      }
    } else {
      body = fs.readFileSync(brand, 'utf8');
      patched.add('brand.css');
    }
    await send('Fetch.fulfillRequest', {
      requestId: paused.requestId, responseCode: paused.responseStatusCode,
      responseHeaders: paused.responseHeaders.filter(header => !['content-length', 'content-encoding', 'etag'].includes(header.name.toLowerCase())),
      body: Buffer.from(body).toString('base64'),
    });
  } catch (error) {
    errors.push(String(error));
    await send('Fetch.continueRequest', { requestId: paused.requestId });
  }
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 720, deviceScaleFactor: 1, mobile: false });
  errors.length = 0;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/*', requestStage: 'Response' }, { urlPattern: '*/brand.css*', requestStage: 'Response' }] });
  // Isolate only the view preference in this dedicated tab's sessionStorage, including reloads.
  // All other storage and every business API keep their existing behavior.
  await call('function(){sessionStorage.removeItem("zp.sidebar.grouping-preview") }');
  ({ identifier: preferencePreviewScript } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const storage = window.localStorage;
    const name = 'dsh.workspace.view.v5', scratch = 'zp.sidebar.grouping-preview';
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(storage, {
      get(target, prop) {
        if (prop === 'getItem') return key => key === name ? sessionStorage.getItem(scratch) : target.getItem(key);
        if (prop === 'setItem') return (key, value) => key === name ? sessionStorage.setItem(scratch, value) : target.setItem(key, value);
        if (prop === 'removeItem') return key => key === name ? sessionStorage.removeItem(scratch) : target.removeItem(key);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) });
  })()` }));
  await reloadPage();
  await until('document.querySelectorAll("[data-zp-conversations] [data-row-key^=\\"session:\\"]").length > 0', 'published modules activate and load real session rows');
  assert.deepEqual([...patched].sort(), ['brand.css', 'ui-sidebar', 'ui-workspace'], errors.join('\n'));
  if (!groupingOnly) {
  previousSkin = await evaluate('document.documentElement.getAttribute("data-zp-skin")');
  await call("function(skin){const style=document.createElement('style');style.dataset.sidebarSkinPreview='true';style.textContent=skin;document.head.append(style);document.documentElement.dataset.zpSkin='default'}", skin);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-zp-panel]")].map(row=>row.dataset.zpPanel).slice(0,3)'), ['baoyu-design.artifacts', 'schedules', 'plugins']);
  checks.push('fixed panel order and single-workspace flattening');
  assert.equal(await evaluate('!![...document.querySelectorAll("[data-zp-conversations] span")].find(x=>x.textContent==="未分组")'), false);
  // Appearance-only masking protects account names and real session titles in shareable evidence.
  await evaluate(`(()=>{const style=document.createElement('style');style.dataset.sidebarEvidence='redacted';style.textContent='[data-zp-conversations] [class*="_title"]{visibility:hidden!important}[data-zp-conversations] [data-row-key^="session:"]{position:relative}[data-zp-conversations] [data-row-key^="session:"]::after{content:"示例对话";font-size:13px;position:absolute;inset:0 auto 0 30px;display:flex;align-items:center;color:var(--dsw-alias-label-primary);pointer-events:none}[data-zp-conversations] [class*="_tooltip"]{visibility:hidden!important}.zp-avatar{visibility:hidden!important}[data-zp-name] span{font-size:0!important}[data-zp-name] span::after{content:"示例用户";font-size:13px!important}';document.head.append(style)})()`);
  visibleRows = await evaluate('(()=>{const bounds=document.querySelector("[data-zp-conversations]").getBoundingClientRect();return [...document.querySelectorAll("[data-zp-conversations] [data-row-key^=\\"session:\\"]")].filter(el=>{const r=el.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=Math.min(bounds.bottom,720)}).length})()');
  await screenshot('web-light', { x: 0, y: 0, width: 280, height: 720 });
  await skinScreenshot('soft-light', { x: 0, y: 0, width: 280, height: 720 }, 32);
  await click('[data-zp-sidebar-search]');
  await until('document.querySelector("[data-zp-conversations]").dataset.searchExpanded==="true" && document.activeElement.tagName==="INPUT"', 'top search opens and focuses the existing search input');
  await send('Input.insertText', { text: '声学' });
  await until('document.querySelector("[data-zp-conversations] input").value==="声学" && document.querySelectorAll("[class*=\\"_searchResultRow\\"]").length>0', 'real search returns results');
  await key('Escape');
  await until('document.querySelector("[data-zp-conversations]").dataset.searchExpanded==="false"', 'Escape closes search');
  await click('[data-zp-conversations] button[aria-label="视图选项"]');
  await until('!![...document.querySelectorAll("[role=menuitem]")].find(x=>x.textContent.includes("管理工作区"))', 'single-workspace management remains in view options');
  assert.ok(await evaluate('document.querySelector("[role=menu]").textContent.includes("归档")'));
  checks.push('archive filters remain accessible');
  await key('Escape');
  await click('[data-zp-panel="plugins"]');
  await until('document.querySelector("[data-zp-panel=plugins]").getAttribute("aria-current")==="page"', 'market opens through its original panel callback');
  await screenshot('web-market', { x: 0, y: 0, width: 280, height: 720 });
  // Theme and viewport changes below are local to this preview tab and restored in finally.
  await evaluate('document.body.setAttribute("data-ds-dark-theme","")');
  await screenshot('web-dark', { x: 0, y: 0, width: 280, height: 720 });
  await skinScreenshot('soft-dark', { x: 0, y: 0, width: 280, height: 720 }, 32);
  await click('[data-sidebar-toggle]');
  await until('document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")', 'collapsed rail settles');
  await screenshot('web-collapsed', { x: 0, y: 0, width: 56, height: 720 });
  await skinScreenshot('soft-collapsed', { x: 0, y: 0, width: 56, height: 720 }, 36);
  await click('[data-zp-sidebar-search]');
  await until('document.querySelector("[data-zp-conversations]").dataset.searchExpanded==="true" && document.activeElement.tagName==="INPUT"', 'rail search expands and focuses search');
  await key('Escape');
  await evaluate('document.body.removeAttribute("data-ds-dark-theme")');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until('!!document.querySelector("[data-sidebar-opener]")', 'narrow viewport supplies the original drawer opener');
  await click('[data-sidebar-opener]');
  await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")==="true"', 'phone drawer opens');
  await screenshot('web-mobile', { x: 0, y: 0, width: 280, height: 844 });
  await skinScreenshot('soft-mobile', { x: 0, y: 0, width: 280, height: 844 }, 40);
  await key('Escape');
  await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")!=="true"', 'Escape closes phone drawer');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 720, deviceScaleFactor: 1, mobile: false });
  const reload = async label => {
    await reloadPage();
    await until('!!document.querySelector("[data-zp-conversations] button[aria-label=\\"视图选项\\"]") && document.querySelectorAll("[data-zp-conversations] [data-row-key^=\\"session:\\"]").length>0', label);
  };
  const selectedGroup = async () => {
    await click('[data-zp-conversations] button[aria-label="视图选项"]');
    await until('!!document.querySelector("[role=menu]")', 'view menu opens');
    const selected = await evaluate('[...document.querySelectorAll("[role=menuitem]")].filter(el=>el.className.includes("_selected_")).map(el=>el.textContent.trim()).filter(text=>["按工作区","按工作区树","单列表"].includes(text))');
    await key('Escape');
    return selected;
  };
  await reload('single-workspace automatic projection after reload');
  assert.deepEqual(await selectedGroup(), ['单列表']);
  await click('[data-zp-conversations] button[aria-label="视图选项"]');
  await call('function(){[...document.querySelectorAll("[role=menuitem]")].find(el=>el.textContent.trim()==="按工作区树").click()}');
  await until('JSON.parse(sessionStorage.getItem("zp.sidebar.grouping-preview")).groupByExplicit===true', 'manual choice writes the explicit marker in isolated preference');
  await reload('manually selected tree survives a real page reload');
  assert.deepEqual(await selectedGroup(), ['按工作区树']);
  for (const [mode, explicit, expected] of [['workspace', undefined, '单列表'], ['workspace-tree', undefined, '按工作区树'], ['flat', undefined, '单列表'], ['workspace-tree', false, '单列表']]) {
    await call('function(mode,explicit){sessionStorage.setItem("zp.sidebar.grouping-preview",JSON.stringify({groupBy:mode,groupByExplicit:explicit,orderBy:"updated",groupExpansion:{},sessionOrderByAccount:{},archivedFilter:"default"}))}', mode, explicit);
    await reload('legacy/reset grouping reload: ' + mode + '/' + explicit);
    assert.deepEqual(await selectedGroup(), [expected]);
  }
  checks.push('real browser reload preserves manual tree, reads legacy flat/tree, treats legacy workspace as automatic, and resets manual intent');
  assert.deepEqual(errors, []);
  const verification = { preview: 'Per-tab response substitution and local skin stylesheet over the existing authenticated server. Not a deployed build or Electron.', screenshots: groupingOnly ? 'Skipped for the grouping regression run' : 'Generated', preferenceIsolation: 'Only dsh.workspace.view.v5 is redirected into dedicated-tab sessionStorage; the real device preference is untouched.', redaction: groupingOnly ? 'No screenshots or user text recorded' : 'Account names and real session titles visually masked; all behavior assertions use real application data.', viewport: groupingOnly ? '1440x720' : '1440x720; phone 390x844', visibleRows, patched: [...patched], checks, errors, notVerified: ['Real Electron on macOS/Windows', 'Plugin install/update/disable/reinstall lifecycle on a scratch profile', 'Multiple workspace and unassigned-session lifecycle on a scratch profile', 'Rename/pin/archive/restore/drag mutations on scratch data', 'Skin #133 combined image deployment', 'Real model round and built-server GIF'] };
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
  console.log(JSON.stringify(verification));
} finally {
  await send('Fetch.disable');
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  await send('Emulation.clearDeviceMetricsOverride');
  if (preferencePreviewScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preferencePreviewScript });
  await call('function(){sessionStorage.removeItem("zp.sidebar.grouping-preview") }');
  await call('function(previousSkin){document.querySelector("style[data-sidebar-evidence]")?.remove();document.querySelector("style[data-sidebar-skin-preview]")?.remove();document.body.removeAttribute("data-ds-dark-theme");if(previousSkin===null)document.documentElement.removeAttribute("data-zp-skin");else if(previousSkin!==undefined)document.documentElement.setAttribute("data-zp-skin",previousSkin)}', previousSkin);
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  ws.close();
  await closed;
}
