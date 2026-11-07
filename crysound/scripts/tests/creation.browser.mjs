// Per-tab response preview against the existing authenticated server. Never deploys or writes user records.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { patchSidebarModule, patchWorkspaceModule } from '../patch-sidebar.mjs';

const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const tabId = process.env.CDP_TAB;
if (!tabId) throw new Error('Open a dedicated tab with the configured browser entry, then set CDP_TAB');
const out = path.resolve(process.env.SIDEBAR_EVIDENCE_DIR ?? '.playwright-mcp/creation-sidebar');
fs.mkdirSync(out, { recursive: true });
const tabs = await (await fetch(endpoint + '/json/list')).json();
const tab = tabs.find(item => item.id === tabId);
if (!tab) throw new Error('Dedicated tab not found');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map(), errors = [], patched = new Set(), checks = [];
let preferencePreviewScript;
let mainNavigations = 0;
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
  await call('function(selector){const e=document.querySelector(selector);if(!e)throw new Error("Missing control");e.click()}',selector);
}

async function key(key) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}
async function screenshot(name, clip) {
  await pause(350);
  const result = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
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
        if (name === 'skin.js') body += '\nwindow.__zpSkinFirstPaint = document.documentElement.dataset.zpSkin;';
      patched.add(name);
      }
      if (body.includes('id: "@crysound/artifacts"')) {
        body = body.replaceAll('兆华作品', '作品');
        patched.add('artifacts');
      }
    } else {
      const name = new URL(paused.request.url).pathname.split('/').pop();
      if (!['brand.css', 'skin.css', 'skin.js'].includes(name)) throw new Error('Unexpected preview asset');
      body = fs.readFileSync(new URL('../../brand/' + name, import.meta.url), 'utf8');
      if (name === 'skin.js') body += '\nwindow.__zpSkinFirstPaint = document.documentElement.dataset.zpSkin;';
      patched.add(name);
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Fetch.enable', { patterns: ['*/plugins/*', '*/brand.css*', '*/skin.css*', '*/skin.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Response' })) });
  ({ identifier: preferencePreviewScript } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const storage = window.localStorage, overrides = new Map();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(storage, {
      get(target, prop) {
        if (prop === 'getItem') return key => overrides.has(key) ? overrides.get(key) : target.getItem(key);
        if (prop === 'setItem') return (key,value) => { overrides.set(key,String(value)); };
        if (prop === 'removeItem') return key => { overrides.set(key,null); };
        const value = Reflect.get(target,prop,target); return typeof value === 'function' ? value.bind(target) : value;
      }
    }) });
  })()` }));
  await reloadPage();
  await until('!!document.querySelector("[data-zp-inline-search]") && !!document.querySelector("[data-zp-panel=\\"crysound-artifacts.artifacts\\"]")', 'search and company works mount');
  await until('document.querySelector("[data-zp-panel=\\"crysound-artifacts.artifacts\\"]").textContent==="作品"','works label is unbranded');
  const expected = ['crysound-artifacts.artifacts','schedules','plugins'];
  const ids = await evaluate('[...document.querySelectorAll("[data-zp-panel]")].map(e=>e.dataset.zpPanel)');
  assert.deepEqual(ids, expected);
  checks.push('one company works before automation and market; no upstream or companion rows');
  const versions = await evaluate('fetch("/_zp/market/guides.json").then(r=>r.json()).then(b=>b.guides.map(({name,version})=>({name,version})))');
  const configured = JSON.parse(fs.readFileSync(new URL('../../config/plugins.json',import.meta.url),'utf8')).plugins.filter(p=>p.missingOnly);
  for(const plugin of configured) assert.ok(versions.some(v=>v.name===plugin.name&&v.version===plugin.want), 'approved market version: '+plugin.spec);
  checks.push('all six pinned versions match the live approved market catalog');
  // Crop to navigation and mask personal names and conversation titles before recording evidence.
  await call(`function(){const style=document.createElement('style');style.textContent='[data-zp-conversations] [class*="_title"]{visibility:hidden!important}[data-row-key^="session:"]{position:relative}[data-row-key^="session:"]::after{content:"示例对话";font-size:13px;position:absolute;left:32px;top:8px;color:var(--dsw-alias-label-primary);pointer-events:none}.zp-avatar{visibility:hidden!important}[data-zp-name] span{font-size:0!important}[data-zp-name] span::after{content:"示例用户";font-size:13px!important}';document.head.append(style)}`);
  await click('[data-zp-panel="crysound-artifacts.artifacts"]');
  await until('document.querySelector("[data-zp-panel=\\"crysound-artifacts.artifacts\\"]").getAttribute("aria-current")==="page"','company works opens its native panel');
  await until('!!document.querySelector(".bda-page")','real works page mounts');
  assert.equal(await evaluate('document.querySelector(".bda-page").innerText.includes("兆华作品")'), false);
  checks.push('real works page mounted and contains no old page name');
  await click('.bda-tool[aria-label="新建"]');
  await until('document.querySelectorAll("[role=menuitem][data-skill]").length===5','five installed creation skills in native New menu');
  const createButtons=await evaluate('[...document.querySelectorAll("[role=menuitem][data-skill]")].map(e=>({skill:e.dataset.skill,disabled:e.disabled}))');
  assert.deepEqual(createButtons.map(b=>b.skill).sort(),['crysound-dashboard','crysound-design','crysound-design-system','crysound-motion','crysound-slides']);
  assert.ok(createButtons.every(b=>!b.disabled));
  await key('Escape');
  checks.push('observed creation controls: '+JSON.stringify(createButtons));
  for(const dark of [false,true]) {
    await call('function(dark){document.body.toggleAttribute("data-ds-dark-theme",dark)}',dark);
    const theme=dark?'dark':'light';
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-zp-panel]")].map(e=>e.dataset.zpPanel)'),expected);
    await screenshot(theme+'-expanded',{x:0,y:0,width:280,height:900});
    await click('[data-sidebar-toggle]');
    await until('document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")','collapsed navigation');
    const works = await evaluate('document.querySelector("[data-zp-panel=\\"crysound-artifacts.artifacts\\"]").getAttribute("aria-label")');
    assert.equal(works,'作品');
    await screenshot(theme+'-collapsed',{x:0,y:0,width:56,height:900});
    await click('[data-sidebar-toggle]');
    await until('!document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")','expanded navigation restored');
    if (!process.env.CREATION_SKIP_MOBILE) {
    await pause(500);
    await click('[data-row-key^="session:"]');
    await until('!document.querySelector(".bda-page")','conversation shell for native mobile drawer');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await until('!!document.querySelector("[data-sidebar-opener]")','mobile opener');
    await click('[data-sidebar-opener]');
    await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")==="true"','mobile drawer opens');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-zp-panel]")].map(e=>e.dataset.zpPanel)'),expected);
    await screenshot(theme+'-mobile',{x:0,y:0,width:280,height:844});
    await key('Escape');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await until('!!document.querySelector("[data-sidebar-toggle]")','desktop restored');
    }
    await click('[data-zp-panel="crysound-artifacts.artifacts"]');
    await until('!!document.querySelector(".bda-page")','works page restored');
  }
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({preview:'Branch response substitution in a dedicated authenticated persistent-browser tab; no deployment or user file changes.',versions,patched:[...patched],checks,errors,notVerified:[...(process.env.CREATION_SKIP_MOBILE ? ['Mobile drawer and mobile screenshots: the current page did not expose the native opener'] : []),'New and upgraded actual profiles installing from the registry','Four creation editors: native New opens a skill prompt draft; generating new works was not run','Rebuilt partner image and actual Electron package']},null,2)+'\n');
  console.log(JSON.stringify({patched:[...patched],checks,errors}));
  assert.deepEqual(errors,[]);
} finally {
  await send('Fetch.disable'); await send('Network.setCacheDisabled',{cacheDisabled:false}); await send('Emulation.clearDeviceMetricsOverride');
  if(preferencePreviewScript) await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:preferencePreviewScript});
  ws.close();
}
