/** Real released reader/writer, pinned byte-for-byte to commit 18f0fcd1c8 (memory 0.1.2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../store.mjs';
import { MemoryStore as ReleasedStore } from './fixtures/store-0.1.2.mjs';
const fact = { kind: 'preference', title: '报告顺序', content: '我一直喜欢工作报告先给结论' };

test('released 0.1.2 opens, reads and writes an upgraded database, including learned facts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let old = new ReleasedStore(dir);
  const initial = old.save({ ...fact, revision: 0 });
  old.close();
  let next = new MemoryStore(dir);
  next.applyLearning({ revision: 1, changes: [{ action: 'add', ids: [], fact: { ...fact, title: '图表', content: '我长期喜欢用图表展示销售趋势' }, reason: '本人长期偏好' }] });
  next.setAutoLearning({ revision: 2, autoLearning: false });
  const expected = next.snapshot();
  next.close();
  old = new ReleasedStore(dir);
  assert.deepEqual(old.snapshot().facts, expected.facts);
  assert.equal(old.snapshot().revision, 3);
  assert.equal(old.db.prepare('PRAGMA table_info(meta)').all().length, 3);
  old.remove({ revision: 3, id: initial.savedId });
  old.save({ revision: 4, ...fact, title: '语气', content: '我以后希望工作沟通都使用简体中文' });
  old.close();
  next = new MemoryStore(dir);
  assert.equal(next.snapshot().autoLearning, false);
  assert.equal(next.snapshot().facts.length, 2);
  next.close();
});

test('restoring a real format 1 snapshot can be upgraded again without losing original facts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-restored-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.sqlite');
  const snapshot = join(dir, 'format1-snapshot.sqlite');
  const old = new ReleasedStore(dir);
  const original = old.save({ revision: 0, ...fact });
  old.close();
  copyFileSync(file, snapshot);
  let next = new MemoryStore(dir);
  next.setAutoLearning({ revision: 1, autoLearning: false });
  next.close();
  copyFileSync(snapshot, file);
  next = new MemoryStore(dir);
  assert.deepEqual(next.snapshot().facts, original.facts);
  assert.equal(next.snapshot().revision, 1);
  assert.equal(next.snapshot().autoLearning, true);
  assert.equal(next.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  next.close();
});

test('rolled-back deletion and clearing erase auxiliary originals and reversible history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-old-forget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let next = new MemoryStore(dir);
  const learned = next.applyLearning({ revision: 0, changes: [{ action: 'add', ids: [], fact, reason: '本人偏好' }] });
  next.logLearningRequest('synthetic', { content: fact.content });
  next.close();
  let old = new ReleasedStore(dir);
  old.remove({ revision: 1, id: learned.facts[0].id });
  old.close();
  next = new MemoryStore(dir);
  assert.deepEqual(next.snapshot({ includeLearning: true }).learning, []);
  assert.equal(next.db.prepare('SELECT count(*) n FROM learning_requests').get().n, 0);
  next.applyLearning({ revision: 2, changes: [{ action: 'add', ids: [], fact, reason: '本人偏好' }] });
  next.applyLearning({ revision: 3, changes: [{ action: 'delete', ids: [next.snapshot().facts[0].id], reason: '本人要求删除' }] });
  assert.equal(next.snapshot({ includeLearning: true }).learning.length, 2);
  next.close();
  old = new ReleasedStore(dir);
  old.clear({ revision: 4, confirmed: true });
  old.close();
  next = new MemoryStore(dir);
  assert.deepEqual(next.snapshot({ includeLearning: true }).learning, []);
  next.close();
});
