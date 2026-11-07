import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../store.mjs';
import { collectLearning, validateLearning, MemoryLearner, requestLearning } from '../learning.mjs';
const text = '我一直喜欢工作报告先给结论';
const fact = { kind: 'preference', title: '工作报告', content: text };
const config = { learningProvider: 'magpie', learningModel: 'deepseek/deepseek-flash', learningTimeoutMs: 1000,
  learningIdleMs: 900000, learningRetryMs: 900000, learningInputBytes: 24000, learningOutputTokens: 1200, learningDailyHour: 2, learningTimeZone: 'Asia/Shanghai', learningDailyCalls: 2 };
function session(messages, time = Date.now() + 100) {
  const events = messages.flatMap((content, i) => [
    { type: 'user/message', seq: i * 2, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text: content }] } },
    { type: 'turn/end', seq: i * 2 + 1, time, data: { turn: i + 1, reason: { kind: 'completed' } } },
  ]);
  return { session: { id: 'synthetic', createdAt: time }, inheritedEventCount: 0, events };
}
function proposal(message, extra = {}) {
  return { changes: [{ action: 'add', ids: [], messageSeq: message.seq, quote: message.text, fact: { ...fact, content: message.text }, reason: '本人长期偏好', ...extra }] };
}
function fixture(t, data = session([text]), request) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-learner-'));
  const store = new MemoryStore(directory);
  store.finishDaily(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format());
  let reads = 0, calls = 0;
  const ctx = { sessionQuery: { async listSessions() { reads++; return [{ header: data.session }]; }, async readSession() { reads++; return data; } } };
  const learner = new MemoryLearner(ctx, store, config, async (...args) => {
    calls++;
    return request ? request(...args) : proposal(args[3].messages[0]);
  });
  t.after(() => { learner.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, learner, data, reads: () => reads, calls: () => calls, ctx, directory };
}

test('only completed personal turns supply exact first-person evidence; references and stop requests are excluded', () => {
  const data = session([text, '引用：“我一直喜欢所有报告都用英文”。请帮我翻译。', '这次别记，先回答问题。', '我以后喜欢报告包含内部预测数字']);
  assert.deepEqual(collectLearning(data).messages, [{ seq: 0, text }]);
  assert.equal(collectLearning(data, { throughSeq: 1 }).messages.length, 0);
  assert.equal(collectLearning(data, { throughSeq: 5 }).messages.length, 0);
  assert.equal(collectLearning({ ...data, session: { origin: 'subagent' } }), null);
  assert.equal(collectLearning({ ...session([text]), inheritedEventCount: 2 }), null);
  const tool = session([text]); tool.events[0].data.source.kind = 'tool';
  assert.equal(collectLearning(tool).count, 0);
  const attachment = session([text]); attachment.events[0].data.content.push({ type: 'image', url: 'synthetic' });
  assert.equal(collectLearning(attachment).messages.length, 0);
  assert.equal(collectLearning({ ...session([text]), events: session([text]).events.slice(0, 1) }), null);
});

test('proposal checking rejects forged sources, short evidence, expansion, invented titles and unsupported deletion', t => {
  const { store } = fixture(t);
  const batch = collectLearning(session([text]));
  const valid = proposal(batch.messages[0]);
  assert.equal(validateLearning(valid, batch, store.snapshot()).length, 1);
  for (const extra of [
    { messageSeq: 999 }, { quote: '先给结论' },
    { fact: { ...fact, content: text + '，而且从来不喜欢表格' } },
    { fact: { ...fact, title: '领导岗位' } }, { action: 'delete', ids: [] },
    { fact: { ...fact, content: '密码：不能保存' } },
  ]) assert.throws(() => validateLearning(proposal(batch.messages[0], extra), batch, store.snapshot()));
});

