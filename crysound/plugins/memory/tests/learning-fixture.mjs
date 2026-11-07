/** Seed an empty dedicated synthetic test database; never reset an existing fact or history. */
import { MemoryStore } from '../store.mjs';

if (!process.argv[2]) throw new Error('Supply the dedicated synthetic memory directory.');
const store = new MemoryStore(process.argv[2]);
try {
  const current = store.snapshot({ includeLearning: true });
  if (current.facts.length || current.learning.length) throw new Error('Fixture must be empty; existing data will not be cleared.');
  const revision = () => store.snapshot().revision;
  const fact = { kind: 'preference', title: '周报格式', content: '周报先写结论，再列风险和行动。' };
  const a = store.applyLearning({ revision: revision(), changes: [
    { action: 'add', ids: [], fact, reason: '首次表达稳定偏好' },
  ] }).facts[0].id;
  const b = store.save({ revision: revision(), kind: 'preference', title: '清单偏好', content: '长期喜欢简洁的编号清单。' }).savedId;
  store.applyLearning({ revision: revision(), changes: [
    { action: 'update', ids: [a], fact: { ...fact, content: '周报先给结论，行动项写清负责人。' }, reason: '本人补充汇报偏好' },
  ] });
  store.applyLearning({ revision: revision(), changes: [
    { action: 'merge', ids: [a, b], fact: { ...fact, content: '周报先给结论，再用编号清单列风险、行动和负责人。' }, reason: '合并重复的汇报偏好' },
  ] });
  const c = store.save({ revision: revision(), kind: 'project', title: '长期项目', content: '负责合成测试项目的长期规划。' }).savedId;
  store.applyLearning({ revision: revision(), changes: [{ action: 'delete', ids: [c], reason: '项目背景已不再有效' }] });
  console.log(JSON.stringify({ syntheticFacts: store.snapshot().facts.length, learningRecords: store.snapshot({ includeLearning: true }).learning.length }));
} finally { store.close(); }
