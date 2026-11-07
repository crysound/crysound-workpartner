/** Diagnose the actual stored states without promoting a failed learning run to acceptance. */
import { readFileSync } from 'node:fs';
import { scoreLearning } from '../../score-learning.mjs';
const load=name=>JSON.parse(readFileSync(new URL(name,import.meta.url)));
const evaluation=load('./evaluation.json'),ledger=load('./ledger.json');
const failedCases=Object.entries(evaluation).flatMap(([group,rows])=>Array.isArray(rows)
  ? rows.filter(row=>row.status!=='ok').map(row=>({group,id:row.id,status:row.status,error:row.error})) : []);
// A diagnostic includes every actual before/after fact, even when the background operation failed.
// Status substitution applies only to this in-memory metric inspection. Formal scoring keeps original statuses.
const storedStates=structuredClone(evaluation);
for(const group of ['regression','hard'])for(const row of storedStates[group])row.status='ok';
const inspected=scoreLearning(storedStates,ledger);
if(!inspected.complete)throw new Error('Stored-state evidence remains incomplete: '+inspected.reason);
console.log(JSON.stringify({formal:scoreLearning(evaluation,ledger),failedCases,
  diagnosticOnly:true,regression:inspected.regression,hard:inspected.hard},null,2));
