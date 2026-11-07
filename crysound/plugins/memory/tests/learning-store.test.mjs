import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, recallData } from '../store.mjs';

const fact = { kind: 'preference', title: '汇报偏好', content: 'LEARNING_ORIGINAL_ONLY_94623' };
const reason = '本人表达长期偏好';
const add = value => ({ action: 'add', ids: [], fact: value, reason });

function fixture(t, limits) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-learning-'));
  const store = new MemoryStore(directory, limits);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const history = () => store.snapshot({ includeLearning: true }).learning;
  const bytes = () => readFileSync(join(directory, 'memory.sqlite'));
  return { store, directory, history, bytes };
}

test('learning writes facts and before/after records atomically; undo adds forgets originals', t => {
  const { store, directory, history, bytes } = fixture(t);
  const learned = store.applyLearning({ revision: 0, changes: [add(fact)] });
  assert.equal(learned.facts[0].source, 'conversation');
  const [entry] = history();
  assert.equal(entry.action, 'add');
  assert.equal(entry.reason, reason);
  assert.deepEqual(entry.before, []);
  assert.deepEqual(entry.after, learned.facts);
  const other = new MemoryStore(directory);
  try { assert.deepEqual(other.snapshot({ includeLearning: true }).learning, [entry]); }
  finally { other.close(); }
  assert.equal('learning' in recallData(store.snapshot({ includeLearning: true })), false);
  const undone = store.undoLearning({ revision: 1, id: entry.id });
  assert.deepEqual(undone.facts, []);
  assert.deepEqual(history(), []);
  assert.equal(bytes().includes(Buffer.from(fact.content)), false);
  assert.throws(() => store.undoLearning({ revision: 2, id: entry.id }), /已撤销、删除或到期/u);
});

test('update and delete can each be undone without replacing unrelated facts', t => {
  const { store, history } = fixture(t);
  const initial = store.save({ ...fact, revision: 0 });
  const id = initial.savedId;
  store.save({ ...fact, title: '无关条目', content: '另外一个独立偏好', revision: 1 });
  const before = store.snapshot();
  store.applyLearning({ revision: 2, changes: [{ action: 'update', ids: [id], fact: { ...fact, content: '学习后的内容' }, reason }] });
  const [update] = history();
  assert.deepEqual(update.before, [before.facts.find(fact => fact.id === id)]);
  assert.equal(update.after[0].content, '学习后的内容');
  const restored = store.undoLearning({ revision: 3, id: update.id });
  assert.deepEqual(restored.facts, before.facts);
  assert.equal(history()[0].undone, true);
  assert.throws(() => store.undoLearning({ revision: 4, id: update.id }), /已撤销、删除或到期/u);
  store.applyLearning({ revision: 4, changes: [{ action: 'delete', ids: [id], reason }] });
  const [deleted] = history();
  assert.equal(deleted.action, 'delete');
  assert.deepEqual(deleted.after, []);
  const restoredDelete = store.undoLearning({ revision: 5, id: deleted.id });
  assert.deepEqual(restoredDelete.facts, before.facts);
});

test('merged facts share one reversible record with complete original metadata', t => {
  const { store, history } = fixture(t);
  const a = store.save({ ...fact, revision: 0 }).savedId;
  const b = store.save({ ...fact, title: '汇报方式', content: '喜欢表格', revision: 1 }).savedId;
  const before = store.snapshot();
  const merged = store.applyLearning({ revision: 2, changes: [{ action: 'merge', ids: [a, b], fact: { ...fact, content: '喜欢先给结论，再给表格' }, reason: '两条汇报偏好合并' }] });
  assert.equal(merged.facts.length, 1);
  assert.equal(merged.facts[0].id, a);
  const [entry] = history();
  assert.equal(entry.action, 'merge');
  assert.equal(entry.before.length, 2);
  assert.deepEqual(entry.after, merged.facts);
  const undone = store.undoLearning({ revision: 3, id: entry.id });
  assert.deepEqual(undone.facts, before.facts);
});

test('stale undo and undo after a manual edit refuse to overwrite the newer value', t => {
  const { store, history } = fixture(t);
  store.applyLearning({ revision: 0, changes: [add(fact)] });
  const [entry] = history();
  store.save({ ...fact, id: entry.after[0].id, content: '本人在页面改过', revision: 1 }, { source: 'edited', requireEnabled: false });
  const before = store.snapshot({ includeLearning: true });
  assert.throws(() => store.undoLearning({ revision: 1, id: entry.id }), /已变化/u);
  assert.throws(() => store.undoLearning({ revision: 2, id: entry.id }), /后来已被修改/u);
  assert.deepEqual(store.snapshot({ includeLearning: true }), before);
});

