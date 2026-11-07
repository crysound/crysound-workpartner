/** First-run paired evidence through an approved, capped entry; every case gets a new directory. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, existsSync, globSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hard, datasetHash } from './score-stress.mjs';
const exec = promisify(execFile);
const [entry, hostRoot, containerRoot, output, originalResult] = process.argv.slice(2).map(value => resolve(value));
if (!entry || !hostRoot || !containerRoot || !output || !originalResult || !containerRoot.startsWith('/data/issue-100-stress-')) throw new Error('Explicit approved entry, isolated host/container roots, output and original result required.');
mkdirSync(output, { recursive: true });
const previous = JSON.parse(readFileSync(originalResult));
const filename = join(output, 'evaluation.json');
const evaluation = existsSync(filename) ? JSON.parse(readFileSync(filename)) : {
  datasetHash, sourceCommit: process.env.MEMORY_SOURCE_COMMIT, originalDatasetHash: previous.datasetHash,
  regression: previous.regression, hard: [],
};
if (evaluation.datasetHash !== datasetHash || evaluation.sourceCommit !== process.env.MEMORY_SOURCE_COMMIT) throw new Error('Frozen source or dataset changed');
const save = () => writeFileSync(filename, JSON.stringify(evaluation, null, 2) + '\n');
const entrySource = readFileSync(entry, 'utf8');
const shardCount = Number(process.env.MEMORY_SHARD_COUNT || 1);
const shardIndex = Number(process.env.MEMORY_SHARD_INDEX || 0);
if (!Number.isInteger(shardCount) || shardCount < 1 || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) throw new Error('Invalid fixed shard');
// Retain the original cap container, token handling, model patch and append-only budget ledger.
const status = async () => JSON.parse((await exec(entry, ['llm-status'])).stdout);
for (const [caseIndex, fixture] of hard.entries()) {
  if (caseIndex % shardCount !== shardIndex) continue;
  if (evaluation.hard.some(row => row.id === fixture.id)) continue;
  const caseHost = join(hostRoot, fixture.id), caseContainer = join(containerRoot, fixture.id);
  const caseOutput = join(output, fixture.id);
  const resuming = existsSync(caseHost);
  mkdirSync(caseOutput, { recursive: true });
  const script = join(caseOutput, 'entry.sh');
  writeFileSync(script, entrySource.replaceAll('/data/issue-100', caseContainer), { mode: 0o700 });
  if (!resuming && !process.env.MEMORY_VERIFY_ONLY) {
  mkdirSync(caseHost, { recursive: true });
  const source = new URL('../memory/', import.meta.url);
  cpSync(source, join(caseHost, 'plugin'), { recursive: true, filter: path => !path.includes('/node_modules') });
  mkdirSync(join(caseHost, 'plugin/node_modules'), { recursive: true });
  symlinkSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai', join(caseHost, 'plugin/node_modules/@deepseek-ai'));
  mkdirSync(join(caseHost, 'memory-evaluation'), { recursive: true });
  cpSync(new URL('./run-learning-host.mjs', import.meta.url), join(caseHost, 'memory-evaluation/run-learning-host.mjs'));
  for (const profile of ['i100h', 'i100learn']) mkdirSync(join(caseHost, 'home/profiles', profile), { recursive: true });
  writeFileSync(join(caseHost, 'home/profiles/i100h/cordis.patch.yml'), '- id: crysound-memory\n  name: "@crysound/memory"\n  config:\n    learningIdleMs: 3600000\n    learningDailyHour: 23\n');
  writeFileSync(join(caseHost, 'home/profiles/i100learn/package.json'), JSON.stringify({ name: 'dsh-profile-memory-evaluation', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  writeFileSync(join(caseHost, 'home/profiles/i100learn/cordis.yml'), '[]\n');
  writeFileSync(join(caseHost, 'home/profiles/i100learn/cordis.patch.yml'), '- insert:\n    - id: memory-evaluation-host\n      name: '+caseContainer+'/memory-evaluation/run-learning-host.mjs\n');
  }
  const run = (...args) => exec(script, args, { timeout: 360000, maxBuffer: 16 * 1024 * 1024 });
  const row = { id: fixture.id, status: 'error', baseline: [], candidate: [], beforeBudget: await status() };
  let persisted;
  if (resuming) {
    // A read-only host capture establishes the actual durable prefix, including any turn
    // completed after the outer driver died. Never infer completion from stdout files.
    const capturePath = join(caseHost, 'learning-result.json');
    if (existsSync(capturePath)) {
      const old = JSON.parse(readFileSync(capturePath));
      if (!old.readOnly) persisted = old; // Preserve the first real learning result.
    }
    if (!persisted) { await run('capture'); persisted = JSON.parse(readFileSync(capturePath)); }
    const events = persisted.sessions[0]?.events || [];
    const users = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user');
    const completed = events.filter(e => e.type === 'turn/end' && e.data.reason.kind === 'completed');
    const actual = users.map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    if (persisted.sessions.length !== 1 || users.length !== completed.length
      || actual.some((text, i) => text !== fixture.dialogue[i]?.content)) throw new Error('Unsafe partial prefix; inspect without repeating a turn');
    row.interruption = { reason: 'Outer driver ended between turns; actual persisted prefix verified before continuation.', completedMainTurns: completed.length, noMainTurnRepeated: true };
    process.stdout.write(JSON.stringify({ id: fixture.id, resumedCompletedTurns: completed.length })+'\n');
  }
  if (process.env.MEMORY_VERIFY_ONLY) {
    process.stdout.write(JSON.stringify({ id: fixture.id, pendingTurns: fixture.dialogue.length - (row.interruption?.completedMainTurns || 0), readOnly: true })+'\n');
    continue;
  }
  try {
    let sessionId = persisted?.sessions[0]?.session.id;
    for (const [index, message] of fixture.dialogue.entries()) {
      if (index < (row.interruption?.completedMainTurns || 0)) continue;
      const turn = await run(...(index ? ['continue', sessionId, message.content] : ['headless', message.content]));
      writeFileSync(join(caseOutput, 'turn-'+index+'.txt'), turn.stdout+'\n'+turn.stderr);
      const files = [...globSync('**/session.v*.jsonl.zstd', { cwd: join(caseHost, 'home/sessions') })];
      if (files.length !== 1) throw new Error('Expected exactly one real session');
      sessionId = basename(dirname(files[0]));
      process.stdout.write(JSON.stringify({ id: fixture.id, completedMainTurn: index+1 })+'\n');
    }
    row.baseline = persisted && !persisted.readOnly ? persisted.before.facts : JSON.parse((await run('db', 'select * from facts order by id')).stdout);
    let learningFailure;
    try { if (!persisted || persisted.readOnly) { const result = await run('learn'); writeFileSync(join(caseOutput, 'learning.txt'), result.stdout+'\n'+result.stderr); } }
    catch (error) { learningFailure = error; writeFileSync(join(caseOutput, 'learning.txt'), (error.stdout || '')+'\n'+(error.stderr || '')); }
    const raw = readFileSync(join(caseHost, 'learning-result.json'));
    writeFileSync(join(caseOutput, 'evidence.json'), raw);
    const evidence = JSON.parse(raw), events = evidence.sessions[0]?.events || [];
    const users = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user');
    const actual = users.map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    if (evidence.sessions.length !== 1 || JSON.stringify(actual) !== JSON.stringify(fixture.dialogue.map(m => m.content))) throw new Error('Actual personal messages differ from frozen fixture');
    const completed = events.filter(e => e.type === 'turn/end' && e.data.reason.kind === 'completed');
    if (completed.length !== fixture.dialogue.length) throw new Error('Main turns incomplete');
    const normalize = facts => [...facts].sort((a,b) => a.id.localeCompare(b.id));
    if (JSON.stringify(normalize(evidence.before.facts)) !== JSON.stringify(normalize(row.baseline))) throw new Error('Memory changed before learning');
    row.candidate = evidence.after.facts;
    row.modelRoutes = events.filter(e => e.type === 'assistant/message').map(e => e.data.message.source).filter(s => s?.model).map(({provider,model}) => ({provider,model}));
    row.mainTurns = completed.length; row.learningRequests = evidence.requests.length; row.learningChanges = evidence.after.learning;
    row.sessionEvidence = fixture.id+'/evidence.json'; row.evidenceHash = createHash('sha256').update(raw).digest('hex');
    row.status = learningFailure || evidence.learningError ? 'error' : 'ok';
    if (row.status === 'error') row.error = evidence.learningError || 'Real-host learning failed';
  } catch (error) { row.error = error.message; writeFileSync(join(caseOutput, 'error.txt'), (error.stdout || '')+'\n'+(error.stderr || '')+'\n'+error.message); }
  row.afterBudget = await status();
  evaluation.hard.push(row);
  evaluation.budget = { complete: row.afterBudget.usd_reserved_unreconciled === 0, costUsd: row.afterBudget.usd_used, calls: row.afterBudget.calls_used, ...row.afterBudget };
  save();
  process.stdout.write(JSON.stringify({ id: row.id, status: row.status, before: row.baseline.length, after: row.candidate.length, auxiliary: row.learningRequests, calls: evaluation.budget.calls, usd: evaluation.budget.costUsd, error: row.error })+'\n');
  if (row.afterBudget.state !== 'open') break;
}
