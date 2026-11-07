import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { prepareSkillProfile } from './setup.mjs';
import { installDesktopSettings } from './desktop.mjs';

test('原生模块从个人 profile 可解析，重复准备不改个人设置、依赖和模块内容', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-native-settings-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const patch = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(patch, '- id: mine\n  config:\n    enabled: true\n');
  fs.writeFileSync(path.join(dir,'package.json'), JSON.stringify({dependencies:{mine:'1.2.3'}}));
  prepareSkillProfile(patch);
  const first = fs.readFileSync(patch,'utf8');
  const manifest = fs.readFileSync(path.join(dir,'package.json'),'utf8');
  prepareSkillProfile(patch);
  assert.equal(fs.readFileSync(patch,'utf8'),first);
  assert.equal(fs.readFileSync(path.join(dir,'package.json'),'utf8'),manifest);
  assert.equal(JSON.parse(manifest).dependencies.mine,'1.2.3');
  assert.equal((first.match(/id: company-feishu-settings/g)||[]).length,1);
  const require = createRequire(path.join(dir,'package.json'));
  const pkg = require('@crysound/feishu-settings/package.json');
  assert.ok(fs.existsSync(require.resolve('@crysound/feishu-settings/client')));
  assert.ok(pkg.dsh.client.external.includes('react'));
});

test('设置入口注册原生页和图标，授权回跳打开同一原生设置页并清理标记', () => {
  let definition;
  const actions = [];
  const entries = [];
  const storage = new Map();
  const location = new URL('https://partner.example.test/?zp-settings=feishu');
  const context = {
    window: {__ModuleLoader__:{load: value => { definition=value; }}}, location, navigator:{userAgent:'test'},
    URL, URLSearchParams, sessionStorage:{getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},
    history:{replaceState(_a,_b,url){location.href=url.href;}},
    document:{createElement:()=>({remove(){}}),head:{appendChild(){}}},
  };
  vm.runInNewContext(fs.readFileSync(new URL('./native/client.js',import.meta.url),'utf8'),context);
  const plugin = definition.factory(name => name==='react' ? {createElement(){}} : {});
  plugin.apply({effect:work=>work(),locale:{register:()=>()=>{},bind:()=>key=>key,getSnapshot:()=>({active:'en'})},slots:{
    inject:(_key,work)=>work(), register:(options,component)=>entries.push({options,component}),
    entries:()=>[{store:{create:()=>({actions:{openSection:id=>actions.push(id)}})}}], subscribe:()=>()=>{},
  }});
  assert.deepEqual(entries.filter(entry=>['crysound-feishu','crysound-feishu-reminder'].includes(entry.options.id)).map(entry=>entry.options.name),['settings.section','conversation.header.leading','settings.section.icon']);
  assert.equal(entries[0].options.id,entries[2].options.id);
  assert.deepEqual(actions,['crysound-feishu']); assert.equal(location.search,'');
  // Same-page authorization from the home reminder returns home, without opening settings.
  location.search = '?zp-settings=feishu';
  storage.set('zp-feishu-home-return', '1'); storage.set('zp-feishu-return', '1');
  plugin.apply({effect:work=>work(),locale:{register:()=>()=>{},bind:()=>key=>key,getSnapshot:()=>({active:'en'})},slots:{
    inject:()=>{}, entries:()=>[], subscribe:()=>()=>{},
  }});
  assert.deepEqual(actions,['crysound-feishu']); assert.equal(location.search,'');
  assert.equal(storage.size,0);
});

function panelFixture(t, { saved, respond } = {}) {
  let definition, active = 'zh', tick, clock = 1000, panel, slot, cursor = 0;
  const state = [], refs = [], effects = [], registrations = [], dictionaries = new Map(), events = new Map();
  const storage = new Map(saved ? [['zp-project-authorization', JSON.stringify(saved)]] : []);
  const requests = [], disposers = [];
  const translate = (key, values = {}) => (dictionaries.get(active)?.[key] ?? dictionaries.get('en')?.[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name) => name in values ? String(values[name]) : match);
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++; if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return refs[index] ??= {current:initial}; },
    useEffect(work) { if (!effects.length) effects.push(work); },
  };
  const listeners = {
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
  };
  const context = {
    window: {__ModuleLoader__:{load:value=>{definition=value;}},...listeners},
    location:new URL('https://partner.example.test/'),navigator:{userAgent:'test'},URL,URLSearchParams,
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{...listeners,visibilityState:'visible',createElement:()=>({remove(){}}),head:{appendChild(){}}},
    history:{replaceState(){}},AbortController,
    Date:class extends Date { static now(){return clock;} },
    setTimeout:fn=>{tick=fn;return fn;},clearTimeout:()=>{tick=null;},
    fetch:async url=>{
      const route=url.replace('/_zp/feishu/','');requests.push(route);
      const value = respond ? await respond(route) : {connected:true,expiresInMinutes:4350,name:'Test',authorizedAt:'2026-11-07T00:00:00Z'};
      return {ok:true,json:async()=>value};
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('./native/client.js',import.meta.url),'utf8'),context);
  definition.factory(name=>name==='react'?react:{}).apply({
    effect:work=>{const stop=work();if(typeof stop==='function')disposers.push(stop);},
    locale:{register:(_ns,language,dict)=>{dictionaries.set(language,dict);return()=>dictionaries.delete(language);},bind:()=>translate,getSnapshot:()=>({active})},
    slots:{inject:(_name,work)=>work(),register:(options,component)=>{registrations.push(options);if(options.name==='settings.section' && options.id==='crysound-feishu'){panel=component;slot=options;}},entries:()=>[],subscribe:()=>()=>{}},
  });
  function render(){cursor=0;return panel({t:translate,...slot.inject?.()});}
  render();
  for(const work of effects){const stop=work();if(typeof stop==='function')disposers.push(stop);}
  t.after(()=>{for(const stop of disposers.reverse())stop();});
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const text=node=>typeof node==='string'?node:node?.children?.map(text).join(' ')??'';
  return {requests,registrations,dictionaries,events,storage,render,text,settle,
    locale:value=>{active=value;},
    advance:async milliseconds=>{clock+=milliseconds;assert.ok(tick,'mounted panel has a scheduled tick');await tick();await settle();},
  };
}

