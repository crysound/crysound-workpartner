// Optional read-only check of an existing deployment. Uses the explicitly selected browser session.
import { writeFile } from 'node:fs/promises';
const base=process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
if(!process.env.LIVE_URL || !process.env.CDP_TAB) throw Error('Set LIVE_URL and CDP_TAB to your own logged-in test tab');
const pages=await (await fetch(base+'/json/list')).json();
const page=pages.find(p=>p.id===process.env.CDP_TAB);
if(!page)throw Error('Own tab missing');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(m.error.message)):p?.resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const i=++id;pending.set(i,{resolve,reject});ws.send(JSON.stringify({id:i,method,params}))});
const run=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
await run(`(()=>{const mount=()=>{const root=document.querySelector('[data-slot="sidebar"]')?.firstElementChild;if(!root||root.querySelector('[data-partner-probe]'))return;const b=document.createElement('button');b.dataset.partnerProbe='';b.textContent='伙伴 · 临时技术验证';b.style.cssText='padding:10px;border:0;background:transparent;color:inherit';root.prepend(b)};window.__partnerProbe=new MutationObserver(mount);window.__partnerProbe.observe(document.documentElement,{childList:true,subtree:true});mount()})()`);
const proof={test:'Temporary browser-only insertion, no product deployment',cycles:[],existingSessionOpened:false,newTabExistingSessionAvailable:false};
for(let i=0;i<4;i++){
 await run(`document.querySelector('[data-sidebar-toggle]').click()`);await wait(250);
 proof.cycles.push(await run(`({single:document.querySelectorAll('[data-partner-probe]').length===1,first:document.querySelector('[data-slot="sidebar"]')?.firstElementChild?.firstElementChild?.hasAttribute('data-partner-probe'),togglePresent:!!document.querySelector('[data-sidebar-toggle]')})`));
}
const existing=await run(`(()=>{const row=document.querySelector('[data-row-key^="session:"]');const key=row?.dataset.rowKey;row?.click();return key})()`);await wait(1500);
proof.existingSessionOpened=await run(`document.querySelector('[data-conversation-session]')?.dataset.conversationSession === ${JSON.stringify(existing?.slice('session:'.length))}`);
proof.afterSessionNavigation=await run(`document.querySelectorAll('[data-partner-probe]').length===1`);
await run(`window.__partnerProbe.disconnect();delete window.__partnerProbe;document.querySelector('[data-partner-probe]')?.remove()`);
const tab=await (await fetch(base+'/json/new?'+encodeURIComponent(process.env.LIVE_URL),{method:'PUT'})).json();
try{
 const other=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{other.onopen=r;other.onerror=j});await wait(2500);
 proof.newTabExistingSessionAvailable=await new Promise((resolve,reject)=>{other.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){other.close();m.result?.exceptionDetails?reject(Error('evaluate failed')):resolve(m.result?.result?.value)}};other.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(()=>{const row=document.querySelector('[data-row-key="${existing}"]');row?.click();return !!row})()`,returnByValue:true}}))});
}finally{await fetch(base+'/json/close/'+tab.id)}
if(!proof.existingSessionOpened||!proof.newTabExistingSessionAvailable||proof.cycles.some(x=>!x.single||!x.first||!x.togglePresent)||!proof.afterSessionNavigation)throw Error(JSON.stringify(proof));
await writeFile(process.argv[2] || new URL('./evidence/live-browser.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));

} finally {
 await run(`window.__partnerProbe?.disconnect();delete window.__partnerProbe;document.querySelector('[data-partner-probe]')?.remove()`).catch(()=>{});
 ws.close();
}
