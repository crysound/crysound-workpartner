// Animated logo from the approved design; no demo UI or network access.
(() => {
const SQ='M15 0H49A15 15 0 0 1 64 15V49A15 15 0 0 1 49 64H15A15 15 0 0 1 0 49V15A15 15 0 0 1 15 0Z';
const HEAD='M7.56 52.74A25 25 0 0 1 56.44 52.74A6 6 0 0 1 50.57 60H13.43A6 6 0 0 1 7.56 52.74Z';
const LOOK={idle:[0,0],thinking:[-3.5,-1],working:[-3,1.5],waiting:[-2.5,1],done:[-2.5,0],error:[-2.5,0],sleep:[-2.5,0],listening:[-1.5,3]};
const FACE={done:'happy',error:'x',sleep:'sleep'};
const POKE_WORDS=['嗨！','在呢','有事吗？','痒～','我在听','嘿嘿'];
const motion=matchMedia('(prefers-reduced-motion: reduce)');
let reduce=motion.matches;
const rnd=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let uid=0;

class ZpPet{
  constructor(host,{size=64,fx=true,follow=false,poke=true}={}){
    const id='zp'+(++uid);
    this.host=host;this.timers=new Set();this.tasks=new Set();this.lastFollow=0;this.pokes=[];this.effects=fx;
    host.classList.add('zp-pet');host.style.setProperty('--size',size+'px');
    host.dataset.state='idle';host.dataset.face='open';if(!fx)host.dataset.fx='off';
    host.innerHTML=`<svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><clipPath id="${id}c"><path d="${SQ}"/></clipPath>
        <linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      <g class="tile"><path d="${SQ}" fill="#170057"/>
        <g clip-path="url(#${id}c)">
          <g class="body"><path d="${HEAD}" fill="#fff"/>
            <g class="face">
              <g class="blush"><ellipse cx="19" cy="50.5" rx="3.6" ry="2.2"/><ellipse cx="50" cy="50.5" rx="3.6" ry="2.2"/></g>
              <g class="f-open"><rect class="eye" x="23.5" y="37.5" width="7" height="12" rx="3.5"/><rect class="eye" x="38.5" y="37.5" width="7" height="12" rx="3.5"/></g>
              <g class="f-happy"><path d="M23 46Q27 39.5 31 46"/><path d="M38 46Q42 39.5 46 46"/></g>
              <g class="f-x"><path d="M24.3 40.5l5.4 6.2M29.7 40.5l-5.4 6.2"/><path d="M39.3 40.5l5.4 6.2M44.7 40.5l-5.4 6.2"/></g>
              <g class="f-sleep"><path d="M23.5 43.5Q27 47.2 30.5 43.5"/><path d="M38.5 43.5Q42 47.2 45.5 43.5"/></g>
            </g>
          </g>
          <g class="shine"><rect x="-34" y="-6" width="18" height="76" fill="url(#${id}g)" transform="skewX(-16)"/></g>
        </g></g></svg>
      <div class="fx" aria-hidden="true"><div class="bubble"></div><div class="zzz"><i>z</i><i>z</i><i>Z</i></div><div class="drop"></div></div>`;
    this.body=host.querySelector('.body');this.bubble=host.querySelector('.bubble');this.fx=host.querySelector('.fx');
    this.canFollow=follow;
    if(poke)host.addEventListener('click',()=>this.poke());
    this.blinkLoop();this.set('idle');
  }
  get state(){return this.currentState}
  delay(fn,ms){
    const t=setTimeout(()=>{this.tasks.delete(t);this.timers.delete(t);fn()},ms);
    this.tasks.add(t);return t;
  }
  cancel(t){clearTimeout(t);this.tasks.delete(t);this.timers.delete(t)}
  later(fn,ms){const t=this.delay(fn,ms);this.timers.add(t);return t}
  clear(){this.timers.forEach(t=>{clearTimeout(t);this.tasks.delete(t)});this.timers.clear()}
  destroy(){this.tasks.forEach(clearTimeout);this.tasks.clear();this.host.remove()}

  /* 头是一个矮圆顶，眼睛只能在圆顶里挪：越往上，左右能挪的范围越小 */
  look(x,y){y=clamp(y,-1.2,3);x=clamp(x,-6-1.2*y,1+1.2*y);this.host.style.setProperty('--lx',x);this.host.style.setProperty('--ly',y)}
  face(f){this.host.dataset.face=f}
  flash(cls,ms){this.host.classList.remove(cls);void this.host.offsetWidth;this.host.classList.add(cls);this.delay(()=>this.host.classList.remove(cls),ms)}
  restartBody(){this.body.style.animation='none';void this.host.offsetWidth;this.body.style.animation=''}
  say(html,ms=0,warn=false){
    this.bubble.innerHTML=html;this.bubble.classList.toggle('warn',warn);this.bubble.classList.add('show');
    this.cancel(this.sayT);if(ms)this.sayT=this.delay(()=>this.hush(),ms);
  }
  hush(){this.bubble.classList.remove('show')}
  set(s){
    this.clear();this.hush();this.cancel(this.sayT);
    this.currentState=s;
    if(reduce){this.host.dataset.state='idle';this.face('open');this.look(0,0);return}
    this.host.dataset.state=s;this.face(FACE[s]||'open');
    const [x,y]=LOOK[s]||[0,0];this.look(x,y);
    if(s==='done'){this.restartBody();this.sparkle()}
    if(s==='error'){this.restartBody()}
    if(s==='thinking'){this.say('<span class="dots"><i>·</i><i>·</i><i>·</i></span>');this.thinkLoop()}
    if(s==='waiting')this.say('!',0,true);
    if(s==='working')this.workLoop();
    if(s==='idle')this.idleLoop();
  }
  /* 眨眼：大多数状态都会眨 */
  blinkLoop(){
    const go=()=>{
      if(this.host.dataset.face==='open'&&(reduce||this.state!=='sleep')){
        this.flash('blink',130);
        if(Math.random()<.22)this.delay(()=>this.flash('blink',120),260);
      }
      this.delay(go,this.state==='working'?rnd(1500,3000):rnd(2200,5200));
    };
    this.delay(go,rnd(800,2000));
  }
  /* 待机：时不时东张西望 */
  idleLoop(){
    if(reduce||!this.effects)return;
    this.later(()=>{
      if(this.state!=='idle')return;
      if(Date.now()-this.lastFollow>2500){
        const r=Math.random();
        if(r<.5){ // 张望：先看左，再看右，再回来
          this.look(-8,1.5);
          this.later(()=>this.look(2.5,1.5),rnd(800,1100));
          this.later(()=>this.look(0,0),rnd(1800,2200));
        }else if(r<.75){
          this.look(rnd(-3.5,-1.5),-1.2);this.later(()=>this.look(0,0),1100);
        }else{
          this.flash('peek',600);
        }
      }
      this.idleLoop();
    },rnd(3500,7000));
  }
  thinkLoop(){
    if(!this.effects)return;
    let f=false;const step=()=>{f=!f;this.look(f?-1.5:-4,-1);this.later(step,rnd(900,1300))};
    this.later(step,700);
  }
  workLoop(){
    if(!this.effects)return;
    let f=false;const step=()=>{f=!f;this.look(f?-7:0,1.5);this.later(step,rnd(320,520))};
    step();
  }
  follow(px,py){
    if(reduce||!this.canFollow||!['idle','waiting'].includes(this.state))return;
    const r=this.host.getBoundingClientRect();
    const dx=px-(r.left+r.width/2),dy=py-(r.top+r.height/2);
    const ly=clamp(dy/70,-1.2,3);
    this.look(-2.5+dx/55,this.state==='waiting'?Math.max(ly,.5):ly);
    this.lastFollow=Date.now();
  }
  nod(){if(reduce)return;this.flash('nod',220)}
  sparkle(){
    if(reduce||!this.effects)return;
    const colors=['#ffc93c','#ff8fb1','#8fb4ff','#7be0b5'];
    for(let i=0;i<9;i++){
      const s=document.createElement('span');s.className='spark';
      const a=i/9*Math.PI*2+rnd(-.2,.2),d=rnd(.55,.85);
      s.style.setProperty('--dx',`calc(var(--size) * ${Math.cos(a)*d})`);
      s.style.setProperty('--dy',`calc(var(--size) * ${Math.sin(a)*d-.1})`);
      s.style.setProperty('--c',colors[i%4]);s.style.animationDelay=rnd(0,.12)+'s';
      this.fx.appendChild(s);this.delay(()=>s.remove(),1200);
    }
  }
  poke(){
    if(reduce)return;
    if(this.state==='sleep'){this.wake();return}
    const now=Date.now();this.pokes=this.pokes.filter(t=>now-t<3000);this.pokes.push(now);
    if(this.pokes.length>=5){
      this.pokes=[];this.flash('dizzy',700);this.face('x');
      this.say('别戳啦 @_@',1400);this.delay(()=>{if(this.host.dataset.face==='x'&&this.state!=='error')this.face(FACE[this.state]||'open')},1400);
      return;
    }
    this.flash('squish',500);
    if(['idle','listening','waiting'].includes(this.state)){
      this.face('happy');this.delay(()=>{if(this.host.dataset.face==='happy'&&this.state!=='done')this.face('open')},650);
    }
    if(this.state!=='waiting'&&this.state!=='thinking')this.say(POKE_WORDS[Math.floor(Math.random()*POKE_WORDS.length)],1200);
    this.onPoke&&this.onPoke();
  }
  wake(){this.set('idle');if(reduce)return;this.flash('peek',600);this.delay(()=>this.flash('blink',120),300)}
}

/* Current-conversation DOM adapter. No upstream stores are exposed to brand scripts. */
  const slots = '[data-slot="sidebar.brand.mark"], [data-slot="conversation.hero.brand.mark"]';
  const pets = new Map();
  let current = 'idle', session, previousBusy = false, worked = false, doneUntil = 0;
  let alertsBeforeSend = new Set(), rejected = false, terminalBeforeBusy = '';
  let typingUntil = 0, lastActivity = Date.now(), sleepTimer, doneTimer, typingTimer;

  function paint(state) {
    current = state;
    for (const pet of pets.values()) if (pet.state !== state) pet.set(state);
  }

  function mount() {
    for (const [slot, pet] of pets) {
      if (slot.isConnected && slot.contains(pet.host)) continue;
      pet.destroy(); slot.removeAttribute('data-zp-pet-ready'); pets.delete(slot);
    }
    for (const slot of document.querySelectorAll(slots)) {
      if (pets.has(slot)) continue;
      const hero = slot.dataset.slot === 'conversation.hero.brand.mark';
      const host = document.createElement(hero ? 'button' : 'span');
      if (hero) { host.type = 'button'; host.setAttribute('aria-label', '戳一下兆华工作伙伴'); }
      else host.setAttribute('aria-hidden', 'true');
      // Build off-DOM. The fallback disappears only after the SVG is complete.
      const pet = new ZpPet(host, { size: hero ? 40 : 22, fx: hero, follow: hero, poke: hero });
      pet.set(current);
      slot.appendChild(host); pets.set(slot, pet); slot.setAttribute('data-zp-pet-ready', '');
    }
  }

  function scan() {
    mount();
    const main = document.querySelector('[data-slot="main.conversation"]');
    const content = main?.querySelector('[data-conversation-session]');
    const selected = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
    const id = content?.dataset.conversationSession || selected?.dataset.rowKey.slice('session:'.length) || '';
    if (id !== session) {
      session = id; alertsBeforeSend.clear(); rejected = false; previousBusy = false; worked = false; doneUntil = 0; typingUntil = 0;
      clearTimeout(doneTimer); clearTimeout(typingTimer);
    }
    if (!main) { paint('idle'); return; }
    const composer = main.querySelector('[data-slot="conversation.composer"]');
    const nodes = [...main.querySelectorAll('[data-chat-turn]')];
    const turn = Math.max(-1, ...nodes.map(n => Number(n.dataset.chatTurn)));
    const latest = nodes.filter(n => Number(n.dataset.chatTurn) === turn);
    const has = selector => latest.some(n => n.matches(selector) || n.querySelector(selector));
    const closed = has('[data-turn-process], [data-turn-tail], [data-chat-flow-kind="turn-error"]');
    // The stop glyph is shared by all locales; its geometry is part of InputBar.
    const stopping = composer?.querySelector('button svg rect[x="3"][y="3"][width="10"][height="10"]');
    const sending = composer?.querySelector('[data-sending]');
    const streaming = has('[data-streaming="true"], [data-tool][data-state="running"], [data-variant="think"][data-state="running"]');
    const busy = Boolean(sending || stopping || streaming || (!closed && selected?.querySelector('[data-state="ongoing"]')));
    const waiting = main.querySelector('[data-approval-key][aria-busy="false"], [data-plan-review-key][aria-busy="false"]');
    const disconnected = !navigator.onLine || document.querySelector('button[data-phase="disconnected"], button[data-phase="connecting"]');
    const terminal = closed ? String(turn) : '';
    const ended = closed && terminal !== terminalBeforeBusy;
    const failed = has('[data-chat-flow-kind="turn-error"]');
    // InputBar reports submission rejection in a warning Toast portal before a
    // Turn exists. Only correlate newly mounted warnings with our pending send.
    const warnings = [...document.querySelectorAll('[role="alert"]')].filter(n =>
      n.querySelector('[data-icon="dsw-icon-warning-outline-regular"]'));
    if (!busy && previousBusy && warnings.some(n => !alertsBeforeSend.has(n))) rejected = true;
    if (busy) {
      if (!previousBusy) { worked = false; terminalBeforeBusy = terminal; alertsBeforeSend = new Set(warnings); }
      rejected = false;
      if (streaming) worked = true;
      doneUntil = 0;
    } else if (previousBusy && ended && !failed && !rejected && !disconnected) {
      doneUntil = Date.now() + 2000;
      clearTimeout(doneTimer); doneTimer = setTimeout(scan, 2000);
    }
    previousBusy = busy || (previousBusy && !ended && !rejected && !disconnected);
    if (disconnected || rejected || (failed && !busy && !previousBusy)) paint('error');
    else if (waiting) paint('waiting');
    else if (busy || previousBusy) paint(worked ? 'working' : 'thinking');
    else if (Date.now() < doneUntil) paint('done');
    else if (Date.now() - lastActivity >= 120000) paint('sleep');
    else if (Date.now() < typingUntil && composer?.contains(document.activeElement)) paint('listening');
    else paint('idle');
  }

  function activity() {
    lastActivity = Date.now();
    clearTimeout(sleepTimer); sleepTimer = setTimeout(scan, 120000);
    if (current === 'sleep') {
      for (const pet of pets.values()) pet.wake();
      scan();
    }
  }
  document.addEventListener('pointermove', e => {
    activity();
    for (const pet of pets.values()) pet.follow(e.clientX, e.clientY);
  }, { passive: true });
  document.addEventListener('pointerdown', activity, { passive: true });
  document.addEventListener('keydown', activity);
  document.addEventListener('input', e => {
    if (!e.target.closest('[data-slot="main.conversation"] [data-composer-input]')) return;
    activity(); typingUntil = Date.now() + 1500;
    for (const pet of pets.values()) pet.nod();
    clearTimeout(typingTimer); typingTimer = setTimeout(scan, 1500); scan();
  });
  document.addEventListener('focusout', () => queueMicrotask(scan));
  addEventListener('offline', scan); addEventListener('online', scan);
  motion.addEventListener('change', () => {
    reduce = motion.matches;
    for (const pet of pets.values()) pet.set(current);
  });
  // Observe only semantic changes outside the pets, never animation style updates.
  const observer = new MutationObserver(records => {
    if (records.some(r => !r.target.closest?.('.zp-pet') && !r.target.parentElement?.closest('.zp-pet'))) scan();
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-conversation-session', 'aria-selected', 'aria-busy', 'data-sending',
      'data-state', 'data-streaming', 'data-phase', 'data-chat-turn', 'data-chat-flow-kind'],
  });
  activity(); scan();

})();
