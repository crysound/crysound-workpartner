// Run against a blank native dsh page in a dedicated, already authenticated CDP tab.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { patchCompanyMarketRuntime } from '../../scripts/patch-market-ui.mjs';
import { patchThirdPartyCards } from '../../scripts/patch-market-cards.mjs';
const modules = process.env.MARKET_RUNTIME_MODULES;
if (!modules) throw new Error('MARKET_RUNTIME_MODULES must name a writable copy of the pinned released browser modules');
patchCompanyMarketRuntime(modules);
const replacement = new Map(['ui-plugin-manager','ui-plugin-market'].map(name => ['@deepseek-ai/dsh-client-'+name,fs.readFileSync(path.join(modules,'@deepseek-ai/dsh-client-'+name,'lib/client.js'),'utf8')]));
if (process.env.THIRD_PARTY_CLIENT) replacement.set('dshmarket',patchThirdPartyCards(fs.readFileSync(process.env.THIRD_PARTY_CLIENT,'utf8')));

const english = process.argv.includes('--english');
const words=english ? {market:'Market',company:'CRYSOUND market',installed:'Installed',third:'Third-party'} : {market:'市场',company:'兆华市场',installed:'已安装',third:'第三方'};
const tab = process.env.CDP_TAB;
if (!tab) throw new Error("CDP_TAB must identify a dedicated test tab");