test('forgetting a fact removes every historical version; clearing erases all records', t => {
  const { store, history, bytes } = fixture(t);
  store.applyLearning({ revision: 0, changes: [add(fact)] });
  const id = store.snapshot().facts[0].id;
  store.applyLearning({ revision: 1, changes: [{ action: 'update', ids: [id], fact: { ...fact, content: '现在的新偏好' }, reason }] });
  assert.equal(history().length, 2);
  store.remove({ revision: 2, id });
  assert.deepEqual(history(), []);
  assert.equal(bytes().includes(Buffer.from(fact.content)), false);
  assert.equal(bytes().includes(Buffer.from('现在的新偏好')), false);
  store.applyLearning({ revision: 3, changes: [add(fact)] });
  store.clear({ revision: 4, confirmed: true });
  assert.deepEqual(history(), []);
  assert.deepEqual(store.snapshot().facts, []);
  assert.equal(bytes().includes(Buffer.from(fact.content)), false);
});

test('expired history is erased without changing current facts or revision', t => {
  const { store, history, bytes } = fixture(t);
  store.applyLearning({ revision: 0, changes: [add(fact)] });
  const id = store.snapshot().facts[0].id;
  store.save({ ...fact, id, content: '保留当前内容', revision: 1 }, { source: 'edited', requireEnabled: false });
  const before = store.snapshot();
  // A persisted record older than thirty days simulates a sleeping host resuming.
  store.db.prepare('UPDATE learning_changes SET createdAt=?').run(new Date(Date.now() - 31 * 86400000).toISOString());
  assert.deepEqual(history(), []);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(bytes().includes(Buffer.from(fact.content)), false);
});

test('a rejected proposal rolls back both facts and every record in that run', t => {
  const { store, history } = fixture(t);
  for (const changes of [
    [add(fact), add({ ...fact, content: '密码不能保存' })],
    [add(fact), { action: 'merge', ids: [], fact, reason }],
    [add(fact), { ...add(fact), reason: '密码出现在理由里也不能保存' }],
    Array.from({ length: 4 }, () => add(fact)),
  ]) {
    assert.throws(() => store.applyLearning({ revision: 0, changes }));
    assert.deepEqual(store.snapshot().facts, []);
    assert.equal(store.snapshot().revision, 0);
    assert.deepEqual(history(), []);
  }
  store.applyLearning({ revision: 0, changes: [add(fact), add({ ...fact, title: '另一个偏好' })] });
  const entries = history();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].runId, entries[1].runId);
  const id = store.snapshot().facts[0].id;
  const before = store.snapshot({ includeLearning: true });
  assert.throws(() => store.applyLearning({ revision: 1, changes: Array.from({ length: 2 }, () => ({ action: 'delete', ids: [id], reason })) }), /重复/u);
  assert.deepEqual(store.snapshot({ includeLearning: true }), before);
});

test('learning honors both switches and the eighty-percent addition limit', t => {
  const { store, history } = fixture(t, { maxMemories: 5 });
  store.setAutoLearning({ revision: 0, autoLearning: false });
  assert.throws(() => store.applyLearning({ revision: 1, changes: [add(fact)] }), /已关闭/u);
  store.setAutoLearning({ revision: 1, autoLearning: true });
  store.setEnabled({ revision: 2, enabled: false });
  assert.throws(() => store.applyLearning({ revision: 3, changes: [add(fact)] }), /已关闭/u);
  store.setEnabled({ revision: 3, enabled: true });
  for (let i = 0; i < 4; i++) store.save({ ...fact, title: '偏好' + i, revision: 4 + i });
  assert.throws(() => store.applyLearning({ revision: 8, changes: [add(fact)] }), /八成/u);
  assert.deepEqual(history(), []);
  store.applyLearning({ revision: 8, changes: [{ action: 'update', ids: [store.snapshot().facts[0].id], fact: { ...fact, content: '用量八成仍可整理' }, reason }] });
  assert.equal(history().length, 1);
  const batchStore = fixture(t, { maxMemories: 5 }).store;
  for (let i = 0; i < 3; i++) batchStore.save({ ...fact, title: '批次偏好' + i, revision: i });
  assert.throws(() => batchStore.applyLearning({ revision: 3, changes: [add(fact), add({ ...fact, title: '第五条' })] }), /八成/u);
  assert.equal(batchStore.snapshot().facts.length, 3);
  assert.deepEqual(batchStore.snapshot({ includeLearning: true }).learning, []);
});

test('undo that would exceed capacity rolls back without losing its record', t => {
  const { store, history } = fixture(t, { maxMemories: 2 });
  const id = store.save({ ...fact, revision: 0 }).savedId;
  store.applyLearning({ revision: 1, changes: [{ action: 'delete', ids: [id], reason }] });
  const entry = history()[0];
  store.save({ ...fact, content: '新增甲', revision: 2 });
  store.save({ ...fact, content: '新增乙', revision: 3 });
  const before = store.snapshot({ includeLearning: true });
  assert.throws(() => store.undoLearning({ revision: 4, id: entry.id }), /预算/u);
  assert.deepEqual(store.snapshot({ includeLearning: true }), before);
});