test('idle learning commits facts, history, receipt and cursor together; restart and repeated ticks do not repeat requests', async t => {
  const f = fixture(t);
  await f.learner.tick(f.data.events[0].time + 60000);
  assert.equal(f.calls(), 0);
  await f.learner.tick(f.data.events[0].time + 1000000);
  assert.equal(f.calls(), 1);
  assert.equal(f.store.snapshot().facts[0].content, text);
  assert.equal(f.store.learningState('synthetic').throughSeq, 1);
  assert.equal(f.store.snapshot({ includeLearning: true }).learning.length, 1);
  assert.equal(f.store.learningReceipts()[0].notice, true);
  const other = new MemoryStore(f.directory);
  try {
    const restarted = new MemoryLearner(f.ctx, other, config, () => { throw new Error('must not call'); });
    await restarted.tick(Date.now() + 2000000);
    restarted.close();
  } finally { other.close(); }
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.calls(), 1);
});

test('disabled learning never enumerates or reads conversations, nor calls a model', async t => {
  const f = fixture(t);
  f.store.setAutoLearning({ autoLearning: false, revision: 0 });
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.reads(), 0); assert.equal(f.calls(), 0);
});

test('zero personal turns and excluded text advance the cursor without model calls', async t => {
  const f = fixture(t, session(['请帮我总结这次临时会议。']));
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.calls(), 0);
  assert.equal(f.store.learningState('synthetic').throughSeq, 1);
  f.data.events[0].data.source.kind = 'schedule';
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.calls(), 0);
});

test('model failure and concurrent revision changes never advance the cursor or leave partial writes', async t => {
  const failure = fixture(t, session([text]), () => { throw new Error('temporary model failure'); });
  await assert.rejects(failure.learner.tick(Date.now() + 2000000), /temporary/);
  assert.equal(failure.store.learningState('synthetic').throughSeq, undefined);
  assert.deepEqual(failure.store.snapshot().facts, []);
  let racing;
  racing = fixture(t, session([text]), (_ctx, _store, _config, batch) => {
    racing.store.setAutoLearning({ autoLearning: false, revision: 0 });
    return proposal(batch.messages[0]);
  });
  await assert.rejects(racing.learner.tick(Date.now() + 2000000), /已变化/);
  assert.equal(racing.store.learningState('synthetic').throughSeq, undefined);
  assert.deepEqual(racing.store.snapshot().facts, []);
});

test('new user input or disposal aborts a pending request and keeps its source unprocessed', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, session([text]), async (_ctx, _store, _config, batch, _current, signal) => {
    started(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return proposal(batch.messages[0]);
  });
  const pending = f.learner.tick(Date.now() + 2000000);
  await ready;
  f.learner.status({ agent: { session: { id: 'synthetic' } }, status: 'running' });
  release(); await assert.rejects(pending);
  assert.deepEqual(f.store.snapshot().facts, []);
  assert.equal(f.store.learningState('synthetic').throughSeq, undefined);
});

test('cross-process lease blocks duplicate work; expired leases recover after a crash', async t => {
  const f = fixture(t);
  assert.equal(f.store.acquireLease('other-host', 5000), true);
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.calls(), 0);
  f.store.db.exec('UPDATE learning_lock SET untilTime=0');
  await f.learner.tick(Date.now() + 2000000);
  assert.equal(f.calls(), 1);
});

test('daily catch-up can process pending turns before idle timeout without repeating processed turns', async t => {
  const day = Date.parse('2026-11-09T18:05:00Z'); // 02:05 China
  const f = fixture(t, session([text], day - 60000));
  f.store.db.prepare('UPDATE learning_settings SET startedAt=0').run();
  f.store.db.prepare('INSERT INTO learning_cursors VALUES (?,?,?,?)').run('synthetic', -1, day - 86400000, 0);
  await f.learner.tick(day);
  assert.equal(f.calls(), 1);
  await f.learner.tick(day);
  assert.equal(f.calls(), 1);
});

