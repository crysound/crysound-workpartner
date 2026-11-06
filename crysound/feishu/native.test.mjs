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
  plugin.apply({effect:work=>work(),slots:{
    inject:(_key,work)=>work(), register:(options,component)=>entries.push({options,component}),
    entries:()=>[{store:{create:()=>({actions:{openSection:id=>actions.push(id)}})}}], subscribe:()=>()=>{},
  }});
  assert.deepEqual(entries.map(entry=>entry.options.name),['settings.section','settings.section.icon']);
  assert.equal(entries[0].options.id,entries[1].options.id);
  assert.deepEqual(actions,['crysound-feishu']); assert.equal(location.search,'');
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
