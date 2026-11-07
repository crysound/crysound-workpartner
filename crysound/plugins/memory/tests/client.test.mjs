/** Exercise the shipped, unbundled client module and persisted Tool metadata. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  const entries = new Map();
  const effects = [];
  let state, factory;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [state ?? initial, value => { state = value; }],
    useEffect: fn => effects.push(fn),
    useRef: () => ({ current: null }),
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { factory = module.factory; } } },
    Intl, Date, Map, JSON,
  });
  const plugin = factory(name => { assert.equal(name, 'react'); return react; });
  plugin.apply({
    uiConversation: { binding(id) { return { target: target => ({ session: id, target }) }; } },
    slots: {
      inject(_slot, register) { const result = register(); if (result?.next) [...result]; },
      register(options, component) { entries.set(options.key || options.name, { options, component }); return () => {}; },
    },
  });
  return { entries, effects, state: () => state };
}
const result = (id, title, extra = {}) => ({ kind: 'tool-result', isError: false, meta: { memory: { ok: true, saved: { id, title } } }, ...extra });
function snapshot(...roots) {
  return { locations: { getTurn: turn => turn === 7 ? roots.map((_, i) => String(i)) : [] }, nodes: new Map(roots.map((root, i) => [String(i), { kind: 'tool-call', data: { root } }])) };
}
function render(receipt, view, ended = true) {
  return receipt({ turn: { turn: 7, ...(ended ? { end: {} } : {}) }, useMemoryChat: select => select(view) });
}

test('reply tail uses committed results, includes nested PTC, deduplicates updates and survives replay', () => {
  const { entries, state } = harness();
  const receipt = entries.get('conversation.chat.turnTail').component;
  const view = snapshot(result('a', '旧标题'), { subCalls: [result('a', '新标题'), result('b', '另一个偏好')] });
  const tree = render(receipt, view);
  assert.equal(tree.children[0].length, 2);
  assert.equal(tree.children[0][0].children[0].children[0], '已记住：新标题');
  assert.equal(tree.children[0][1].children[0].children[0], '已记住：另一个偏好');
  tree.children[0][1].children[0].props.onClick();
  assert.equal(state(), 'b');
  const replayed = render(harness().entries.get('conversation.chat.turnTail').component, view);
  assert.equal(replayed.children[0][0].children[0].children[0], '已记住：新标题');
});

test('pending, rejected, legacy and raw-argument lookalikes cannot claim a successful write', () => {
  const receipt = harness().entries.get('conversation.chat.turnTail').component;
  assert.equal(render(receipt, snapshot(result('a', '偏好')), false), null);
  assert.equal(render(receipt, snapshot(result('a', '偏好', { isError: true }))), null);
  assert.equal(render(receipt, snapshot({ kind: 'tool-result', meta: { memory: { ok: true, message: '已记住：旧卡片' } } })), null);
  assert.equal(render(receipt, snapshot({ phase: 'start', args: { saved: { id: 'a', title: '输入' } } })), null);
});

test('successful saves leave only the tail receipt; rejected calls still show their result', () => {
  const card = harness().entries.get('crysound_memory_save').component;
  assert.equal(card({ phase: 'result', block: result('a', '偏好') }), null);
  const failed = card({ phase: 'result', block: { meta: { memory: { ok: false, message: '保存失败' } } } });
  assert.equal(failed.children[0], '保存失败');
});

test('tail selection stays bound to the supplied Session source', () => {
  const { options } = harness().entries.get('conversation.chat.turnTail');
  const a = options.inject('session-a').hooks.memoryChat;
  const b = options.inject('session-b').hooks.memoryChat;
  assert.equal(a.session, 'session-a');
  assert.equal(b.session, 'session-b');
  assert.equal(a.target, 'chat');
  assert.notEqual(a, b);
});

test('background receipts are scoped to the committed session and turn, share one poll and show the first-learning explanation', async () => {
  const entries = new Map(), effects = [], states = [], timers = new Map();
  let factory, hook = 0, interval = 0, calls = 0;
  let rows = [
    { sessionId: 'own', turn: 7, id: 'actual', title: '长期偏好', notice: true },
    { sessionId: 'other', turn: 7, id: 'foreign', title: '其他会话', notice: true },
    { sessionId: 'own', turn: 8, id: 'later', title: '下一轮', notice: false },
  ];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) { const index = hook++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useEffect(effect) { effects.push(effect); }, useRef: () => ({ current: null }),
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { factory = module.factory; } } }, Intl, Date, Map, Set, JSON, AbortController,
    setInterval(callback) { timers.set(++interval, callback); return interval; }, clearInterval(id) { timers.delete(id); },
    async fetch(path) { assert.equal(path, '/crysound-memory/api/receipts'); calls++; return { ok: true, async json() { return { receipts: rows }; } }; },
  });
  factory(() => react).apply({ uiConversation: { binding() { return { target() {} }; } }, slots: {
    inject(_slot, register) { const result = register(); if (result?.next) [...result]; },
    register(options, component) { entries.set(options.key || options.name, component); return () => {}; },
  } });
  const component = entries.get('conversation.chat.turnTail');
  const render = () => { hook = 0; return component({ sessionId: 'own', turn: { turn: 7, end: {} }, useMemoryChat: () => '' }); };
  const textOf = node => !node ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join(' ') : textOf(node.children);
  assert.equal(render(), null);
  const dispose = effects.shift()();
  await new Promise(resolve => setImmediate(resolve));
  const tree = render();
  assert.match(textOf(tree), /已记住：长期偏好/u);
  assert.match(textOf(tree), /我会自动记下你的长期偏好，可在设置里关闭/u);
  assert.doesNotMatch(textOf(tree), /其他会话|下一轮/u);
  assert.equal(timers.size, 1); assert.equal(calls, 1);
  // A subsequent successful refresh reflects deletion; failures cannot fabricate receipts.
  rows = [];
  [...timers.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(render(), null);
  dispose(); assert.equal(timers.size, 0);
});
