/** Recheck the real native shell with this branch's client and an isolated SQLite API.
 * Uses only an explicitly supplied tab on the configured persistent CDP browser.
 * No production memory request is allowed through. No model round or server deployment.
 * Node 24: CDP_TAB=<own-tab> node tests/settings-browser.mjs <evidence-directory>
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MemoryStore } from '../store.mjs';
import { registerPanel } from '../panel.mjs';

const tab = process.env.CDP_TAB;
assert.ok(tab, 'Create an owned tab with the configured cdp.mjs newtab first');
const directory = resolve(process.argv[2] || '.artifacts/memory-settings');
mkdirSync(directory, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'memory-settings-browser-'));
let store = new MemoryStore(temporary);
const routes = new Map();
const apiPaths = ['list', 'save', 'delete', 'enabled', 'clear'].map(action => '/crysound-memory/api/' + action);
let conflictNextSwitch = false;
registerPanel({ effect: fn => fn(), webStartup: { trustedHosts: [] }, webServer: {
  host: '127.0.0.1', register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
} }, { get maxMemories() { return store.maxMemories; }, get recallChars() { return store.recallChars; },
  snapshot: () => store.snapshot(), save: (...args) => store.save(...args), remove: input => store.remove(input),
  clear: input => store.clear(input), setEnabled: input => store.setEnabled(input),
});
const server = createServer((req, res) => {
  if (!apiPaths.includes(req.url)) { res.writeHead(404); res.end(); return; }
  if (req.url === '/crysound-memory/api/enabled' && conflictNextSwitch) {
    conflictNextSwitch = false;
    store.setEnabled({ revision: store.snapshot().revision, enabled: true });
  }
  void routes.get(req.url)(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const pages = await (await fetch((process.env.CDP_URL || 'http://127.0.0.1:9222') + '/json/list')).json();
const target = pages.find(p => p.id === tab);
assert.ok(target, 'Owned tab not found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await once(ws, 'open');
let nextId = 0;
const pending = new Map();
const failures = [];
const proof = { mode: 'Native online shell, branch client/brand overrides, isolated real SQLite and HTTP API; synthetic facts; no model round or production writes', checks: [], screenshots: [] };
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
  pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', async event => {
  const message = JSON.parse(event.data);
  if (message.id) { const done = pending.get(message.id); pending.delete(message.id); done?.(message); return; }
  if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  try {
    const url = new URL(request.url);
    let body;
    let contentType = 'text/javascript';
    let status = 200;
    if (apiPaths.includes(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'POST') throw new Error('Unexpected memory method');
      const response = await fetch(base + url.pathname, { method: request.method,
        ...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: request.postData } : {}),
      });
      body = await response.text(); status = response.status; contentType = 'application/json';
    } else if (url.pathname === '/brand.js') body = readFileSync(new URL('../../../brand/brand.js', import.meta.url), 'utf8');
    else if (url.pathname === '/brand.css') { body = readFileSync(new URL('../../../brand/brand.css', import.meta.url), 'utf8'); contentType = 'text/css'; }
    else throw new Error('Unexpected intercepted URL');
    await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [
      { name: 'content-type', value: contentType + '; charset=utf-8' }, { name: 'cache-control', value: 'no-store' },
    ], body: Buffer.from(body).toString('base64') });
  } catch (error) {
    // Aborting a superseded focus read invalidates its CDP interception too.
    if (error.message.includes('Invalid InterceptionId')) return;
    failures.push(error.message);
    await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(failure => {
      if (!failure.message.includes('Invalid InterceptionId')) failures.push(failure.message);
    });
  }
});
const evaluate = async expression => {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
};
const until = async (expression, name = expression) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failures.length) throw new Error(failures.join('\n'));
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('UI condition not met: ' + name);
};
const click = async expression => {
  await until(expression, 'click target');
  const target = await send('Runtime.evaluate', { expression });
  const { result } = await send('Runtime.callFunctionOn', {
    objectId: target.result.objectId, returnByValue: true,
    functionDeclaration: 'function(){this.scrollIntoView({block:"nearest"});const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}',
  });
  const { x, y } = result.value;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const button = (label, scope = 'document') => `[...${scope}.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)})`;
const panel = `document.querySelector('.zp-memory')`;
const focus = () => evaluate(`window.dispatchEvent(new Event('focus'))`);
const screenshot = async name => {
  await evaluate(`Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>a.effect?.target?.closest('[data-shortcut-modal=settings], [role=dialog]') && a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))]).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))))`);
  const clip = await evaluate(`(()=>{const box=document.querySelector('[data-shortcut-modal=settings]')?.getBoundingClientRect();return box?{x:box.x,y:box.y,width:box.width,height:box.height,scale:1}:null})()`);
  if (!clip) return; // Never capture unrelated account or conversation content.
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
  writeFileSync(join(directory, name + '.png'), Buffer.from(data, 'base64'));
  proof.screenshots.push(name + '.png');
};
const seed = count => {
  const current = store.snapshot();
  store.clear({ revision: current.revision, confirmed: true });
  const facts = [
    ['preference', '报告格式', '写报告时喜欢用表格，先给结论。', 'conversation'],
    ['identity', '工作背景', '负责声学测试方案和产品支持。', 'manual'],
    ['project', '长期项目', '持续整理测量项目的常见问题。', 'edited'],
  ];
  for (let i = 0; i < count; i++) {
    const [kind, title, content, source] = facts[i % facts.length];
    store.save({ revision: store.snapshot().revision, kind, title: i < 3 ? title : title + ' ' + (i + 1), content }, { source, requireEnabled: false });
  }
};
const refreshCount = async count => { await focus(); await until(`${panel}?.textContent.includes('已记 ${count} 条')`); };
const type = async (label, value) => {
  await evaluate(`(()=>{const input=[...document.querySelectorAll('#zp-memory-editor label')].find(x=>x.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');input.focus();input.select()})()`);
  await send('Input.insertText', { text: value });
};
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// Capture the branch registration while keeping its factory's window global real.
const init = `window.__ModuleLoader__={load(value){window.__memoryBranchRegistration=value}};\n` + client + `\n(()=>{
  const replacement = window.__memoryBranchRegistration;
  delete window.__memoryBranchRegistration;
  let loader;
  Object.defineProperty(window,'__ModuleLoader__',{configurable:true,get(){return loader},set(value){
    loader=value;let load=value.load;
    Object.defineProperty(value,'load',{configurable:true,get(){return function(registration){
      if(registration.id==='@crysound/memory'){registration={...registration,factory:replacement.factory};window.__memoryBranchLoaded=true;}
      if(registration.id==='dshmarket'){
        const before=registration.factory.toString();
        const after=before.replace('[\u0024{NAV_ICON_MARKER}] > svg { display: none; }','[\u0024{NAV_ICON_MARKER}] > :first-child { display: none; }')
          .replace('@media (max-width:560px){[role=dialog]:has([data-dsh-market-root])>nav{display:none}[role=dialog]:has([data-dsh-market-root])>div{flex:100%;width:100%;min-width:0}}','/* CRYSOUND: keep native narrow settings navigation */');
        if(before===after)throw new Error('Market navigation patch did not match');
        registration={...registration,factory:(0,eval)('('+after+')')};
      }
      return load.call(value,registration);
    }},set(fn){load=fn}});
  }});
})()`;
let injection;
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.bringToFront');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [
    { urlPattern: '*/crysound-memory/api/*' }, { urlPattern: '*/brand.js*' }, { urlPattern: '*/brand.css*' },
  ] });
  injection = (await send('Page.addScriptToEvaluateOnNewDocument', { source: init })).identifier;
  await send('Page.navigate', { url: process.env.MEMORY_SETTINGS_URL || 'https://workpartner.corp.crysound.com/' });
  await until('window.__memoryBranchLoaded && document.querySelector("button[data-signed-out]")?.dataset.zpName', 'branch memory factory and account button');
  await click('document.querySelector("button[data-signed-out]")');
  await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.target?.closest('[role=menu]') && a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))))`);
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(x=>['Settings','设置'].includes(x.textContent.trim()))`);
  await until(`document.querySelector('[data-shortcut-modal=settings] nav')`);
  await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.target?.closest('[data-shortcut-modal=settings], [role=dialog]') && a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))))`);
  await click(button('记忆'));
  await until(`${panel}?.textContent.includes('已记 0 条')`);
  assert.equal(await evaluate(`${panel}.querySelector('h2').textContent`), '记忆');
  assert.equal(await evaluate(`${panel}.textContent.includes('使用记忆') && ${panel}.textContent.includes('还没有记忆') && ${panel}.textContent.includes('伙伴记住的你的工作和偏好，只用于你自己的对话，同事看不到。') && !document.querySelector('[data-shortcut-modal=settings]').textContent.includes('个人记忆')`), true);
  proof.checks.push('Settings navigation, heading, switch and empty state use 记忆; privacy explanation is preserved');
  proof.checks.push('Branch client runs in the native settings slot; native Switch and memory pin icon present');
  assert.equal(await evaluate(`${panel}.querySelectorAll('[role=switch]').length`), 1);
  assert.equal(await evaluate(`document.querySelector('[data-shortcut-modal=settings] nav [aria-current] [data-icon]')?.dataset.icon`), 'dsw-icon-pin-outline-medium');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.zp-feishu-settings')).textDecorationLine`), 'none');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.zp-feishu-settings')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-dsh-market-nav-icon]').firstElementChild).display`), 'none');
  proof.checks.push('Feishu uses unselected native row with link icon and no underline; market fallback icon hidden');
  await click(`${panel}.querySelector('[role=switch]')`);
  await until(`${panel}.querySelector('[role=switch]').getAttribute('aria-checked')==='false'`);
  assert.equal(store.snapshot().enabled, false);
  await click(`${panel}.querySelector('[role=switch]')`);
  await until(`${panel}.querySelector('[role=switch]').getAttribute('aria-checked')==='true'`);
  conflictNextSwitch = true;
  await click(`${panel}.querySelector('[role=switch]')`);
  await until(`${panel}.querySelector('[role=alert]')?.textContent.includes('记忆已变化') && !${panel}.querySelector('[role=switch]').disabled`);
  await focus();
  await until(`${panel}.querySelector('[role=switch]').getAttribute('aria-checked')==='true'`);
  await screenshot('switch-conflict');
  assert.equal(await evaluate(`${panel}.querySelector('[role=alert]')?.textContent.includes('记忆已变化')`), true);
  proof.checks.push('A real revision conflict rejects the switch change; successful automatic and focus reads preserve the mutation error');
  await click(button('添加一条', panel));
  await type('标题', '页面新增验证'); await type('内容', '写报告时先给结论');
  await click(`document.querySelector('#zp-memory-editor [aria-label="类型"]')`);
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.trim()==='个人背景')`);
  await click(button('保存'));
  await until(`${panel}?.textContent.includes('页面新增验证') && !document.querySelector('#zp-memory-editor')`);
  assert.equal(store.snapshot().facts[0].kind, 'identity');
  await click(`${panel}.querySelector('[aria-label="编辑：页面新增验证"]')`);
  await type('内容', '更新后喜欢使用表格'); await click(button('保存'));
  await until(`${panel}?.textContent.includes('更新后喜欢使用表格') && !document.querySelector('#zp-memory-editor')`);
  assert.equal(store.snapshot().facts[0].source, 'edited');
  await click(`${panel}.querySelector('[aria-label="删除：页面新增验证"]')`);
  await click(button('取消', `document.querySelector('[role=dialog][aria-label="确认删除"]')`));
  assert.equal(store.snapshot().facts.length, 1);
  await click(`${panel}.querySelector('[aria-label="删除：页面新增验证"]')`);
  await click(button('确认删除', `document.querySelector('[role=dialog][aria-label="确认删除"]')`));
  await until(`${panel}?.textContent.includes('已记 0 条')`);
  assert.equal(store.snapshot().facts.length, 0);
  proof.checks.push('Native switch persists; add/type selection/edit/delete work through real HTTP and SQLite; cancelling delete preserves facts');
  seed(3); await refreshCount(3);
  await click(`${panel}.querySelector('[aria-label="编辑：报告格式"]')`);
  await type('内容', '尚未保存的草稿');
  store.save({ revision: store.snapshot().revision, kind: 'preference', title: '来自另一会话', content: '使用简体中文' });
  await focus();
  assert.equal(await evaluate(`document.querySelector('#zp-memory-editor label:last-of-type input').value`), '尚未保存的草稿');
  await click(button('保存'));
  await until(`document.querySelector('#zp-memory-editor [role=alert]')?.textContent.includes('记忆已变化')`);
  assert.equal(store.snapshot().facts.find(x => x.title === '报告格式').content, '写报告时喜欢用表格，先给结论。');
  await click(button('取消', `document.querySelector('[role=dialog][aria-label="编辑"]')`));
  await until(`${panel}?.textContent.includes('来自另一会话')`);
  proof.checks.push('Focus refresh sees another writer; an open draft is preserved; stale save is refused without overwriting; cancelling refreshes');
  for (const [width, size] of [[1440, 'wide'], [390, 'narrow']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`[...document.querySelectorAll('[data-shortcut-modal=settings] nav button')].find(x=>x.textContent==='记忆').focus()`);
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.body.toggleAttribute('data-ds-dark-theme', ${theme === 'dark'})`);
      for (const scenario of ['empty', 'three', 'near']) {
        seed(scenario === 'empty' ? 0 : scenario === 'three' ? 3 : 3);
        if (scenario === 'near') {
          while (store.snapshot().usage.chars <= store.recallChars * 0.8) {
            const n = store.snapshot().facts.length + 1;
            store.save({ revision: store.snapshot().revision, kind: 'preference', title: '记忆示例 ' + n, content: '项目资料喜欢按用途分类，会议纪要标明待办和日期。' }, { source: 'manual' });
          }
        }
        const count = store.snapshot().facts.length;
        await refreshCount(count);
        if (scenario === 'near') await until(`${panel}.textContent.includes('记忆空间接近上限')`);
        if (scenario === 'empty') {
          assert.equal(await evaluate(`${panel}.textContent.includes('清空全部') || ${panel}.textContent.includes('删除后') || ${panel}.textContent.includes('字')`), false);
        }
        assert.equal(await evaluate(`${panel}.scrollWidth > ${panel}.clientWidth`), false);
        await evaluate(`${panel}.parentElement.parentElement.scrollTop=0`);
        await screenshot(`${theme}-${size}-${scenario}`);
        if (scenario === 'three') {
          await click(`${panel}.querySelector('[aria-label="删除：报告格式"]')`);
          await until(`document.querySelector('[role=dialog][aria-label="确认删除"]')`);
          await screenshot(`${theme}-${size}-delete-confirm`);
          await click(button('取消', `document.querySelector('[role=dialog][aria-label="确认删除"]')`));
          await click(button('清空全部', panel));
          await until(`document.querySelector('[role=dialog][aria-label="清空全部记忆？"]')`);
          await screenshot(`${theme}-${size}-clear-confirm`);
          await click(button('取消', `document.querySelector('[role=dialog][aria-label="清空全部记忆？"]')`));
          assert.equal(store.snapshot().facts.length, 3);
        }
      }
    }
  }
  seed(3); await refreshCount(3);
  await click(button('清空全部', panel));
  await click(button('清空全部', `document.querySelector('[role=dialog][aria-label="清空全部记忆？"]')`));
  await until(`${panel}?.textContent.includes('已记 0 条')`);
  assert.equal(store.snapshot().facts.length, 0);
  proof.checks.push('20 screenshots: two widths × two palettes × empty/three/near/delete confirmation/clear confirmation; empty count is zero with no character metric or destructive controls; no panel horizontal overflow');
  proof.checks.push('Clear confirmation cancellation preserves facts; confirmation clears all through HTTP and SQLite');
  // Native selection is exercised across memory, market, and General without navigating the external Feishu link.
  await click(`document.querySelector('[data-dsh-market-nav-icon]')`);
  await until(`document.querySelector('[data-dsh-market-nav-icon]').getAttribute('aria-current')==='true'`);
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('[data-shortcut-modal=settings] nav')).display`), 'none');
  await screenshot('navigation-market-selected');
  await click(`[...document.querySelectorAll('[data-shortcut-modal=settings] nav button')].find(x=>['General','通用设置','通用'].includes(x.textContent.trim()))`);
  await screenshot('navigation-memory-unselected');
  await click(button('记忆'));
  await until(`${panel}?.textContent.includes('已记 0 条')`);
  proof.checks.push('Opening the section again refreshes; memory/market selected and unselected states follow the native shell');
  assert.deepEqual(failures, []);
  proof.result = 'passed';
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  proof.result = 'failed'; proof.error = error.stack;
  await screenshot('failure').catch(() => {});
  throw error;
} finally {
  writeFileSync(join(directory, 'result.json'), JSON.stringify(proof, null, 2) + '\n');
  if (injection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection }).catch(() => {});
  await send('Fetch.disable').catch(() => {});
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  ws.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
  store.close(); rmSync(temporary, { recursive: true, force: true });
}
