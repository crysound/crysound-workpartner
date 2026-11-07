import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLearning, datasetHash, regression, hard, factHash } from './score-stress.mjs';
const fixture = () => ({
  evaluation: { datasetHash, budget: { complete: true, costUsd: 0.2, calls: 400 },
    ...Object.fromEntries(Object.entries({ regression, hard }).map(([group, cases]) => [group, cases.map(({id}) => ({
      id, status: 'ok', sessionEvidence: 'synthetic-test-only', modelRoutes: ['synthetic'], baseline: [], candidate: [],
    }))])) }, ledger: { datasetHash, facts: [] },
});
function add(evaluation, ledger, caseId, content, supported = true) {
  const fact = { id: caseId, kind: 'preference', title: content.slice(0, 8), content };
  evaluation.hard.find(row => row.id === caseId).candidate.push(fact);
  ledger.facts.push({ group: 'hard', caseId, variant: 'candidate', factId: fact.id, hash: factHash(fact), reviewed: true,
    claims: [{ text: content, status: supported ? 'supported' : 'unsupported', ...(supported
      ? { citations: [{ message: 0, quote: content }] } : { reason: 'Forwarded material is not a personal preference.' }) }] });
}
test('independent pressure scoring retains the ten-point and no-increase gates', () => {
  const { evaluation, ledger } = fixture();
  const statement = hard[0].dialogue[0].content.split('\n')[0];
  add(evaluation, ledger, 's01', statement);
  assert.equal(scoreLearning(evaluation, ledger).passed, false); // 2/29, below ten points.
  const s02 = hard[1].dialogue[1].content.split('\n')[0];
  const fact = { id: 's02', kind: 'preference', title: '渠道销售', content: s02 };
  evaluation.hard[1].candidate.push(fact);
  ledger.facts.push({ group: 'hard', caseId: 's02', variant: 'candidate', factId: fact.id, hash: factHash(fact), reviewed: true,
    claims: [{ text: s02, status: 'supported', citations: [{ message: 1, quote: s02 }] }] });
  assert.equal(scoreLearning(evaluation, ledger).passed, true); // 4/29, above ten points.
  add(evaluation, ledger, 's13', '我长期负责财务分析', false);
  assert.equal(scoreLearning(evaluation, ledger).passed, false);
  assert.equal(scoreLearning(evaluation, ledger).hard.candidate.falseMemory.hit, 1);
});
test('frozen first-run evidence cannot pass with missing cases, errors, changed data or absent review', () => {
  const { evaluation, ledger } = fixture();
  for (const mutate of [e => e.hard.pop(), e => e.hard.push(e.hard[0]), e => e.hard[0].status = 'error',
    e => e.datasetHash = 'changed', e => e.budget.calls = 1501, e => e.budget.complete = false,
    e => e.hard[0].candidate.push({ id: 'unreviewed', content: '我长期负责声学实验室设备交付' })]) {
    const next = structuredClone(evaluation); mutate(next);
    assert.equal(scoreLearning(next, ledger).complete, false);
  }
});
