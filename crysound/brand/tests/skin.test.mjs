import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const source = fs.readFileSync(new URL('../skin.js', import.meta.url), 'utf8');
function device(initial, blocked = false) {
  let value = initial;
  const events = new EventTarget();
  const root = { dataset: {} };
  const context = { document: { documentElement: root }, localStorage: {
    getItem() { if (blocked) throw new Error('blocked'); return value; },
    setItem(_key, next) { if (blocked) throw new Error('blocked'); value = next; },
  }, Event, window: events };
  vm.runInNewContext(source, context);
  return { root, api: events.zpSkin, context, events, stored: () => value };
}
test('first screen stays default for new or unrecognized preferences', () => {
  for (const initial of [null, '', 'purple', 'default']) assert.equal(device(initial).root.dataset.zpSkin, 'default');
});
test('switch applies immediately, persists across reload, and returns to default', () => {
  const d = device(null);
  let changes = 0;
  d.events.addEventListener('zp-skin-change', () => changes++);
  assert.equal(d.api.set('soft'), true);
  assert.equal(d.root.dataset.zpSkin, 'soft');
  assert.equal(device(d.stored()).root.dataset.zpSkin, 'soft');
  assert.equal(d.api.set('default'), true);
  assert.equal(device(d.stored()).root.dataset.zpSkin, 'default');
  assert.equal(changes, 2);
});
test('blocked storage retains default and reports an unsuccessful save', () => {
  const d = device(null, true);
  assert.equal(d.api.set('soft'), false);
  assert.equal(d.root.dataset.zpSkin, 'default');
});
test('other tabs and clearing preferences update the active appearance', () => {
  const d = device('soft');
  const send = (key, newValue) => {
    const event = new Event('storage');
    Object.assign(event, { key, newValue });
    d.events.dispatchEvent(event);
  };
  send('unrelated', 'default');
  assert.equal(d.api.get(), 'soft');
  send('zp-interface-style', 'default');
  assert.equal(d.api.get(), 'default');
  send('zp-interface-style', 'soft');
  assert.equal(d.api.get(), 'soft');
  send(null, null);
  assert.equal(d.api.get(), 'default');
});
