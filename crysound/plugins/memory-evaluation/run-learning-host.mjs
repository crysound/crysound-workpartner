/** Test-only one-shot dsh profile plugin. Never included in the memory release or production profile. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'memory-learning-evaluation-host';
export const inject = ['sessionQuery', 'llm'];
/** Run the actual learner against synthetic persisted sessions through the host gateway, then request clean exit. */
export function apply(ctx) {
  const exit = ctx.get('appExit');
  const ready = ctx.get('appReady');
  if (!exit || !ready || !process.env.MEMORY_EVAL_PLUGIN || !process.env.MEMORY_EVAL_OUTPUT) throw new Error('Evaluation requires an isolated dsh profile and explicit source/output.');
  ctx.effect(() => ready.onReady(() => {
    void run(ctx).then(() => exit(0)).catch(error => { process.stderr.write(error.message + '\n'); exit(1); });
  }));
}
async function run(ctx) {
  const { MemoryStore } = await import(pathToFileURL(join(process.env.MEMORY_EVAL_PLUGIN, 'store.mjs')));
  const { MemoryLearner } = await import(pathToFileURL(join(process.env.MEMORY_EVAL_PLUGIN, 'learning.mjs')));
  // Only the idle interval is shortened; evidence selection, model, bounds and commit path are production code.
  const config = { learningProvider: 'magpie', learningModel: 'deepseek/deepseek-flash', learningIdleMs: 1,
    learningTimeoutMs: 60000, learningRetryMs: 900000, learningDailyHour: 2, learningTimeZone: 'Asia/Shanghai',
    learningDailyCalls: 20, learningInputBytes: 48000, learningOutputTokens: 1200 };
  const store = new MemoryStore(join(process.env.DSH_HOME, 'crysound-memory'));
  const learner = new MemoryLearner(ctx, store, config);
  try {
    const sessions = [];
    for (const record of await ctx.sessionQuery.listSessions()) sessions.push(await ctx.sessionQuery.readSession(record.header.id));
    const before = store.snapshot();
    let learningError;
    if (!process.env.MEMORY_EVAL_READ_ONLY) {
      try { await learner.tick(); }
      catch (error) { learningError = error; }
    }
    const after = store.snapshot({ includeLearning: true });
    const requests = store.db.prepare('SELECT * FROM learning_requests').all();
    writeFileSync(process.env.MEMORY_EVAL_OUTPUT, JSON.stringify({ config, before, after, sessions, requests,
      readOnly: Boolean(process.env.MEMORY_EVAL_READ_ONLY), learningError: learningError?.message }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ completed: !learningError, sessions: sessions.length, factsBefore: before.facts.length, factsAfter: after.facts.length, learningRequests: requests.length }) + '\n');
    if (learningError) throw learningError;
  } finally { learner.close(); store.close(); }
}
