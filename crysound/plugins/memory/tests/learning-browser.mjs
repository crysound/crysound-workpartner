/** Destructive UI checks for a dedicated synthetic fixture, through an existing persistent CDP tab. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const tab = process.env.CDP_TAB;
const expectedOrigin = process.env.MEMORY_TEST_ORIGIN;
if (!tab || !expectedOrigin) throw new Error('Set CDP_TAB and MEMORY_TEST_ORIGIN to the isolated synthetic fixture.');
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json/list`)).json();
const page = pages.find(page => page.id === tab);
assert.equal(new URL(page.url).origin, expectedOrigin);
const output = resolve(process.argv[2] || 'tests/evidence/learning-preparation');
mkdirSync(output, { recursive: true });
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const response = JSON.parse(event.data);
  if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id); }
});
const send = async (method, params = {}) => {
  const id = ++sequence;
  const response = await new Promise(resolve => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  if (response.error) throw new Error(response.error.message);
  return response.result;
};
const evaluate = async expression => {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || 'Browser evaluation failed');
  return value.result.value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error('UI condition not reached: ' + expression);
}
async function click(expression) {
  const point = await evaluate(`(() => { const e = ${expression}; if (!e) throw new Error('Missing control');
    e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
const panel = 'document.querySelector(\'section[aria-label="记忆"]\')';
const button = text => `[...document.querySelectorAll('button')].find(e => e.innerText.trim() === ${JSON.stringify(text)})`;
const ready = `Boolean(${panel} && ${panel}.querySelectorAll('input[type=checkbox]').length===2
  && [...${panel}.querySelectorAll('h3')].some(e=>e.textContent==='学习记录')
  && !${panel}.querySelector('input[type=checkbox]').disabled)`;
const snapshot = () => evaluate("fetch('/crysound-memory/api/learning').then(r=>{if(!r.ok)throw new Error('Fixture read failed');return r.json()})");
const shots = [];
async function shot(name, history = false) {
  const target = history ? "[...p.querySelectorAll('h3')].find(e=>e.textContent==='学习记录')" : 'p';
  await evaluate(`(() => { const p=${panel}; const target=${target};
    let scroller=p.parentElement; while(scroller && scroller.scrollHeight<=scroller.clientHeight) scroller=scroller.parentElement;
    if(scroller) {
      const top=${history} ? scroller.scrollTop+target.getBoundingClientRect().top-scroller.getBoundingClientRect().top : 0;
      scroller.scrollTo({top,behavior:'instant'});
    }
    const visible=${history} ? target : p.querySelectorAll('input[type=checkbox]')[1];
    const r=visible.getBoundingClientRect(); const bounds=scroller?scroller.getBoundingClientRect():{top:0,bottom:innerHeight};
    if(r.top<bounds.top-1 || r.bottom>bounds.bottom+1) throw new Error('Screenshot target is not visible'); })()`);
  await send('Page.enable');
  const capture = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, name + '.png'), Buffer.from(capture.data, 'base64'));
  shots.push(name + '.png');
}
async function theme(name) {
  await click(button('General'));
  await until(`Boolean(${button(name)})`);
  await click(button(name));
  await click(button('记忆'));
  await until(ready);
}

const checks = [];
try {
  await until(ready);
  const initial = await snapshot();
  assert.deepEqual(initial.learning.map(entry => entry.action).sort(), ['add', 'delete', 'merge', 'update']);
  assert.equal(initial.facts.length, 1);
  assert.ok(initial.enabled && initial.autoLearning);
  checks.push('Four operation types, both switches on');
  await theme('Light');
  await shot('light-controls');
  await shot('light-history', true);
  await theme('Dark');
  await shot('dark-controls');
  await shot('dark-history', true);
  await click(`${panel}.querySelectorAll('input[type=checkbox]')[1]`);
  await until("fetch('/crysound-memory/api/list').then(r=>r.json()).then(v=>v.autoLearning===false && v.enabled===true)");
  await until(ready);
  await shot('dark-learning-off');
  await click(button('General'));
  await click(button('记忆'));
  await until(ready);
  assert.equal(await evaluate(`${panel}.querySelectorAll('input[type=checkbox]')[1].checked`), false);
  checks.push('Learning off persists after reopening; recall stays on');
  await click(`${panel}.querySelectorAll('input[type=checkbox]')[1]`);
  await until("fetch('/crysound-memory/api/list').then(r=>r.json()).then(v=>v.autoLearning===true)");
  await until(ready);
  await click("document.querySelector('button[aria-label=\"撤销这次改动：长期项目\"]')");
  await click(button('确认撤销这次改动'));
  await until("fetch('/crysound-memory/api/learning').then(r=>r.json()).then(v=>v.facts.some(f=>f.title==='长期项目') && v.learning.some(e=>e.action==='delete' && e.undone))");
  await until(ready);
  await shot('dark-undo-delete', true);
  checks.push('Undo through UI restores a learned deletion and marks its record undone');
  const current = await snapshot();
  const report = current.facts.find(fact => fact.title === '周报格式');
  const edit = { revision: current.revision, id: report.id, kind: report.kind, title: report.title, content: '本人后来在另一页面修改的周报格式。' };
  const status = await evaluate(`fetch('/crysound-memory/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(edit)})}).then(r=>r.status)`);
  assert.equal(status, 200);
  await click("document.querySelector('button[aria-label=\"撤销这次改动：周报格式\"]')");
  await click(button('确认撤销这次改动'));
  await until(`${panel}.innerText.includes('记忆已变化')`);
  await click(button('刷新'));
  await until(ready);
  await click("document.querySelector('button[aria-label=\"撤销这次改动：周报格式\"]')");
  await click(button('确认撤销这次改动'));
  await until(`${panel}.innerText.includes('后来已被修改')`);
  assert.equal((await snapshot()).facts.find(fact => fact.id === report.id).content, edit.content);
  await shot('dark-undo-conflict');
  checks.push('Stale and subsequent-edit undo refuse to overwrite the newer fact');
  await click(button('取消'));
  await click("document.querySelector('button[aria-label=\"删除：周报格式\"]')");
  await click(button('确认删除'));
  await until("fetch('/crysound-memory/api/learning').then(r=>r.json()).then(v=>!v.facts.some(f=>f.title==='周报格式') && v.learning.length===1)");
  await until(ready);
  checks.push('Manual deletion removes all three related history entries');
  await click(button('清空全部'));
  await click(button('确认清空全部个人记忆'));
  await until("fetch('/crysound-memory/api/learning').then(r=>r.json()).then(v=>v.facts.length===0 && v.learning.length===0)");
  await until(ready);
  await shot('dark-empty');
  await theme('Light');
  await shot('light-empty');
  checks.push('Clear through UI removes facts and learning records');
  writeFileSync(join(output, 'result.json'), JSON.stringify({ scope: 'Dedicated synthetic fixture; real installed dsh UI and branch plugin; no learning or conversation model run', checks, shots }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, screenshots: shots.length }));
} finally { ws.close(); }
