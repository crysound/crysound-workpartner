import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLearning, datasetHash, regression, hard, factHash } from './score-learning.mjs';
function fixture() {
  const evaluation = { datasetHash, budget: { complete: true, costUsd: 0.1, calls: 100 } };
  const ledger = { datasetHash, facts: [] };
  for (const [group, cases] of Object.entries({ regression, hard })) evaluation[group] = cases.map(item => ({
    id: item.id, status: 'ok', sessionEvidence: 'synthetic-test-only', modelRoutes: ['synthetic'], baseline: [], candidate: [],
  }));
  return { evaluation, ledger };
}
test('absent, incomplete, duplicate, over-budget or changed-set evidence cannot report a passing score', () => {
  const { evaluation, ledger } = fixture();
  assert.equal(scoreLearning(evaluation, ledger).complete, true);
  assert.equal(scoreLearning(evaluation, ledger).passed, false);
  for (const change of [
    value => value.hard.pop(), value => value.hard.push(value.hard[0]),
    value => value.hard[0].status = 'error', value => value.budget.costUsd = 5.01,
    value => value.budget.calls = 1501, value => value.datasetHash = 'modified',
    value => value.hard[0].candidate = [{ id: 'a', kind: 'identity', title: '岗位', content: '无依据' }],
  ]) {
    const data = structuredClone(evaluation); change(data);
    assert.equal(scoreLearning(data, ledger).complete, false);
  }
});
test('concept hits still count, but unsupported additions inside a positive fact fail the no-expansion gate', () => {
  const { evaluation, ledger } = fixture();
  const fact = { id: 'a', kind: 'preference', title: '报告', content: '喜欢先给结论，而且有领导岗位' };
  evaluation.regression[0].candidate = [fact];
  assert.equal(scoreLearning(evaluation, ledger).complete, false);
  ledger.facts.push({ group: 'regression', caseId: 'm01', variant: 'candidate', factId: 'a', hash: factHash(fact), reviewed: true,
    claims: [
      { text: '先给结论', status: 'supported', citations: [{ message: 0, quote: '先给结论' }] },
      { text: '有领导岗位', status: 'unsupported', reason: '本人未说过岗位' },
    ] });
  const result = scoreLearning(evaluation, ledger);
  assert.equal(result.complete, true);
  assert.equal(result.regression.candidate.extraction.hit, 1);
  assert.equal(result.regression.candidate.unsupported.count, 1);
  assert.equal(result.passed, false);
});
