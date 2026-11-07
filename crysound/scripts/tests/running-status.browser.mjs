// Run the real published React component in an owned tab of the configured browser session.
// Response interception and the preview root affect this tab only; no prompts or preferences are saved.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { patchRunningStatusModule } from '../patch-running-status.mjs';

const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const tabId = process.env.CDP_TAB;
const origin = process.env.APP_ORIGIN;
assert.ok(tabId && origin && process.env.EVIDENCE_DIR, 'Set CDP_TAB, APP_ORIGIN and EVIDENCE_DIR');
const out = path.resolve(process.env.EVIDENCE_DIR);
fs.mkdirSync(out, { recursive: true });
const tabs = await (await fetch(endpoint + '/json/list')).json();
const tab = tabs.find(t => t.id === tabId);
assert.ok(tab, 'Dedicated tab must exist');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map(), errors = [], results = [];
let serial = 0, phase = 'before', intercepted = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const call = async (fn, value) => {
  const global = await send('Runtime.evaluate', { expression: 'globalThis' });
  try {
    const result = await send('Runtime.callFunctionOn', { objectId: global.result.objectId, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally { await send('Runtime.releaseObject', { objectId: global.result.objectId }); }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression) {
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error('Timeout: ' + expression);
}
ws.onmessage = async event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    return;
  }
  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  try {
    const result = await send('Fetch.getResponseBody', { requestId });
    let body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
    const id = body.indexOf('id: "@deepseek-ai/dsh-client-ui-chat"');
    if (id < 0) { await send('Fetch.continueRequest', { requestId }); return; }
    const start = body.lastIndexOf('window.__ModuleLoader__.load({', id);
    const next = body.indexOf('window.__ModuleLoader__.load({', id);
    let chunk = body.slice(start, next < 0 ? undefined : next);
    if (phase === 'after') chunk = patchRunningStatusModule(chunk);
    const expose = `globalThis.__zpRunningPreview = { React: react, createRoot: require("react-dom/client").createRoot,
      Component: RunningStatus, dictionaries: {zh,en,ja,es,fr,de,ru,pt} };\n`;
    assert.equal(chunk.split('return module.exports;').length, 2);
    chunk = chunk.replace('return module.exports;', expose + 'return module.exports;');
    body = body.slice(0, start) + chunk + (next < 0 ? '' : body.slice(next));
    intercepted++;
    await send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(body).toString('base64') });
  } catch (error) {
    errors.push(String(error));
    await send('Fetch.continueRequest', { requestId });
  }
};
try {
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*plugins/*', requestStage: 'Response' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  for (phase of ['before', 'after']) {
    const previous = intercepted;
    await send('Page.navigate', { url: origin });
    await until('Boolean(globalThis.__zpRunningPreview)');
    assert.ok(intercepted > previous);
    await call(function () {
      const { React, createRoot, Component, dictionaries } = globalThis.__zpRunningPreview;
      const host = document.createElement('section');
      host.id = 'zp-running-preview';
      host.style.cssText = 'position:fixed;left:24px;top:24px;width:680px;height:230px;box-sizing:border-box;padding:24px;z-index:2147483647;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-background-primary, Canvas);color:var(--dsw-alias-label-primary);font-family:system-ui';
      document.body.appendChild(host);
      const root = createRoot(host);
      const node = React.createElement;
      const t = lang => (key, params = {}) => {
        let text = dictionaries[lang][key] || key;
        for (const [name, value] of Object.entries(params)) text = text.replace('{' + name + '}', value);
        return text;
      };
      root.render(node(React.Fragment, null,
        node('div', { id: 'preview-heading', style: { fontSize: '13px', marginBottom: '16px' } }, '运行状态组件预览'),
        ...[{ startTime: Date.now() - 16000, t: t('zh') }, { t: t('zh') }, { startTime: Date.now() - 16000, t: t('en') }]
          .map((props, i) => node('div', { key: i, 'data-preview-case': i }, node(Component, { ...props, paused: true })))));
      globalThis.__zpRunningPreview.root = root;
    });
    await until('document.querySelectorAll("#zp-running-preview [data-chat-running]").length===3');
    for (const skin of ['default', 'soft']) for (const theme of ['light', 'dark']) {
      await call(function ({ skin, theme, phase }) {
        document.documentElement.dataset.zpSkin = skin;
        document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
        document.documentElement.style.colorScheme = theme;
        document.getElementById('preview-heading').textContent = `${phase === 'before' ? '改前' : '改后'} · ${skin === 'soft' ? '兆华柔和' : '默认外观'} · ${theme === 'dark' ? '深色' : '浅色'}`;
      }, { skin, theme, phase });
      await pause(180);
      const report = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('#zp-running-preview [data-chat-running]')];
        const row = rows[0], icon = row.lastElementChild.firstElementChild;
        const probe = document.createElement('span'); probe.style.color='var(--dsw-alias-label-secondary)'; row.appendChild(probe);
        const secondary=getComputedStyle(probe).color; probe.remove();
        return { labels: rows.map(r=>r.lastElementChild.textContent), announcements: rows.map(r=>r.querySelector('[role=status]').textContent),
          color:getComputedStyle(row).color, secondary, shimmer:getComputedStyle(row).getPropertyValue('--dsw-alias-label-shimmer').trim(),
          iconColor:getComputedStyle(icon).color, svg:icon.querySelectorAll('svg').length,
          animation:getComputedStyle(icon,':after').animationName, mask:getComputedStyle(icon,':after').maskImage };
      })()`);
      assert.equal(report.labels[0], phase === 'after' ? '处理中，用时 16秒 ···' : '深度求索中，用时 16秒 ···');
      assert.equal(report.labels[1], phase === 'after' ? '处理中' : '深度求索中');
      assert.equal(report.labels[2], phase === 'after' ? 'Working for 16s ···' : 'Deep diving for 16s ···');
      assert.deepEqual(report.announcements, phase === 'after' ? ['处理中', '处理中', 'Working'] : ['深度求索中', '深度求索中', 'Deep diving']);
      if (phase === 'after') {
        assert.equal(report.color, report.secondary);
        assert.equal(report.iconColor, report.secondary);
        assert.equal(report.svg, 0);
        assert.equal(report.animation, 'zp-running-spin');
        assert.equal(report.mask, 'none');
      }
      results.push({ phase, skin, theme, ...report });
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 24, y: 24, width: 680, height: 230, scale: 1 } });
      fs.writeFileSync(path.join(out, `${phase}-${skin}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    if (phase === 'after') {
      for (const features of [[{name:'prefers-reduced-motion',value:'reduce'}], [{name:'forced-colors',value:'active'}]]) {
        await send('Emulation.setEmulatedMedia', { features });
        const name = await evaluate('getComputedStyle(document.querySelector("#zp-running-preview [data-chat-running]").lastElementChild.firstElementChild,":after").animationName');
        assert.equal(name, 'none');
      }
      await send('Emulation.setEmulatedMedia', { features: [] });
      // Exercise actual React holding behavior and its CSS in the same mounted component.
      await call(function () {
        const { root, Component, React, dictionaries } = globalThis.__zpRunningPreview;
        root.render(React.createElement(Component, { startTime: Date.now()-16000, paused: true, holding: true, t: key=>dictionaries.zh[key] }));
      });
      await until('document.querySelector("#zp-running-preview [data-holding]")!==null');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#zp-running-preview [data-chat-running]")).visibility'), 'hidden');
      assert.equal(await evaluate('document.querySelectorAll("#zp-running-preview [role=status]").length'), 0);
    }
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ results, reducedMotion: 'passed', forcedColors: 'passed', holding: 'passed', errors }, null, 2) + '\n');
  console.log('8 before/after screenshots; zh/en copy, ARIA, theme colors, motion preferences and holding passed');
} finally {
  await send('Fetch.disable');
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.clearDeviceMetricsOverride');
  // Discard preview DOM and all test-only exports; no local storage or server data was changed.
  await send('Page.navigate', { url: 'about:blank' });
  ws.close();
}
