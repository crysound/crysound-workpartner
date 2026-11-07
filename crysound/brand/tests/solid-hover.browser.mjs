// Isolated CSS reproduction using the upstream sticky-summary rules; no business page or records.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const tabId = process.env.CDP_TAB;
if (!tabId) throw new Error('Open a dedicated blank tab through the configured browser entry and set CDP_TAB');
const tabs = await (await fetch((process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222') + '/json/list')).json();
const tab = tabs.find(item => item.id === tabId);
assert.ok(tab, 'Dedicated tab exists');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve,reject) => {ws.onopen=resolve;ws.onerror=reject;});
let sequence=0;
const pending=new Map();
ws.onmessage=event=>{
  const message=JSON.parse(event.data), item=pending.get(message.id);
  if(item){pending.delete(message.id);message.error?item.reject(new Error(JSON.stringify(message.error))):item.resolve(message.result);}
};
const send=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
const evaluate=async expression=>{
  const result=await send('Runtime.evaluate',{expression,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const out=path.resolve(process.env.SOLID_HOVER_EVIDENCE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(),'solid-hover-')));
fs.mkdirSync(out,{recursive:true});
const rows=[];
try{
  await send('Page.enable');await send('Page.bringToFront');await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:600,height:400,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('location.href'),'about:blank','Only overwrite the dedicated blank tab');
  const skin=fs.readFileSync(process.argv[2] ?? new URL('../skin.css',import.meta.url),'utf8');
  const component=fs.readFileSync(new URL('../../../packages/client/ui-chat/src/client/chat/MessageItem.module.css',import.meta.url),'utf8').replaceAll('(hover: hover)','(min-width: 0px)');
  // The persistent browser reports hover:none; activate the desktop-only media rules in this fixture.
  const frame=await send('Page.getFrameTree');
  await send('Page.setDocumentContent',{frameId:frame.frameTree.frame.id,html:'<!doctype html><html data-zp-skin="soft"><body><style>'+component+'\n'+skin+'\n*{transition:none!important;animation:none!important}body{margin:20px}#scroll{overflow:auto;height:180px;width:460px;background:var(--dsw-alias-bg-base)}.compactionBody{height:800px}.compactionButton{font:14px sans-serif}</style><div id="scroll"><div class="compactionRow"><button class="compactionButton">Summary header</button><div class="compactionBody">Synthetic scrolling summary</div></div></div></body></html>'});
  const {root}=await send('DOM.getDocument');
  const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'.compactionButton'});
  await send('CSS.enable');await send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['hover']});
  for(const dark of [false,true]){
    await evaluate(`document.body.toggleAttribute('data-ds-dark-theme',${dark});document.querySelector('#scroll').scrollTop=80`);
    const geometry=await evaluate(`(()=>{const e=document.querySelector('.compactionButton'),s=document.querySelector('#scroll'),r=e.getBoundingClientRect();return {clip:{x:r.x,y:r.y,width:r.width,height:r.height,scale:1},scrollY:s.getBoundingClientRect().y,fill:getComputedStyle(e).backgroundColor,hover:matchMedia('(hover:hover)').matches}})()`);
    assert.ok(Math.abs(geometry.clip.y-geometry.scrollY)<1,'Header is pinned');
    const captures=[];
    for(const background of ['#ff00ff','#00ff00']){
      await evaluate(`document.querySelector('.compactionBody').style.backgroundColor='${background}'`);
      captures.push((await send('Page.captureScreenshot',{format:'png',clip:geometry.clip})).data);
    }
    const opaque=captures[0]===captures[1];
    assert.equal(opaque,!process.env.EXPECT_HOVER_LEAK,'Scrolling content must not change pixels in the hovered pinned header: '+JSON.stringify(geometry));
    const theme=dark?'dark':'light';
    fs.writeFileSync(path.join(out,theme+'.png'),Buffer.from(captures[0],'base64'));
    rows.push({theme,opaque,...geometry});
  }
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({fixture:'Isolated CSS reproduction with the upstream MessageItem.module.css, synthetic scrolled content, explicitly active desktop media rules, forced hover, and two different backgrounds under the pinned header. Not a deployed app or Electron.',rows},null,2)+'\n');
  console.log(JSON.stringify(rows));
}finally{
  await send('Emulation.clearDeviceMetricsOverride');
  const closed=new Promise(resolve=>ws.addEventListener('close',resolve,{once:true}));
  ws.close();await closed;
}
