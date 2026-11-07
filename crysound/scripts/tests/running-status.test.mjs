// Exercise the published component rather than duplicating upstream source tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { patchRunningStatusModule, patchCompanyRunningStatusRuntime } from '../patch-running-status.mjs';

const packageDir = process.env.RUNNING_STATUS_PACKAGE;
if (!packageDir) throw new Error('RUNNING_STATUS_PACKAGE must name an unpacked, pristine dsh-client-ui-chat@0.2.2-rc.1 package');
const original = fs.readFileSync(path.join(packageDir, 'lib/client.js'), 'utf8');
const patched = patchRunningStatusModule(original);
function section(text, start) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, start);
  return text.slice(at, text.indexOf('\n\t\t//#endregion', at));
}
function harness() {
  let now = 5000, value, effect, cleanup, timers = new Map(), id = 0;
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props });
  const react = { memo: x => x, useState: initial => { value ??= initial(); return [value, x => { value = x; }]; },
    useEffect: next => { effect = next; } };
  const css = new Proxy({}, { get: (_, key) => key });
  const code = [section(patched, 'const LIVE_RUN_CLOCK_INTERVAL_MS'), section(patched, 'function RunningActivity()'),
    section(patched, 'const RunningStatus ='), ...['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'].map(lang => {
      const start = patched.indexOf('const ' + lang + ' = {');
      return patched.slice(start, patched.indexOf('\n\t\t};', start) + 6);
    })].join('\n');
  const context = { react, react_jsx_runtime: { jsx, jsxs: jsx }, ChatView_module_css_default: css,
    accessibility_module_css_default: css, _deepseek_ai_dsh_client_ui_primitives: { TextShimmer: props => jsx('span', props) },
    Date: { now: () => now }, setInterval: fn => { timers.set(++id, fn); return id; }, clearInterval: key => timers.delete(key) };
  const exports = vm.runInNewContext(code + '\n;({RunningStatus, dictionaries:{zh,en,ja,es,fr,de,ru,pt}})', context);
  const render = (props, lang = 'zh') => {
    const dict = exports.dictionaries[lang];
    const t = (key, params = {}) => {
      let text = dict[key] ?? ({ 'duration.hourUnit': '小时', 'duration.minuteUnit': '分', 'duration.secondUnit': '秒' })[key] ?? key;
      for (const [name, value] of Object.entries(params)) text = text.replace('{' + name + '}', value);
      return text;
    };
    return exports.RunningStatus({ t, paused: false, ...props });
  };
  const update = props => { cleanup?.(); render(props); cleanup = effect(); return render(props); };
  return { render, update, count: () => timers.size,
    tick: ms => { now += ms; for (const fn of timers.values()) fn(); },
    dispose: () => cleanup?.() };
}
const label = tree => tree.props.children[2].props.children[1].props.children;
const announcement = tree => tree.props.children[0]?.props.children;

test('eight languages show neutral visible and accessible labels with and without a clock', () => {
  const expected = { zh: '处理中', en: 'Working', ja: '処理中', es: 'Procesando', fr: 'Traitement en cours', de: 'In Bearbeitung', ru: 'Обработка', pt: 'Processando' };
  for (const [lang, text] of Object.entries(expected)) {
    const h = harness();
    const idle = h.render({}, lang);
    assert.equal(label(idle), text);
    assert.equal(announcement(idle), text);
    const running = h.render({ startTime: 1000 }, lang);
    assert.ok(label(running).includes(text));
    assert.match(label(running), /4/);
    assert.ok(label(running).endsWith(' ···'));
    assert.equal(announcement(running), text);
    const icon = running.props.children[2].props.children[0];
    assert.equal(icon.type, 'span');
    assert.equal(icon.props['aria-hidden'], 'true');
    assert.equal(icon.props.children, undefined);
  }
});

test('clock ticks without changing the announcement; pause, resume, holding and cleanup remain intact', () => {
  const h = harness();
  assert.equal(label(h.update({})), '处理中');
  assert.equal(h.count(), 0);
  assert.equal(label(h.update({ startTime: 1000 })), '处理中，用时 4秒 ···');
  assert.equal(h.count(), 1);
  h.tick(2000);
  assert.equal(label(h.render({ startTime: 1000 })), '处理中，用时 6秒 ···');
  assert.equal(announcement(h.render({ startTime: 1000 })), '处理中');
  h.update({ startTime: 1000, paused: true });
  h.tick(5000);
  assert.equal(h.count(), 0);
  assert.equal(label(h.render({ startTime: 1000, paused: true })), '处理中，用时 6秒 ···');
  assert.equal(label(h.update({ startTime: 1000 })), '处理中，用时 11秒 ···');
  const holding = h.update({ startTime: 1000, holding: true });
  assert.equal(holding.props['aria-hidden'], true);
  assert.equal(holding.props['data-holding'], '');
  assert.equal(holding.props.children[0], null);
  assert.equal(holding.props.children[2].props.children[1].props.active, false);
  assert.equal(h.count(), 0);
  assert.equal(label(h.update({ startTime: 20000 })), '处理中，用时 1秒 ···');
  h.dispose();
  assert.equal(h.count(), 0);
});

test('patch removes whale asset and blue aliases, reruns unchanged, and rejects artifact drift', () => {
  assert.equal(patchRunningStatusModule(patched), patched);
  assert.ok(!patched.includes('require.asset("plugins/@deepseek-ai/dsh-client-ui-chat/assets/running-whale'));
  assert.ok(!patched.includes('var(--dsw-alias-label-deep-diving'));
  assert.ok(!patched.includes('const REST_PATH'));
  assert.throws(() => patchRunningStatusModule(original.replace('"Deep diving"', '"Changed upstream"')), /expected one match/);
  assert.throws(() => patchRunningStatusModule(original.replace('runningWhaleAnimated{display:none', 'runningWhaleAnimated{display:flex')), /whale styles/);
});

test('runtime patch preserves hard-linked store bytes and mode, rejects changed version or module before writes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'running-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '@deepseek-ai/dsh-client-ui-chat');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const file = path.join(dir, 'lib/client.js'), manifest = path.join(dir, 'package.json'), store = path.join(root, 'store.js');
  fs.writeFileSync(manifest, JSON.stringify({ version: '0.2.2-rc.1' }));
  fs.writeFileSync(store, original, { mode: 0o640 });
  fs.chmodSync(store, 0o640);
  fs.linkSync(store, file);
  patchCompanyRunningStatusRuntime(root);
  assert.equal(fs.readFileSync(store, 'utf8'), original);
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const first = fs.statSync(file).ino;
  patchCompanyRunningStatusRuntime(root);
  assert.equal(fs.statSync(file).ino, first);
  fs.writeFileSync(manifest, JSON.stringify({ version: 'next' }));
  assert.throws(() => patchCompanyRunningStatusRuntime(root), /unsupported version/);
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
  fs.writeFileSync(manifest, JSON.stringify({ version: '0.2.2-rc.1' }));
  const drift = original.replace('"Deep diving"', '"Changed upstream"');
  fs.writeFileSync(file, drift);
  assert.throws(() => patchCompanyRunningStatusRuntime(root), /expected one match/);
  assert.equal(fs.readFileSync(file, 'utf8'), drift);
});