const output = path.resolve(process.argv[2] ?? ".playwright-mcp/market-cards");
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
    // Keep patch version comments with their module when the server combines responses.
    const starts = [...body.matchAll(/(?:\/\* CRYSOUND [^\n]*\*\/\n)*window\.__ModuleLoader__\.load\(\{/gu)].map(match => match.index);
    if (starts[0] !== 0) starts.unshift(0);
    body = starts.map((start, index) => body.slice(start, starts[index + 1])).map(part => {
      const moduleId = part.match(/window\.__ModuleLoader__\.load\(\{\s*id: "([^"]+)"/u)?.[1];
      if (english && moduleId === '@deepseek-ai/dsh-client-locale') {
        const needle='new LocaleRuntime(ctx, ctx.configForms.get(LOCALE_SETTINGS_NAMESPACE), bootstrap)';
        if(part.split(needle).length!==2) throw new Error('Locale bootstrap anchor changed');
        applied.add('locale');changed=true;
        return part.replace(needle,'new LocaleRuntime(ctx, undefined, {languages:["en"],preference:"en"})');
      }
      if (replacement.has(moduleId)) { applied.add(moduleId); changed=true; return replacement.get(moduleId) + "\n"; }
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
    errors.push({message:clean(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text),url:message.params.exceptionDetails.url,line:message.params.exceptionDetails.lineNumber,stack:message.params.exceptionDetails.stackTrace});
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error" && message.params.executionContextId === executionContext) {
    errors.push(message.params.args.map(arg => clean(arg.value ?? arg.description)).join(" "));
  } else if (message.method === "Fetch.requestPaused") {
    const task = intercept(message.params);
    interceptions.add(task);
    void task.then(() => interceptions.delete(task), error => { errors.push(clean(JSON.stringify(error))); interceptions.delete(task); });
  }
});
async function until(expression, ready = () => true) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (ready() && await evaluate(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native page did not reach expected state");
}
async function screenshot(name) {
  const clip = await evaluate(`(() => { const p=document.querySelector('[data-plugin-panel]'); const r=p.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:Math.min(innerHeight-r.y,r.height),scale:1}; })()`);
  const shot=await send('Page.captureScreenshot',{format:'png',clip});
  fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));
}
const clickText = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
const results={method:'Real native page; tab-local response substitution of pinned released modules; real server data; no product writes',screenshots:[],checks:[]};
async function layout(width,name,selector='[data-market-entry]') {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  await new Promise(resolve=>setTimeout(resolve,350));
  const state=await evaluate(`(() => {
    const cards=[...document.querySelectorAll(${JSON.stringify(selector)})];
    const rects=cards.map(c=>{const r=c.getBoundingClientRect();const d=c.querySelector('.zp-card-description');return {x:r.x,y:r.y,w:r.width,icon:c.querySelector('.zp-card-icon')?.getBoundingClientRect().width,title:c.querySelector('.zp-card-title')?.innerText,meta:c.querySelector('.zp-card-meta')?.innerText,description:d?.textContent,clamp:d?getComputedStyle(d).webkitLineClamp:null,action:c.querySelector(".zp-card-action")?.textContent,buttons:[...c.querySelectorAll('.zp-card-action button')].map(b=>b.textContent),chevron:!!c.querySelector('.zp-card-chevron')};});
    const panel=document.querySelector('[data-plugin-panel]');return {width:innerWidth,rects,overflow:panel.scrollWidth>panel.clientWidth+1};
  })()`);
  assert.ok(state.rects.length>0);assert.equal(state.overflow,false);
  for(const card of state.rects) { assert.ok(card.icon>=50);assert.ok(card.title);assert.ok(card.meta);assert.equal(card.clamp,'2');assert.ok(card.action);assert.ok(card.chevron); }
  if(width>=1400) {assert.equal(Math.round(state.rects[0].y),Math.round(state.rects[1].y));assert.ok(state.rects[1].x>state.rects[0].x);}
  if(width<900) assert.ok(state.rects.every(r=>Math.abs(r.x-state.rects[0].x)<2));
  await screenshot(name);results.screenshots.push(name+'.png');results.checks.push({name,...state});
}
try {
  await send('Runtime.enable');await send('Page.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Fetch.enable',{patterns:[{urlPattern:'*/plugins/*/client.js*',requestStage:'Response'}]});
  await send('Page.reload',{ignoreCache:true});
  await until('document.querySelector("[data-composer-input][contenteditable=true]") || document.querySelector("[data-plugin-panel]")',()=>[...replacement.keys()].every(name=>applied.has(name)) && (!english || applied.has("locale")));
  await clickText(words.market);await until('document.querySelector("[role=tab]")');await clickText(words.company);
  await until('document.querySelector("[data-market-entry].zp-market-card")');
  await layout(1600,'wide');await layout(820,'narrow');await layout(520,'phone');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  const initial=await evaluate('document.body.hasAttribute("data-ds-dark-theme")');
  await evaluate('document.body.setAttribute("data-ds-dark-theme", "")');await layout(1600,'dark');
  await evaluate(`document.body.toggleAttribute('data-ds-dark-theme',${initial})`);
  await evaluate('document.querySelector("[data-market-entry] .zp-card-chevron").click()');
  await until('document.querySelector("[data-market-detail]")');
  const detail=await evaluate('document.querySelector("[data-market-detail]").innerText');
  assert.match(detail,/0\.\d|1\.\d/);await screenshot('detail');results.checks.push({name:'chevron opens native details',hasVersion:true,hasCategory:/数据|Data/.test(detail)});
  await evaluate('document.querySelector("[data-market-detail] > button").click()');
  await until('document.querySelector("[data-market-entry]")');
  await evaluate('document.querySelector("[data-market-entry] .zp-card-description").click()');await until('document.querySelector("[data-market-detail]")');
  await evaluate('document.querySelector("[data-market-detail] > button").click()');await until('document.querySelector("[data-market-entry]")');
  // Drive the native controlled search input through browser key events.
  await evaluate('document.querySelector("[data-discover-toolbar] input").focus()');
  await send('Input.insertText',{text:'兆华数据'});
  await until('document.querySelectorAll("[data-market-entry]").length===1 && document.querySelector("[data-market-entry]")?.getAttribute("data-market-entry")==="@crysound/data"');
  await evaluate('document.querySelector("[data-discover-toolbar] input").select()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await until('document.querySelectorAll("[data-market-entry]").length>1');
  results.checks.push({name:'native controlled search and clearing',passed:true});
  const count=await evaluate('document.querySelectorAll("[data-market-entry]").length');
  await evaluate('document.querySelectorAll(".zp-market-segments button")[1].click()');assert.ok(await evaluate('document.querySelectorAll("[data-market-entry]").length')<=count);
  await evaluate('document.querySelectorAll(".zp-market-segments button")[0].click()');
  await clickText(words.installed);await until('document.querySelector("[data-company-card]")');
  await layout(1600,'installed','[data-company-card]');await layout(820,'installed-narrow','[data-company-card]');
  await clickText(words.third);await until('document.querySelector("[data-third-party-entry]")');
  await layout(1600,'third-party','[data-third-party-entry]');await layout(820,'third-party-narrow','[data-third-party-entry]');
  await evaluate('document.querySelector("[data-third-party-entry] .zp-card-chevron").click()');await until('document.querySelector("dialog[open]")');
  await screenshot('third-party-detail');await evaluate('document.querySelector("dialog[open] > button").click()');await until('!document.querySelector("dialog[open]")');
  results.checks.push({name:'third-party details preserve native controls',passed:true});
  assert.ok(applied.has('@deepseek-ai/dsh-client-ui-plugin-market'));assert.ok(applied.has('@deepseek-ai/dsh-client-ui-plugin-manager'));assert.ok(applied.has('dshmarket'));
  results.errors=errors;fs.writeFileSync(path.join(output,"browser.json"),JSON.stringify(results,null,2)+"\n");assert.deepEqual(errors,[]);
  results.locale=english?'en':'zh';results.localeMethod=english?'tab-local native locale bootstrap without Host preference persistence':'existing account locale';
  results.pending=['packaged Electron build','deployment','real installation completion and plugin Use workflow'];
  fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify(results,null,2)+'\n');console.log('Market cards browser checks passed');
} catch(error) {
  fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({message:error.message,applied:[...applied],errors},null,2)+'\n');
  throw error;
} finally {
  await Promise.allSettled([...interceptions]);await send('Fetch.disable');await send('Network.setCacheDisabled',{cacheDisabled:false});await send('Emulation.clearDeviceMetricsOverride');
  ws.close();await new Promise(resolve=>ws.addEventListener('close',resolve,{once:true}));
}
