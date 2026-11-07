/** Frozen paired-memory scoring. Regex finds target concepts; an exhaustive claim ledger catches expansion. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const load = path => JSON.parse(readFileSync(path, 'utf8'));
export const regression = load(new URL('./dialogues.json', import.meta.url)).map(item => ({
  id: item.id, dialogue: item.dialogue, targets: item.label === '该记' ? [{ key: '1', pattern: item.expected.pattern }] : [], forbidden: [],
}));
export const hard = load(new URL('./hard-dialogues.json', import.meta.url));
export const datasetHash = createHash('sha256').update(JSON.stringify({ regression, hard })).digest('hex');
export const factHash = fact => createHash('sha256').update(JSON.stringify({ kind: fact.kind, title: fact.title, content: fact.content })).digest('hex');

/** Every actual stored fact needs a pinned, fully reviewed list of atomic claims. Missing evidence is incomplete. */
export function scoreLearning(evaluation, ledger) {
  const fail = reason => ({ complete: false, reason });
  if (evaluation.datasetHash !== datasetHash || ledger.datasetHash !== datasetHash) return fail('dataset changed');
  const budget = evaluation.budget;
  if (!budget?.complete || !Number.isFinite(budget.costUsd) || budget.costUsd < 0 || budget.costUsd > 5
    || !Number.isInteger(budget.calls) || budget.calls < 1 || budget.calls > 1500) return fail('budget evidence missing or exceeded');
  const result = {};
  for (const [group, fixtures] of Object.entries({ regression, hard })) {
    const rows = evaluation[group];
    if (!Array.isArray(rows) || rows.length !== fixtures.length || new Set(rows.map(row => row.id)).size !== fixtures.length) return fail('missing or duplicate cases');
    const metrics = {};
    for (const variant of ['baseline', 'candidate']) {
      let hit = 0, falseMemory = 0, unsupported = 0, claims = 0, oldValueAlerts = 0;
      for (const fixture of fixtures) {
        const row = rows.find(row => row.id === fixture.id);
        if (!row || row.status !== 'ok' || !row.sessionEvidence || !row.modelRoutes?.length || !Array.isArray(row[variant])) return fail('unfinished real-host case');
        const facts = row[variant];
        const seen = new Set();
        for (const fact of facts) {
          if (typeof fact.id !== 'string' || seen.has(fact.id) || typeof fact.content !== 'string') return fail('invalid facts');
          seen.add(fact.id);
          const entry = ledger.facts?.find(item => item.group === group && item.caseId === fixture.id && item.variant === variant && item.factId === fact.id);
          if (!entry || entry.hash !== factHash(fact) || entry.reviewed !== true || !entry.claims?.length) return fail('fact lacks exhaustive claim review');
          for (const claim of entry.claims) {
            if (typeof claim.text !== 'string' || !claim.text || !['supported', 'unsupported'].includes(claim.status)) return fail('invalid claim review');
            claims++;
            if (claim.status === 'unsupported') {
              if (!claim.reason) return fail('unsupported claim lacks reason');
              unsupported++;
            } else if (!claim.citations?.length || claim.citations.some(citation => {
              const source = fixture.dialogue[citation.message];
              return !source || typeof citation.quote !== 'string' || !citation.quote || !source.content.includes(citation.quote);
            })) return fail('claim lacks attributable evidence');
          }
        }
        if (!fixture.targets.length && facts.length) falseMemory++;
        const contents = facts.map(fact => fact.content);
        for (const target of fixture.targets) if (contents.some(content => new RegExp(target.pattern, 'u').test(content))) hit++;
        const flagged = facts.filter(fact => fixture.forbidden.some(pattern => new RegExp(pattern, 'u').test(fact.content)));
        if (flagged.length) {
          oldValueAlerts++;
          const reviews = flagged.map(fact => ledger.facts.find(item => item.group === group && item.caseId === fixture.id
            && item.variant === variant && item.factId === fact.id).obsoleteReview);
          if (reviews.some(review => !review || !['current', 'outdated'].includes(review.status) || !review.reason)) return fail('old-value alert lacks semantic review');
          if (reviews.some(review => review.status === 'outdated')) unsupported++;
        }
      }
      const targets = fixtures.reduce((total, fixture) => total + fixture.targets.length, 0);
      const negatives = fixtures.filter(fixture => fixture.targets.length === 0).length;
      metrics[variant] = { extraction: { hit, total: targets, rate: hit / targets }, falseMemory: { hit: falseMemory, total: negatives, rate: falseMemory / negatives }, unsupported: { count: unsupported, reviewedClaims: claims, oldValueAlerts } };
    }
    metrics.gainPoints = (metrics.candidate.extraction.rate - metrics.baseline.extraction.rate) * 100;
    result[group] = metrics;
  }
  const noIncrease = group => result[group].candidate.falseMemory.hit <= result[group].baseline.falseMemory.hit
    && result[group].candidate.unsupported.count <= result[group].baseline.unsupported.count;
  return { complete: true, datasetHash, budget, ...result,
    passed: result.regression.gainPoints >= -1e-9 && result.hard.gainPoints >= 10 - 1e-9 && noIncrease('regression') && noIncrease('hard') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = scoreLearning(load(process.argv[2]), load(process.argv[3]));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.complete || !result.passed) process.exitCode = 1;
}
