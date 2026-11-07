// Standalone, local-only prototype. It never calls the product or model API.
const $ = selector => document.querySelector(selector);
const labels = { idle: '随时找我', thinking: '正在思考', working: '正在整理', waiting: '等你确认', done: '已完成' };
const stateNames = { idle: '空闲', thinking: '思考', working: '工作', waiting: '等你确认', done: '完成' };
const seed = [
  { role: 'date', text: '周三 · 开始一起工作' },
  { role: 'user', text: '这周想把客户反馈整理清楚，先帮我理一下思路。' },
  { role: 'assistant', text: '好，我们先按使用场景、遇到的问题、期待的改进来整理。你把零散的反馈发给我，我们一条条梳理。' },
  { role: 'date', text: '今天 · 接着上次聊' },
  { role: 'user', text: '接着昨天的客户反馈，先给我一个沟通提纲。' },
  { role: 'assistant', text: '我们接着聊。提纲可以分成三部分：\n\n1. 确认客户最常用的测量场景。\n2. 按影响程度核对已有反馈。\n3. 对齐下一次沟通要带回的结果。\n\n你想先展开哪一部分？' },
];
const storageKey = 'crysound-partner-entry-prototype-v1';
let messages = seed.map(item => ({ ...item }));
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved) && saved.every(m => m && ['user', 'assistant', 'date'].includes(m.role) && typeof m.text === 'string')) messages = saved;
} catch { /* Browser storage is optional for this preview. */ }
let view = 'partner', state = 'idle', pet, timers = [];
const tasks = ['整理本周客户反馈', '声学相机方案初稿', '翻译产品规格书'];
function save() { try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch { /* Preview remains usable without persistence. */ } }
function cancelTimers() { timers.forEach(clearTimeout); timers = []; }
function later(callback, ms) { timers.push(setTimeout(callback, ms)); }
function scrollBottom() { $('#chat-scroll').scrollTo({ top: $('#chat-scroll').scrollHeight, behavior: 'instant' }); }
function render() {
  const main = view === 'partner';
  $('#partner').classList.toggle('selected', main);
  $('#partner').setAttribute('aria-current', main ? 'page' : 'false');
  $('#tasks').querySelectorAll('button').forEach(b => b.setAttribute('aria-current', view === b.dataset.task ? 'page' : 'false'));
  $('#title').textContent = main ? '伙伴' : (tasks[Number(view)] || '新任务');
  $('#subtitle').textContent = main ? '我们的对话，一直在这里。' : '独立的任务对话';
  $('#return-hint').textContent = main ? '接着上次聊，或说一件新事情。' : '伙伴主对话仍在侧栏最上方，随时可以回去。';
  $('#composer-context').textContent = main ? '伙伴主对话' : '普通任务';
  $('#message').disabled = !main;
  $('#composer button').disabled = !main;
  $('#message').placeholder = main ? '今天想一起做点什么？' : '此原型只演示伙伴主对话，点上方伙伴继续。';
  $('#transcript').replaceChildren();
  const shown = main ? messages : [{ role: 'assistant', text: `这是「${tasks[Number(view)] || '新任务'}」的独立对话。\n\n点侧栏顶部的伙伴，可以回到刚才的主对话。` }];
  for (const item of shown) {
    const node = document.createElement(item.role === 'date' ? 'div' : 'article');
    node.className = item.role === 'date' ? 'date' : `message ${item.role}`;
    if (item.role === 'date') node.textContent = item.text;
    else {
      if (item.role === 'assistant') { const author = document.createElement('div'); author.className = 'author'; author.textContent = '伙伴'; node.append(author); }
      const body = document.createElement('p'); body.textContent = item.text; node.append(body);
    }
    $('#transcript').append(node);
  }
  $('#confirmation').hidden = !(main && state === 'waiting');
  $('#header-status').textContent = main ? labels[state] : '任务对话';
  scrollBottom();
}
function setState(next) {
  state = next; pet?.set(next);
  $('#state').value = next;
  $('#side-status').textContent = labels[next];
  $('#status-dot').dataset.state = next;
  $('#partner').setAttribute('aria-label', `伙伴 · ${stateNames[next]}`);
  $('#partner').title = `伙伴 · ${stateNames[next]}`;
  $('#confirmation').hidden = !(view === 'partner' && next === 'waiting');
  $('#header-status').textContent = view === 'partner' ? labels[next] : '任务对话';
  $('#composer button').disabled = view !== 'partner' || ['thinking', 'working', 'waiting'].includes(next);
  if (next === 'waiting') scrollBottom();
}
$('#partner').addEventListener('click', () => { view = 'partner'; render(); setState(state); });
$('#tasks').addEventListener('click', event => { const target = event.target.closest('[data-task]'); if (target) { view = target.dataset.task; render(); } });
$('#new-task').addEventListener('click', () => { view = 'new'; render(); });
$('#collapse').addEventListener('click', () => {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  $('#collapse').setAttribute('aria-expanded', String(!collapsed));
  $('#collapse').setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  $('#collapse').title = collapsed ? '展开侧栏' : '收起侧栏';
});
$('#theme').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).colorScheme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').textContent = dark ? '浅色' : '深色';
});
$('#state').addEventListener('change', event => { cancelTimers(); setState(event.target.value); });
$('#composer').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#message').value.trim();
  if (!text || view !== 'partner' || ['thinking', 'working', 'waiting'].includes(state)) return;
  cancelTimers(); messages.push({ role: 'user', text }); save(); $('#message').value = ''; render(); setState('thinking');
  later(() => setState('working'), 900);
  later(() => {
    messages.push({ role: 'assistant', text: '我先把它整理成提纲，再和你确认下一步。\n\n（这是原型中的示例回复。）' });
    save(); render(); setState('waiting'); scrollBottom();
  }, 2200);
});
$('#confirm').addEventListener('click', () => {
  cancelTimers(); setState('working');
  later(() => { messages.push({ role: 'assistant', text: '简报提纲已整理好：背景、关键反馈、下一步安排。我们之后可以继续在这里完善。\n\n（示例结果，没有生成或发送真实文件。）' }); save(); render(); setState('done'); scrollBottom(); }, 900);
});
$('#decline').addEventListener('click', () => { cancelTimers(); setState('idle'); });
if (matchMedia('(max-width:680px)').matches) $('#collapse').click();
$('#theme').textContent = getComputedStyle(document.documentElement).colorScheme === 'dark' ? '浅色' : '深色';
render();
// Same preview technique as brand/logo-src/preview.html: reuse the production
// class verbatim, without its current-conversation DOM adapter. Never ship this
// eval-based preview loader into the product.
try {
  const response = await fetch('../../brand/pet.js');
  if (!response.ok) throw new Error('Logo source unavailable');
  const source = await response.text();
  const boundary = source.indexOf('/* Current-conversation DOM adapter.');
  if (boundary < 0) throw new Error('Logo preview boundary changed');
  const Pet = (0, eval)(source.slice(0, boundary) + 'return ZpPet;})();');
  pet = new Pet($('#pet'), { size: 32, fx: false, poke: false });
  setState(state); document.body.dataset.ready = 'true';
} catch (error) {
  const fallback = new Image(32, 32); fallback.src = '../../brand/zp-mark-32.svg'; fallback.alt = ''; $('#pet').append(fallback);
  document.body.dataset.ready = 'fallback'; console.error(error);
}
