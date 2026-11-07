/** Browser proof using an explicitly configured local CDP browser; no app build. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] || 'http://127.0.0.1:8811/crysound/prototypes/partner-entry/';
const output = process.argv[3] || fileURLToPath(new URL('./evidence/', import.meta.url));
const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const tab = process.env.CDP_TAB
  ? (await (await fetch(endpoint + '/json/list')).json()).find(p => p.id === process.env.CDP_TAB)
  : await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT' })).json();
assert(tab, 'The configured browser tab must exist');
await mkdir(output, { recursive: true });
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
const errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timeout);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression) {
  for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await pause(100); }
  throw new Error('Browser assertion timed out: ' + expression);
}
async function click(selector) { assert(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function state(value) { await evaluate(`document.querySelector('#state').value=${JSON.stringify(value)};document.querySelector('#state').dispatchEvent(new Event('change'))`); }
async function layout() {
  const measured = await evaluate(`({viewport:innerWidth,document:document.documentElement.scrollWidth,pet:document.querySelector('#pet svg')?.getBoundingClientRect().width,partner:document.querySelector('#partner').getBoundingClientRect().width})`);
  assert(measured.document <= measured.viewport, 'No horizontal page overflow: ' + JSON.stringify(measured));
  assert(measured.pet === 32 && measured.partner >= 44, 'Avatar and touch target remain usable');
  return measured;
}
async function shot(name) {
  await pause(200);
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(output + '/' + name + '.png', Buffer.from(result.data, 'base64'));
}
const storageKey = 'crysound-partner-entry-prototype-v1';
let saved;
const report = { screenshots: [], checks: [] };
try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url: target });
  await until(`document.body?.dataset.ready === 'true'`);
  saved = await evaluate(`localStorage.getItem('${storageKey}')`);
  await evaluate(`localStorage.removeItem('${storageKey}')`);
  await send('Page.reload'); await until(`document.body?.dataset.ready === 'true'`);
  report.screenshots.push({ file: 'light.png', ...await layout() }); await shot('light');
  const initial = await evaluate(`document.querySelector('#transcript').innerText`);
  await click('[data-task="1"]');
  assert.equal(await evaluate(`document.querySelector('#title').textContent`), '声学相机方案初稿');
  await click('#partner');
  assert.equal(await evaluate(`document.querySelector('#transcript').innerText`), initial);
  report.checks.push('Task navigation returns to the same main conversation');
  for (const value of ['idle', 'thinking', 'working', 'waiting', 'done']) {
    await state(value);
    assert.equal(await evaluate(`document.querySelector('#pet').dataset.state`), value);
    assert.equal(await evaluate(`document.querySelector('#confirmation').hidden`), value !== 'waiting');
  }
  report.checks.push('Five states reach the production animated logo; only waiting shows confirmation');
  await state('waiting'); await click('#theme');
  report.screenshots.push({ file: 'dark.png', ...await layout() }); await shot('dark');
  await click('#decline'); assert.equal(await evaluate(`document.querySelector('#pet').dataset.state`), 'idle');
  const input = '接着上次的反馈 <script>仅作为文字</script>';
  await evaluate(`document.querySelector('#message').value=${JSON.stringify(input)};document.querySelector('#composer').requestSubmit()`);
  await until(`document.querySelector('#pet').dataset.state === 'waiting'`);
  assert(await evaluate(`document.querySelector('#transcript').textContent.includes(${JSON.stringify(input)})`));
  assert.equal(await evaluate(`document.querySelectorAll('#transcript script').length`), 0);
  await click('#confirm'); await until(`document.querySelector('#pet').dataset.state === 'done'`);
  report.checks.push('Send → think → work → confirm → done; text stays literal');
  await send('Page.reload'); await until(`document.body?.dataset.ready === 'true'`);
  assert(await evaluate(`document.querySelector('#transcript').textContent.includes(${JSON.stringify(input)})`));
  report.checks.push('Reload restores local prototype conversation (not cross-device sync)');
  // Keep review screenshots on deterministic example content.
  await evaluate(`localStorage.removeItem('${storageKey}')`); await send('Page.reload'); await until(`document.body?.dataset.ready === 'true'`);
  await click('#collapse');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.partner-copy')).display`), 'none');
  await click('[data-task="0"]'); await click('#partner');
  assert.equal(await evaluate(`document.querySelector('#title').textContent`), '伙伴');
  report.screenshots.push({ file: 'collapsed.png', ...await layout() }); await shot('collapsed');
  report.checks.push('Collapsed avatar opens the main conversation without expanding the sidebar');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.reload'); await until(`document.body?.dataset.ready === 'true'`);
  assert(await evaluate(`document.querySelector('#sidebar').classList.contains('collapsed')`));
  report.screenshots.push({ file: 'narrow.png', ...await layout() }); await shot('narrow');
  await click('#collapse'); await layout(); await click('[data-task="2"]'); await click('#partner'); await click('#collapse');
  report.checks.push('Narrow screen supports expansion, task switch, return and collapse without horizontal overflow');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await state('waiting'); assert(await evaluate(`document.querySelector('#partner').getAttribute('aria-label').includes('等你确认')`));
  assert.deepEqual(errors, []);
  report.checks.push('Reduced motion retains the text status; no uncaught browser errors');
  await writeFile(output + '/browser-checks.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (saved !== undefined) await evaluate(saved === null ? `localStorage.removeItem('${storageKey}')` : `localStorage.setItem('${storageKey}',${JSON.stringify(saved)})`).catch(() => {});
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  ws.close();
  if (!process.env.CDP_TAB) await fetch(endpoint + '/json/close/' + tab.id);
}
