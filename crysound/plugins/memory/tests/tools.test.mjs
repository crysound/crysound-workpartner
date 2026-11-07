/** Run against the installed peer dependencies; no model credentials are used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';
import { MemoryStore } from '../store.mjs';

test('real host tool schemas, recall switch, confirmed merge and success metadata agree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-tools-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const disposers = [];
  t.after(() => {
    disposers.reverse().forEach(dispose => dispose?.());
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map();
  let section;
  apply({
    effect(fn) { disposers.push(fn()); },
    systemPrompt: { getSectionOrder() { return 1; }, section(value) { section = value; return () => {}; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject() {},
  }, { maxMemories: 2, recallChars: 6000 });
  const execute = (name, args) => tools.get('crysound_memory_' + name).execute(args, { signal: new AbortController().signal });
  const a = await execute('save', { revision: 0, kind: 'preference', title: '报告格式', content: '表格' });
  assert.equal(a.ok, true);
  const save = tools.get('crysound_memory_save');
  assert.equal(save.output.presentationMeta({}, a).memory.message, '已记住：报告格式');
  assert.deepEqual(save.output.presentationMeta({}, a).memory.saved, { id: a.facts[0].id, title: '报告格式' });
  const updated = await execute('save', { revision: 1, id: a.saved.id, kind: 'preference', title: '报告格式', content: '先结论再表格' });
  assert.equal(updated.saved.id, a.saved.id);
  assert.equal(updated.facts.length, 1);
  assert.equal(save.output.presentationMeta({}, a).memory.saved.id, a.facts[0].id);
  const rejected = await execute('save', { revision: 2, kind: 'identity', title: '测试号码', content: '11010519491231002X' });
  assert.equal(rejected.ok, false);
  assert.equal(save.output.presentationMeta({}, rejected).memory.saved, undefined);
  assert.equal(JSON.stringify(save.output.presentationMeta({}, rejected)).includes('110105'), false);
  const b = await execute('save', { revision: 2, kind: 'preference', title: '语气', content: '简洁' });
  const merged = await execute('save', { revision: 3, kind: 'project', title: '项目', content: '校准', confirmed: true,
    removeIds: [b.facts.find(f => f.id !== a.facts[0].id).id], updates: [{ id: a.facts[0].id, kind: 'preference', title: '报告习惯', content: '简洁表格' }] });
  assert.equal(merged.ok, true);
  assert.equal(merged.facts.length, 2);
  assert.match(section.text(), /已用 2\/2 条/u);
  assert.match(section.text(), /updatedDate/u);
  const peer = new MemoryStore(join(root, 'crysound-memory'), { maxMemories: 2 });
  try {
    peer.setEnabled({ enabled: false, revision: 4 });
    assert.equal(section.text(), '个人记忆已关闭；不要调用个人记忆保存工具。');
    assert.deepEqual((await execute('list', {})).facts, []);
    const disabled = await execute('save', { revision: 5, kind: 'project', title: '项目', content: '另一个' });
    assert.deepEqual(disabled, { ok: false, error: '个人记忆已关闭' });
  } finally { peer.close(); }
});