test('设置文案、导航和日期跟随语言切换，中文和英文字典键一致', async t => {
  const f=panelFixture(t);await f.settle();
  assert.match(f.text(f.render()),/飞书授权/);
  f.locale('en');const english=f.text(f.render());
  assert.match(english,/Feishu authorization/);
  assert.match(english,/Connected · Test · Authorized/);
  assert.ok(english.includes(new Date('2026-11-07T00:00:00Z').toLocaleString('en')));
  assert.ok(!/[\u4e00-\u9fff]/u.test(english));
  assert.equal(f.registrations[0].label(),'Feishu authorization');
  assert.equal(f.registrations[0].locale,'crysound.feishu');
  assert.deepEqual(Object.keys(f.dictionaries.get('zh')).sort(),Object.keys(f.dictionaries.get('en')).sort());
  f.locale('zh');assert.match(f.text(f.render()),/飞书授权/);
});

test('设备授权临时轮询失败后保留尝试和错误，恢复焦点后重试至成功', async t => {
  let polls=0, connected=false;
  const f=panelFixture(t,{saved:{next:1000,interval:5000,until:30000},respond:route=>{
    if(route==='project/poll'){polls++;if(polls===1)throw new Error('offline');connected=true;return {state:'connected'};}
    return {connected};
  }});
  await f.settle();await f.advance(0);assert.equal(polls,1);
  f.events.get('focus')();await f.settle();
  assert.match(f.text(f.render()),/正在重试/);
  await f.advance(4999);assert.equal(polls,1);
  await f.advance(1);assert.equal(polls,2);
  assert.match(f.text(f.render()),/已连接/);
  assert.ok(!f.storage.has('zp-project-authorization'));
  assert.doesNotMatch(f.text(f.render()),/正在重试/);
});

test('设备授权持续轮询失败只重试到尝试到期', async t => {
  let polls=0;
  const f=panelFixture(t,{saved:{next:1000,interval:5000,until:7000},respond:route=>{
    if(route==='project/poll'){polls++;throw new Error('offline');}
    return {connected:false};
  }});
  await f.settle();await f.advance(0);await f.advance(5000);assert.equal(polls,2);
  await f.advance(1000);assert.match(f.text(f.render()),/授权已过期/);
  await f.advance(5000);assert.equal(polls,2);
  assert.ok(!f.storage.has('zp-project-authorization'));
});

test('桌面原生设置拒绝跨源断开，连接使用隔离子窗口且不向页面暴露身份文件', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'zp-native-desktop-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const identityFile=path.join(dir,'identity.json'); fs.writeFileSync(identityFile,JSON.stringify({token:'never-in-renderer'}));
  const windows=[];
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};windows.push(this);}
    async loadURL(url){this.url=url;}
    destroy(){this.emit('closed');}
    close(){this.destroy();}
  }
  const handle=installDesktopSettings({app:new EventEmitter(),BrowserWindow:Window,publicOrigin:'https://partner.example.test',configFile:'unused',identityFile,execPath:process.execPath});
  const bad=await handle(new Request('dsh-app://app/_zp/feishu/disconnect',{method:'POST',headers:{origin:'https://evil.test'}}));
  assert.equal(bad.status,403);
  const result=await handle(new Request('dsh-app://app/_zp/feishu/authorize',{method:'POST',headers:{origin:'dsh-app://app'}}));
  assert.equal(result.status,200);assert.ok(!(await result.text()).includes('never-in-renderer'));
  assert.equal(windows.length,1);assert.equal(windows[0].options.webPreferences.nodeIntegration,false);
  assert.match(windows[0].url,/return=settings&display=popup/);
});


test('明确打开设置页优先于首次引导，关闭设置后引导恢复；运行时修补可重复', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-settings-return-patch-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const file = path.join(root, '@deepseek-ai/dsh-client-ui-settings-general/lib/client.js');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const before = 'const onboardingStep = requestedOnboarding !== void 0 ? "explicit-intro" : onboardingActive ? "first-run" : void 0; globalThis.result = onboardingStep;';
  fs.writeFileSync(file, before);
  const script = fileURLToPath(new URL('../config/plugin-patches.mjs',import.meta.url));
  execFileSync(process.execPath,[script,root]); const after = fs.readFileSync(file,'utf8');
  execFileSync(process.execPath,[script,root]); assert.equal(fs.readFileSync(file,'utf8'),after);
  function result(code, open, activeId) {
    const context = {open,activeId,onboardingActive:true,requestedOnboarding:undefined};
    vm.runInNewContext(code,context); return context.result;
  }
  assert.equal(result(before,true,'crysound-feishu'),'first-run');
  assert.equal(result(after,true,'crysound-feishu'),undefined);
  assert.equal(result(after,false,undefined),'first-run');
});
