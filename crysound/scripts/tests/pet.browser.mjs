// Run with Node 24 and the configured persistent browser (no dependencies/build).
// Creates and closes its own blank tab; never sends messages or changes server data.
// CDP_URL=http://127.0.0.1:9222 node crysound/scripts/tests/pet.browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.CDP_URL || 'http://127.0.0.1:9222';
const tab = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const requests = new Map();
const errors = [];
const assets = [];
let serveAsset;
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Fetch.requestPaused') { void serveAsset(message.params); return; }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  const request = requests.get(message.id);
  if (!request) return;
  requests.delete(message.id);
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; requests.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const css = await readFile(new URL('../../brand/brand.css', import.meta.url), 'utf8');
const code = await readFile(new URL('../../brand/pet.js', import.meta.url), 'utf8');
const brand = await readFile(new URL('../../brand/brand.js', import.meta.url), 'utf8');
serveAsset = async ({requestId, request}) => {
  assets.push(request.url);
  const source = new URL(request.url).pathname === '/brand.js' ? brand : code;
  await send('Fetch.fulfillRequest', { requestId, responseCode: 200,
    responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
    body: Buffer.from(source).toString('base64') });
};
let checks = 0;
async function check(expression, expected, label) {
  assert.deepEqual(await evaluate(expression), expected, label); checks++; console.log(`PASS ${label}`);
}
const settle = () => evaluate('new Promise(resolve => setTimeout(resolve, 30))');
const states = '[...document.querySelectorAll(".zp-pet")].map(e=>e.dataset.state)';
const setChat = html => evaluate(`document.querySelector('#chat').innerHTML=${JSON.stringify(html)}`).then(settle);
const node = (turn, kind, html = '') => `<div data-chat-turn="${turn}" data-chat-flow-kind="${kind}">${html}</div>`;
const running = node(1, 'assistant-step', '<div data-streaming="true">Reply</div>');
const finished = node(1, 'turn-process', '<button data-turn-process="1">Worked</button>');
try {
  await send('Page.enable'); await send('Runtime.enable');
  const { frameTree } = await send('Page.getFrameTree');
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>${css}</style></head><body>
    <div data-slot="sidebar.brand.mark"><svg></svg></div>
    <div data-row-key="session:a" aria-selected="true"><i id="row-status"></i></div>
    <div data-row-key="session:b" aria-selected="false"><i data-state="ongoing"></i></div>
    <div data-slot="main.conversation"><div data-conversation-session="a">
      <div id="chat"></div><div data-slot="conversation.composer">
        <div data-slot="conversation.hero.brand.mark"><svg></svg></div>
        <div contenteditable="true" data-composer-input></div><button id="send">Send</button>
      </div>
    </div></div></body></html>` });
  await check('getComputedStyle(document.querySelector("[data-slot*=mark]"),"::after").display !== "none"', true, 'static fallback before component');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://pet.invalid/*' }] });
  await evaluate(`new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Pet did not load')),3000);
    const observer=new MutationObserver(()=>{if(document.querySelectorAll('.zp-pet').length===2){clearTimeout(timeout);observer.disconnect();resolve()}});
    observer.observe(document.body,{childList:true,subtree:true});
    const s=document.createElement('script');s.src='https://pet.invalid/brand.js?v=smoke';s.onerror=reject;document.head.appendChild(s);
  })`); await settle();
  assert.deepEqual(assets, ['https://pet.invalid/brand.js?v=smoke', 'https://pet.invalid/pet.js?v=smoke']);
  checks++; console.log('PASS brand loader carries cache version to pet asset');
  await check(states, ['idle', 'idle'], 'background running session does not affect current session');
  await check('[...document.querySelectorAll(".zp-pet")].map(e=>getComputedStyle(e).display)', ['inline-block', 'inline-block'], 'brand CSS reveals both mounted pets');
  await check('[...document.querySelectorAll("[data-zp-pet-ready]")].map(e=>getComputedStyle(e,"::after").display)', ['none', 'none'], 'fallback hidden after successful mount');
  await check('[...document.querySelectorAll(".zp-pet")].map(e=>Math.round(e.getBoundingClientRect().width))', [22, 40], 'existing logo dimensions preserved');
  await check('getComputedStyle(document.querySelector(".zp-pet .body")).animationName', 'zp-breathe', 'idle breathing');
  await evaluate('document.querySelector("[data-composer-input]").focus()'); await settle();
  await check(states, ['idle', 'idle'], 'focus alone does not mean typing');
  await evaluate('document.querySelector("[data-composer-input]").dispatchEvent(new InputEvent("input",{bubbles:true}))'); await settle();
  await check(states, ['listening', 'listening'], 'typing synchronizes both logos');
  await evaluate('document.querySelector("[data-composer-input]").blur();document.querySelector("#send").setAttribute("data-sending", "")'); await settle();
  await check(states, ['thinking', 'thinking'], 'send before first reply');
  await evaluate(`document.querySelector('#send').removeAttribute('data-sending');document.querySelector('#send').innerHTML='<svg><rect x="3" y="3" width="10" height="10"></rect></svg>'`); await settle();
  await check(states, ['thinking', 'thinking'], 'stop control keeps request active after submission');
  await setChat(running);
  await check(states, ['working', 'working'], 'streaming reply');
  await setChat(node(1, 'tool', '<div data-tool="shell" data-state="running"></div>'));
  await check(states, ['working', 'working'], 'tool execution');
  await check('getComputedStyle(document.querySelector(".zp-pet[data-fx=off] .shine")).display', 'none', 'sidebar limits animation to body and blink');
  await setChat(running + '<div data-approval-key="a" aria-busy="false"></div>');
  await check(states, ['waiting', 'waiting'], 'approval overrides working');
  await check('getComputedStyle(document.querySelector(".zp-pet[data-fx=off] .fx")).display', 'none', 'sidebar has no bubbles or effects');
  await evaluate('document.querySelector("[data-approval-key]").setAttribute("aria-busy","true")'); await settle();
  await check(states, ['working', 'working'], 'answered approval resumes work');
  await setChat(node(1, 'assistant-step', '<div>Reply</div>'));
  await evaluate('document.querySelector("#send").innerHTML="Send"');
  await evaluate('document.querySelector("#send").removeAttribute("data-sending")'); await settle();
  await check(states, ['working', 'working'], 'render gap before terminal marker does not lose completion');
  await setChat(finished);
  await check(states, ['done', 'done'], 'finished round celebrates');
  await check('[...document.querySelectorAll(".zp-pet")].map(e=>e.querySelectorAll(".spark").length)', [0, 9], 'stars only on hero');
  await evaluate('new Promise(resolve=>setTimeout(resolve,2100))');
  await check(states, ['idle', 'idle'], 'done returns to idle after two seconds');
  await evaluate('document.querySelector("#send").setAttribute("data-sending", "")'); await settle();
  await evaluate('document.querySelector("#send").removeAttribute("data-sending")'); await settle();
  await check(states, ['thinking', 'thinking'], 'old terminal marker cannot complete a new submission');
  await evaluate(`document.body.insertAdjacentHTML('beforeend', '<div role="alert"><svg data-icon="dsw-icon-warning-outline-regular"></svg>Rejected</div>')`); await settle();
  await check(states, ['error', 'error'], 'submission rejected before a new turn exists');
  await evaluate('document.querySelector("[role=alert]").remove();document.querySelector("#send").setAttribute("data-sending", "")'); await settle();
  await setChat(node(2, 'turn-error'));
  await evaluate('document.querySelector("#send").removeAttribute("data-sending")'); await settle();
  await check(states, ['error', 'error'], 'failed request');
  await check('[...document.querySelectorAll(".zp-pet")].map(e=>e.dataset.face)', ['x', 'x'], 'error eyes');
  await evaluate('document.querySelector("#send").setAttribute("data-sending", "")'); await settle();
  await setChat(node(2, 'turn-error') + node(3, 'user-message'));
  await check(states, ['thinking', 'thinking'], 'retry ignores previous turn error');
  await evaluate('document.querySelector("[data-conversation-session]").dataset.conversationSession="b";document.querySelector("#send").removeAttribute("data-sending")');
  await setChat(node(3, 'turn-process', '<button data-turn-process="3"></button>'));
  await check(states, ['idle', 'idle'], 'switching to completed session does not celebrate');
  await evaluate(`document.querySelector('[data-slot="main.conversation"]').insertAdjacentHTML('beforeend', '<button data-phase="disconnected"></button>')`); await settle();
  await check(states, ['error', 'error'], 'connection loss');
  await evaluate('document.querySelector("button[data-phase]").remove()'); await settle();
  await check(states, ['idle', 'idle'], 'connection recovery');
  await evaluate('document.dispatchEvent(new PointerEvent("pointermove",{clientX:10000,clientY:-10000}))');
  await check('Number(document.querySelector("button.zp-pet").style.getPropertyValue("--ly"))', -1.2, 'eye movement stays inside dome');
  await evaluate('document.querySelector("span.zp-pet").click()');
  await check('document.querySelector("span.zp-pet").classList.contains("squish")', false, 'sidebar does not respond to poke');
  await evaluate('document.querySelector("button.zp-pet").click()');
  await check('document.querySelector("button.zp-pet").classList.contains("squish")', true, 'hero responds to poke');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await settle();
  await setChat(node(4, 'turn-error'));
  await check(states, ['idle', 'idle'], 'reduced motion keeps logo neutral despite error');
  await check('[...document.querySelectorAll(".zp-pet .body")].map(e=>getComputedStyle(e).animationName)', ['none', 'none'], 'reduced motion stops body animations');
  await check('[...document.querySelectorAll(".zp-pet .fx")].map(e=>getComputedStyle(e).display)', ['none', 'none'], 'reduced motion hides all effects');
  await check('[...document.querySelectorAll(".zp-pet")].map(e=>e.dataset.face)', ['open', 'open'], 'reduced motion leaves open eyes for blinking');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await settle();
  await check(states, ['error', 'error'], 'motion preference changes apply without reload');
  await setChat(finished); await evaluate('document.dispatchEvent(new PointerEvent("pointermove"))');
  // Advance the browser clock, exercising the actual two-minute timer without a long wait.
  const advanced = new Promise(resolve => {
    const previous = ws.onmessage;
    ws.onmessage = event => { previous(event); if (JSON.parse(event.data).method === 'Emulation.virtualTimeBudgetExpired') resolve(); };
  });
  await send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 120100 });
  await advanced;
  await check(states, ['sleep', 'sleep'], 'sleeps after two minutes without activity');
  await evaluate('document.dispatchEvent(new PointerEvent("pointermove"))');
  await check(states, ['idle', 'idle'], 'mouse movement wakes both logos');
  await evaluate('document.querySelector("button.zp-pet").remove()');
  await evaluate('Promise.resolve()');
  await check('document.querySelectorAll("button.zp-pet").length', 1, 'removed hero remounts without duplicate pets');
  assert.deepEqual(errors, []); checks++; console.log(`PASS ${checks} browser checks, no page exceptions`);
} finally {
  ws.close(); await fetch(`${base}/json/close/${tab.id}`);
}
