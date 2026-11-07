// Per-tab response preview against the existing authenticated server. Never deploys or writes user records.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { patchSidebarModule, patchWorkspaceModule } from '../patch-sidebar.mjs';

const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const tabId = process.env.CDP_TAB;
if (!tabId) throw new Error('Open a dedicated tab with the configured browser entry, then set CDP_TAB');
const out = path.resolve(process.env.SIDEBAR_EVIDENCE_DIR ?? '.playwright-mcp/sidebar-search');
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
      if (body.includes("id: '@crysound/feishu-settings'")) {
        const client = fs.readFileSync(new URL('../../feishu/native/client.js', import.meta.url), 'utf8');
        body = client.replace('window.__ModuleLoader__.load(', 'window.__zpSkinDefinition = (') + `\n;(() => { const load = window.__ModuleLoader__.load;
          window.__ModuleLoader__.load = function(reg) { return load.call(this, reg.id === '@crysound/feishu-settings' ? window.__zpSkinDefinition : reg); };
        })();\n` + body;
        patched.add('settings');
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
  await send('Page.bringToFront');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Fetch.enable', { patterns: ['*/plugins/*', '*/brand.css*', '*/skin.css*', '*/skin.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Response' })) });
  // Isolate appearance and view preferences before first paint, without changing the real device.
  ({ identifier: preferencePreviewScript } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
    const storage = window.localStorage;
    const names = new Set(['zp-interface-style', 'dsh.workspace.view.v5']);
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(storage, {
      get(target, prop) {
        if (prop === 'getItem') return key => names.has(key) ? sessionStorage.getItem('zp146.' + key) : target.getItem(key);
        if (prop === 'setItem') return (key,value) => names.has(key) ? sessionStorage.setItem('zp146.' + key,value) : target.setItem(key,value);
        if (prop === 'removeItem') return key => names.has(key) ? sessionStorage.removeItem('zp146.' + key) : target.removeItem(key);
        const value = Reflect.get(target,prop,target); return typeof value === 'function' ? value.bind(target) : value;
      }
    }) });
  })()` }));
  await call('function(){sessionStorage.removeItem("zp146.zp-interface-style");sessionStorage.removeItem("zp146.dsh.workspace.view.v5")}');
  await reloadPage();
  await until('!!document.querySelector("[data-zp-inline-search]") && document.querySelectorAll("[data-row-key^=\\"session:\\"]").length>0', 'ported search input and real sessions mount');
  if (process.env.SIDEBAR_MARKET_ONLY === '1') {
    const rows = [];
    if (await evaluate('document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")')) await click('[data-sidebar-toggle]');
    for (const skin of ['soft', 'default']) {
      await call('function(skin){document.documentElement.dataset.zpSkin=skin}', skin);
      for (const dark of [false, true]) {
        await call('function(dark){document.body.toggleAttribute("data-ds-dark-theme",dark)}', dark);
        for (const mode of ['desktop', 'collapsed', 'mobile']) {
          await send('Emulation.setDeviceMetricsOverride', { width: mode === 'mobile' ? 390 : 1440, height: 844, deviceScaleFactor: 1, mobile: mode === 'mobile' });
          if (mode === 'collapsed') {
            await click('[data-sidebar-toggle]');
            await until('document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")', 'market rail mounts');
          } else if (mode === 'mobile') {
            await until('!!document.querySelector("[data-sidebar-opener]")', 'market mobile opener');
            await click('[data-sidebar-opener]');
            await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")==="true"', 'market mobile drawer mounts');
          }
          await until('!!document.querySelector("[data-zp-panel=plugins]")', 'market row mounts');
          await until(mode === 'collapsed'
            ? 'document.querySelector("[data-zp-panel=plugins]").innerText.trim()===""'
            : 'document.querySelector("[data-zp-panel=plugins]").innerText.trim()==="市场"', 'market responsive label settles');
          await until('!document.getAnimations().some(a=>a.playState==="running" && a.effect?.getTiming().iterations!==Infinity && a.effect?.target?.closest?.("[data-zp-sidebar]")) && document.querySelector("[data-zp-sidebar]").getBoundingClientRect().x>=0', 'market drawer geometry settles before cropping');
          const row = await call(`function(){
            const el=document.querySelector('[data-zp-panel=plugins]'), r=el.getBoundingClientRect();
            const sidebar=document.querySelector('[data-zp-sidebar]').getBoundingClientRect();
            return {label:el.getAttribute('aria-label'),text:el.innerText.trim(),icons:el.querySelectorAll('svg').length,
              subtitles:el.querySelectorAll('small,.zp-sidebar-market-title').length,
              clip:{x:sidebar.x,y:r.y-4,width:sidebar.width,height:r.height+8}};
          }`);
          assert.equal(row.label, '市场');
          assert.equal(row.text, mode === 'collapsed' ? '' : '市场');
          assert.ok(row.icons > 0);
          assert.equal(row.subtitles, 0);
          const name = [skin, dark ? 'dark' : 'light', mode].join('-');
          await screenshot(name, row.clip);
          rows.push({name,...row});
          checks.push(name + ': market icon, plain accessible name, no subtitle');
          if (mode === 'collapsed') {
            await click('[data-sidebar-toggle]');
            await until('!document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")', 'market sidebar restored');
          } else if (mode === 'mobile') {
            await key('Escape');
            await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")!=="true"', 'market mobile drawer closes');
            await send('Emulation.setDeviceMetricsOverride', { width:1440,height:844,deviceScaleFactor:1,mobile:false });
            await until('!!document.querySelector("[data-zp-inline-search]")', 'market desktop restored');
          }
        }
      }
    }
    assert.deepEqual(errors, []);
    assert.ok(patched.has('ui-sidebar') && patched.has('brand.css'));
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({preview:'Dedicated persistent-browser tab; branch response substitution over the real authenticated server. Not a deployed image or Electron.',patched:[...patched],rows,checks,errors,notVerified:['Rebuilt partner image','Actual macOS/Windows Electron package']},null,2)+'\n');
    console.log(JSON.stringify({screenshots:rows.length,patched:[...patched],errors}));
  } else {
  assert.equal(await evaluate('window.__zpSkinFirstPaint'), 'soft');
  assert.equal(await evaluate('window.zpSkin.get()'), 'soft');
  checks.push('first paint defaults to soft on a device with no saved preference');
  await evaluate('window.zpSkin.set("default")');
  await reloadPage();
  await until('!!document.querySelector("[data-zp-inline-search]")', 'classic remount');
  assert.equal(await evaluate('window.zpSkin.get()'), 'default');
  checks.push('explicit classic survives a real page reload');
  await evaluate('window.zpSkin.set("soft")');
  // Mask private text in screenshots only; search assertions use the real data.
  await call(`function(){const style=document.createElement('style');style.textContent='[data-zp-conversations] [class*="_title"],[class*="_searchResultTitle"],[class*="_searchResultSnippet"],[class*="_searchResultWorkspace"]{visibility:hidden!important}[data-row-key^="session:"],[class*="_searchResultRow"]{position:relative}[data-row-key^="session:"]::after,[class*="_searchResultRow"]::after{content:"示例对话";font-size:13px;position:absolute;left:32px;top:8px;color:var(--dsw-alias-label-primary);pointer-events:none}.zp-avatar{visibility:hidden!important}[data-zp-name] span{font-size:0!important}[data-zp-name] span::after{content:"示例用户";font-size:13px!important}';document.head.append(style)}`);
  assert.equal(await evaluate('document.querySelectorAll("[data-zp-sidebar] [class*=\\"_logoRow\\"] [data-zp-sidebar-search]").length'), 0);
  const idle = '[data-zp-inline-search] [class*="_searchButton"]';
  const expanded = 'document.querySelector("[data-zp-inline-search]").dataset.expanded==="true"';
  const contracted = 'document.querySelector("[data-zp-inline-search]").dataset.expanded==="false"';
  await until('!!document.querySelector("[data-row-key^=\\"session:\\"] [class*=\\"_title\\"]")', 'real session titles ready');
  const query = process.env.SIDEBAR_SEARCH_QUERY || '作文';
  const rect = selector => call('function(s){const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}', selector);
  const neutral = value => { const m = value.match(/rgba?\((\d+), (\d+), (\d+)/); return !!m && Math.max(...m.slice(1).map(Number))-Math.min(...m.slice(1).map(Number))<=12; };
  const audit = async name => {
    const blue = await call(`function(){return [...document.querySelectorAll('button,a,input,[role=tab],[role=switch]')].filter(el=>el.getBoundingClientRect().width>0).flatMap(el=>{
      const style=getComputedStyle(el);
      return ['color','backgroundColor','borderTopColor','outlineColor'].flatMap(key=>{
        const value=style[key], m=value.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
        return m && +m[3]>+m[1]+20 && +m[3]>+m[2]+15 && !(key==='outlineColor' && style.outlineStyle==='none') ? [{tag:el.tagName,class:el.className,key,value}] : [];
      });
    })}`);
    assert.deepEqual(blue,[],name+' has no blue interaction emphasis');
    checks.push(name+' visible interactive foregrounds, fills, borders and focus outlines contain no blue');
  };
  for (const dark of [false,true]) {
    await call('function(dark){document.body.toggleAttribute("data-ds-dark-theme",dark)}', dark);
    const theme = dark ? 'dark' : 'light';
    const statusColors = async () => evaluate(`(()=>{const s=getComputedStyle(document.body);return Object.fromEntries([...s].filter(k=>k.startsWith('--dsw-alias-state-')&&!k.includes('business')).map(k=>[k,s.getPropertyValue(k)]))})()`);
    const softStatuses=await statusColors();
    await evaluate('document.documentElement.dataset.zpSkin="default"');
    assert.deepEqual(await statusColors(),softStatuses);
    await evaluate('document.documentElement.dataset.zpSkin="soft"');
    checks.push(theme+' semantic status colors match classic');
    await screenshot(theme+'-desktop-idle', { x:0,y:0,width:280,height:900 });
    const iconBefore = await rect(idle+' svg');
    await click(idle);
    await until(expanded+' && document.activeElement.tagName==="INPUT"', theme+' click activates the same row');
    const iconAfter = await rect(idle+' svg');
    assert.equal(iconAfter.x,iconBefore.x); assert.equal(iconAfter.y,iconBefore.y);
    await screenshot(theme+'-desktop-expanded', { x:0,y:0,width:280,height:900 });
    await send('Input.insertText',{text:query});
    await until('document.querySelectorAll("[class*=\\"_searchResultRow\\"]").length>0', theme+' real search results replace the list');
    await screenshot(theme+'-desktop-results', { x:0,y:0,width:280,height:900 });
    await key('Escape'); await until(contracted, theme+' Escape restores recent conversations');
    await click(idle); await until(expanded, 'reopen search'); await send('Input.insertText',{text:query});
    await until('document.querySelectorAll("[class*=\\"_searchResultRow\\"]").length>0','search result ready to open');
    await click('[class*="_searchResultRow"]');
    await until(contracted+' && !!document.querySelector("[data-row-key^=\\"session:\\"][aria-selected=true]")', 'search result opens a conversation');
    const colors = await evaluate(`({newChat:getComputedStyle(document.querySelector('[class*="_newSessionContent"] svg')).color,tabs:[...document.querySelectorAll('[role=tab][aria-selected=true]')].map(el=>({color:getComputedStyle(el).color,line:getComputedStyle(el,'::after').backgroundColor})),focus:getComputedStyle(document.body).getPropertyValue('--dsw-alias-state-business-primary').trim()})`);
    assert.ok(neutral(colors.newChat));
    assert.ok(colors.tabs.length>0, 'conversation tab is mounted');
    for (const tab of colors.tabs) { assert.ok(neutral(tab.color)); if(tab.line!=='rgba(0, 0, 0, 0)') assert.ok(neutral(tab.line)); }
    checks.push(theme+' neutral new-conversation icon and selected conversation tabs: '+JSON.stringify(colors));
    await click(idle); await until(expanded,'search opens for clear'); await send('Input.insertText',{text:query});
    await click('[data-zp-inline-search] [class*="_clearButton"]'); await until(contracted,theme+' clear collapses search');
    await click(idle); await until(expanded,'search opens for deletion'); await send('Input.insertText',{text:'a'});
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await until(contracted,theme+' deleting the last character restores the list');
    await evaluate('document.querySelector("[data-zp-inline-search] button").focus()');
    await until(expanded,'keyboard focus activates search'); await key('Escape'); await until(contracted,'keyboard Escape contracts search');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:3});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:3});
    await until(expanded,theme+' existing search shortcut opens the same input'); await key('Escape');
    await click('[data-sidebar-toggle]');
    await until('document.querySelector("[data-zp-sidebar]").className.includes("_collapsed")','rail opens');
    await screenshot(theme+'-collapsed', {x:0,y:0,width:56,height:900});
    await click('[data-zp-sidebar] [data-zp-sidebar-search]'); await until(expanded+' && document.activeElement.tagName==="INPUT"','rail search expands and focuses input'); await key('Escape');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await until('!!document.querySelector("[data-sidebar-opener]")','mobile opener'); await click('[data-sidebar-opener]');
    await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")==="true"','mobile drawer opens');
    await screenshot(theme+'-mobile-idle',{x:0,y:0,width:280,height:844});
    await click(idle); await until(expanded,'mobile inline search');
    await screenshot(theme+'-mobile-expanded',{x:0,y:0,width:280,height:844});
    await send('Input.insertText',{text:query}); await until('document.querySelectorAll("[class*=\\"_searchResultRow\\"]").length>0','mobile search returns results');
    await screenshot(theme+'-mobile-results',{x:0,y:0,width:280,height:844});
    await key('Escape'); await until(contracted,'mobile Escape closes search first');
    assert.equal(await evaluate('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")'),'true');
    await key('Escape'); await until('document.querySelector("[data-zp-sidebar]")?.getAttribute("aria-modal")!=="true"','second Escape closes drawer');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await until('!!document.querySelector("[data-zp-inline-search]")','desktop restored');
    await audit(theme+' conversation/sidebar');
    const tabBounds = await rect('[role=tablist]');
    await screenshot(theme+'-conversation-tabs',{x:tabBounds.x,y:tabBounds.y,width:tabBounds.w,height:tabBounds.h});
    await click('[data-zp-panel="plugins"]');
    await until('document.querySelector("[data-zp-panel=plugins]").getAttribute("aria-current")==="page"','market opens');
    await until('document.body.innerText.includes("兆华设计")','market cards loaded');
    await audit(theme+' market');
    await click('button[data-signed-out]');
    await until('!![...document.querySelectorAll("[role=menuitem]")].find(x=>x.textContent.trim().startsWith("设置"))','account menu opens');
    await call('function(){[...document.querySelectorAll("[role=menuitem]")].find(x=>x.textContent.trim().startsWith("设置")).click()}');
    await until('!!document.querySelector(".zp-skin-setting")','settings appearance row mounts');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".zp-skin-choices button")].map(x=>x.textContent.trim())'),['兆华柔和（默认）','经典']);
    await audit(theme+' general settings');
    const skinBounds = await rect('.zp-skin-setting');
    await screenshot(theme+'-settings',{x:skinBounds.x,y:skinBounds.y,width:skinBounds.w,height:skinBounds.h});
    await key('Escape');
    await until('!document.querySelector(".zp-skin-setting")','settings closes');
    await click('[data-row-key^="session:"]');
    await until('!!document.querySelector("[role=tab][aria-selected=true]")','conversation restored');
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({preview:'Dedicated persistent-browser tab; branch response substitution over the real authenticated server. Not a deployed image or Electron.',patched:[...patched],checks,errors,notVerified:['Rebuilt partner image','Actual macOS/Windows Electron package','Linux web has no upstream default search shortcut; Ctrl+Alt+K tested with navigator.platform=Win32']},null,2)+'\n');
  console.log(JSON.stringify({patched:[...patched],checks,errors}));
  }
} finally {
  await send('Fetch.disable'); await send('Network.setCacheDisabled',{cacheDisabled:false}); await send('Emulation.clearDeviceMetricsOverride');
  if(preferencePreviewScript) await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:preferencePreviewScript});
  ws.close();
}