test('auxiliary call uses exact logged host input, no tools, independent route, terminal check and persistent budget', async t => {
  const f = fixture(t);
  let options;
  const ctx = { llm: { async prepareCall(route) { return { config: route, async *stream(input) {
    options = input;
    yield { type: 'text-delta', text: '{"changes":[]}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } } };
  const batch = collectLearning(f.data);
  assert.deepEqual(await requestLearning(ctx, f.store, config, batch, f.store.snapshot(), new AbortController().signal), { changes: [] });
  assert.equal(options.purpose, 'crysound-memory-learning'); assert.equal(options.tools, undefined);
  const request = JSON.parse(f.store.db.prepare('SELECT payload FROM learning_requests').get().payload);
  assert.deepEqual(request.messages, options.messages); assert.equal(request.system, options.system);
  await requestLearning(ctx, f.store, config, batch, f.store.snapshot(), new AbortController().signal);
  await assert.rejects(requestLearning(ctx, f.store, config, batch, f.store.snapshot(), new AbortController().signal), /上限/);
});

test('later corrections cannot reintroduce earlier preferences, even if the older turn was missed', () => {
  const snapshot = session(['我一直喜欢报告用英文', '更正一下，我以后所有工作报告都使用简体中文']);
  const batch = collectLearning(snapshot);
  assert.deepEqual(batch.messages.map(message => message.text), ['更正一下，我以后所有工作报告都使用简体中文']);
  assert.equal(batch.count, 2);
  assert.equal(batch.throughSeq, 3);
});

test('a failing session backs off without starving another session or advancing its failed cursor', async t => {
  const secondText = '我一直喜欢工作报告明确写出样本量';
  const f = fixture(t, session([text]), (_ctx, _store, _config, batch) => {
    if (batch.messages[0].text === text) throw new Error('first session failed');
    return proposal(batch.messages[0]);
  });
  const second = session([secondText]); second.session.id = 'second';
  f.ctx.sessionQuery.listSessions = async () => [{ header: f.data.session }, { header: second.session }];
  f.ctx.sessionQuery.readSession = async id => id === 'second' ? second : f.data;
  const now = Date.now() + 2000000;
  await assert.rejects(f.learner.tick(now), /first session failed/u);
  assert.equal(f.calls(), 2);
  assert.equal(f.store.snapshot().facts[0].content, secondText);
  assert.equal(f.store.learningState('synthetic').throughSeq, undefined);
  assert.equal(f.store.learningState('second').throughSeq, 1);
  await f.learner.tick(now);
  assert.equal(f.calls(), 2);
});

test('the disabled scheduler still erases thirty-day auxiliary originals without reading conversations', async t => {
  const f = fixture(t);
  f.store.setAutoLearning({ revision: 0, autoLearning: false });
  f.store.logLearningRequest('expired', { text: '只有合成数据' });
  f.store.db.prepare('UPDATE learning_requests SET createdAt=?').run(new Date(Date.now() - 31 * 86400000).toISOString());
  await f.learner.tick();
  assert.equal(f.reads(), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM learning_requests').get().n, 0);
});

test('switching off while a session read is pending prevents dispatch of any new model request', async t => {
  const f = fixture(t);
  let started, release, reads = 0;
  const reading = new Promise(resolve => { started = resolve; });
  f.ctx.sessionQuery.readSession = async () => {
    if (reads++ === 0) { started(); await new Promise(resolve => { release = resolve; }); }
    return f.data;
  };
  const pending = f.learner.tick(Date.now() + 2000000);
  await reading;
  f.store.setAutoLearning({ revision: 0, autoLearning: false });
  release();
  await assert.rejects(pending, /已变化/u);
  assert.equal(f.calls(), 0);
  assert.equal(f.store.learningState('synthetic').throughSeq, undefined);
});

test('switching off during route preparation prevents streaming or logging an auxiliary request', async t => {
  const f = fixture(t);
  let streamed = false;
  const current = f.store.snapshot();
  const ctx = { llm: { async prepareCall(route) {
    f.store.setAutoLearning({ revision: current.revision, autoLearning: false });
    return { config: route, async *stream() { streamed = true; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  } } };
  await assert.rejects(requestLearning(ctx, f.store, config, collectLearning(f.data), current, new AbortController().signal), /已变化/u);
  assert.equal(streamed, false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM learning_requests').get().n, 0);
});
