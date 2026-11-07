/** Recheck published frozen-cohort audit and score; unmet acceptance remains a failing exit. */
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {hard,datasetHash,scoreLearning} from '../../score-stress.mjs';
const load = name => JSON.parse(readFileSync(new URL(name,import.meta.url)));
const evaluation = load('evaluation.json'), ledger = load('ledger.json'), audit = load('audit.json');
assert.equal(evaluation.datasetHash,datasetHash);
assert.equal(ledger.datasetHash,datasetHash);
assert.deepEqual(evaluation.hard.map(r=>r.id).sort(),hard.map(f=>f.id).sort());
assert.deepEqual(audit.map(r=>r.id).sort(),hard.map(f=>f.id).sort());
for(const fixture of hard){
  const row=evaluation.hard.find(r=>r.id===fixture.id), proof=audit.find(r=>r.id===fixture.id);
  assert.deepEqual(proof.personalMessages.map(m=>m.text),fixture.dialogue.map(m=>m.content));
  assert.equal(proof.mainCompletedTurns.length,fixture.dialogue.length);
  assert.deepEqual(proof.mainCompletedTurns.map(t=>t.turn),[1,2,3,4,5,6]);
  assert.equal(proof.evidenceHash,row.evidenceHash);
  assert.equal(proof.auxiliaryRequests,row.learningRequests);
  assert.equal(proof.readOnly,false);
  assert.equal(row.status,'ok');
}
const billing=load('billing-audit.json');
assert.equal(billing.matchedCalls,evaluation.budget.calls);
assert.equal(billing.requests.length,billing.matchedCalls);
assert.equal(new Set(billing.requests.map(r=>r.id)).size,billing.requests.length);
assert.ok(Math.abs(billing.requests.reduce((n,r)=>n+r.costUsd,0)-evaluation.budget.costUsd)<1e-9);
assert.equal(billing.usd_reserved_unreconciled,0);
const score=scoreLearning(evaluation,ledger);
assert.deepEqual(score,load('summary.json'));
process.stdout.write(JSON.stringify(score,null,2)+'\n');
if(!score.complete||!score.passed)process.exitCode=1;
