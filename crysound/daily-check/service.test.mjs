import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createDailyCheck, createDailyCheckHandler } from './service.mjs';
import { createCollector } from './collect.mjs';
import { createSummarizer, createContainerReader } from './container.mjs';
import { deliverDailyReport } from '../feishu/native/daily-host.mjs';

const alice = { unionId: 'a', slug: 'alice' }, bob = { unionId: 'b', slug: 'bob' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-09T09:00:00+08:00'), connection = true, available = true, items = [], reads = 0, summaries = 0, readError = false, gate;
  const options = { directory, users: () => [alice, bob], connected: () => connection, available: () => available, now: () => clock,
    collect: async () => { reads++; if (gate) await gate; if (readError) throw new Error('Do not leak private upstream errors'); return items; },
    summarize: async () => { summaries++; return { text: '请查看今日安排', model: 'test-model' }; } };
  let service = createDailyCheck(options);
  return { get service() { return service; }, get reads() { return reads; }, get summaries() { return summaries; },
    enable(user = alice, time = '09:00') { return service.configure(user, { enabled: true, time }); },
    items(value) { items = value; }, clock(value) { clock = Date.parse(value); }, connected(value) { connection = value; }, available(value) { available = value; },
    fail() { readError = true; }, gate(value) { gate = value; }, restart() { service = createDailyCheck(options); } };
}
test('默认关闭；未连接、未开放、周末和指定时间前均不读数据', async t => {
  const f = fixture(t);
  assert.equal(f.service.status(alice).enabled, false);
  await f.service.tick(); assert.equal(f.reads, 0);
  f.connected(false); assert.throws(() => f.enable(), /连接/);
  f.connected(true); f.available(false); assert.throws(() => f.enable(), /开放/);
  f.available(true); f.enable(); f.connected(false); await f.service.tick(); assert.equal(f.reads, 0);
  f.connected(true); f.clock('2026-11-08T10:00:00+08:00'); await f.service.tick(); assert.equal(f.reads, 0);
  f.clock('2026-11-09T08:59:59+08:00'); await f.service.tick(); assert.equal(f.reads, 0);
  f.clock('2026-11-09T09:00:00+08:00'); await f.service.tick(); assert.equal(f.reads, 1);
  assert.equal(f.service.status(alice).records[0].outcome, 'quiet');
  assert.equal(f.summaries, 0); assert.deepEqual(f.service.pending(alice), []);
});
test('北京时间可改；并发、重启、失败和手动检查都不会一天重复调用', async t => {
  const f = fixture(t); f.enable(alice, '10:15');
  await f.service.tick(); assert.equal(f.reads, 0);
  f.clock('2026-11-09T10:15:00+08:00'); f.fail();
  await Promise.all([f.service.tick(), f.service.tick()]); assert.equal(f.reads, 1);
  f.restart(); await f.service.tick(); assert.equal(f.reads, 1);
  await assert.rejects(f.service.run(alice, true), /今天已经/);
  assert.equal(f.service.status(alice).records[0].outcome, 'failed');
  assert.ok(!JSON.stringify(f.service.status(alice)).includes('private'));
  f.clock('2026-11-10T10:15:00+08:00'); await f.service.tick(); assert.equal(f.reads, 2);
});
test('仅新的待处理事项生成摘要；记录、未读、已读和同事数据互相隔离', async t => {
  const f = fixture(t); f.enable(); f.items([{ id: 'task:1', text: '准备会议' }]);
  await f.service.tick(); assert.equal(f.summaries, 1);
  const [pending] = f.service.pending(alice); assert.ok(pending.sessionId); assert.equal(pending.facts[0].text, '准备会议');
  assert.deepEqual(f.service.pending(bob), []);
  f.service.delivered(bob, pending.id); assert.equal(f.service.pending(alice).length, 1);
  f.service.delivered(alice, pending.id); f.service.delivered(alice, pending.id);
  assert.equal(f.service.status(alice).records[0].unread, true);
  f.service.read(alice, pending.id); assert.equal(f.service.status(alice).records[0].unread, false);
  f.clock('2026-11-10T09:00:00+08:00'); await f.service.tick(); assert.equal(f.summaries, 1);
  assert.equal(f.service.status(alice).records[0].outcome, 'quiet');
  f.items([{ id: 'task:1', text: '会议延期' }]); f.clock('2026-11-11T09:00:00+08:00'); await f.service.tick(); assert.equal(f.summaries, 2);
});
test('检查过程中关闭、失去授权或退出试用，停止生成和投递提醒', async t => {
  for (const change of ['off', 'connection', 'pilot']) {
    const f = fixture(t); f.enable(); f.items([{ id: 't', text: '待办' }]);
    let release; f.gate(new Promise(resolve => { release = resolve; }));
    const run = f.service.run(alice);
    if (change === 'off') f.service.configure(alice, { enabled: false, time: '09:00' });
    if (change === 'connection') f.connected(false);
    if (change === 'pilot') f.available(false);
    release(); await run;
    assert.equal(f.summaries, 0); assert.deepEqual(f.service.pending(alice), []);
  }
});
test('失败后即使重启也留记录不重试；关闭可取消已生成的待投递摘要', async t => {
  const f = fixture(t); f.enable(); f.items([{ id: 't', text: '待办' }]);
  await f.service.tick(); assert.equal(f.service.pending(alice).length, 1);
  f.available(false); f.service.configure(alice, { enabled: false, time: '09:00' });
  assert.deepEqual(f.service.pending(alice), []); assert.equal(f.service.status(alice).records[0].outcome, 'cancelled');
});
test('真实 HTTP 边界：身份、来源、请求方法和设置格式', async t => {
  const f = fixture(t);
  const handle = createDailyCheckHandler({ service: f.service, origin: 'https://app.test', identify: req => req.headers.cookie === 'alice' ? alice : null });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://local'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/_zp/daily-check/`;
  assert.equal((await fetch(base + 'status')).status, 401);
  assert.equal((await fetch(base + 'settings', { method: 'POST', headers: { cookie: 'alice' }, body: '{}' })).status, 403);
  const headers = { cookie: 'alice', origin: 'https://app.test' };
  assert.equal((await fetch(base + 'settings', { headers })).status, 405);
  assert.equal((await fetch(base + 'settings', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + 'settings', { method: 'POST', headers, body: '{"enabled":true,"time":"25:00"}' })).status, 400);
  assert.equal((await fetch(base + 'pending', { headers })).status, 404);
  const result = await fetch(base + 'settings', { method: 'POST', headers, body: '{"enabled":true,"time":"09:00"}' });
  assert.equal(result.status, 200); assert.equal((await result.json()).enabled, true);
  assert.equal((await fetch(base + 'run', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(base + 'run', { method: 'POST', headers, body: '{}' })).status, 409);
});

test('收集只用本人只读命令；筛掉已读、已完成、已结束日程；保留今天明天与未截止任务', async () => {
  const calls = [];
  const collect = createCollector(async (user, args) => {
    assert.equal(user, alice); assert.ok(args.includes('user'));
    calls.push(args); let data;
    if (args[1] === '+messages-search') data = { messages: [{ message_id: 'om_unread', content: '需要查看' }, { message_id: 'om_read', content: '已读' }], has_more: false };
    else if (args[1] === '+messages-read-status') data = { items: [{ message_id: 'om_unread', is_read: false }, { message_id: 'om_read', is_read: true }] };
    else if (args[1] === '+agenda') data = [
      { event_id: 'today', summary: '今天会议', start_time: { datetime: '2026-11-09T10:00:00+08:00' }, end_time: { datetime: '2026-11-09T11:00:00+08:00' } },
      { event_id: 'tomorrow', summary: '明天会议', start_time: { datetime: '2026-11-10T10:00:00+08:00' }, end_time: { datetime: '2026-11-10T11:00:00+08:00' } },
      { event_id: 'ended', summary: '已结束', start_time: { datetime: '2026-11-09T07:00:00+08:00' }, end_time: { datetime: '2026-11-09T08:00:00+08:00' } },
    ];
    else data = { items: [{ guid: 'pending', summary: '需处理', completed: false }, { guid: 'done', summary: '已完成', completed: true }], has_more: false };
    return { ok: true, identity: 'user', data };
  });
  const result = await collect(alice, { date: '2026-11-09' }, Date.parse('2026-11-09T09:00:00+08:00'));
  assert.deepEqual(result.map(item => item.id), ['mention:om_unread', 'event:today:2026-11-09T10:00:00+08:00', 'event:tomorrow:2026-11-10T10:00:00+08:00', 'task:pending']);
  assert.ok(calls[3].includes('--complete=false')); assert.ok(calls[0].includes('--is-at-me'));
});
test('空数据正常静默；截断、未知已读状态和缺失明细不能假装没新事', async () => {
  const empty = createCollector(async (_u, args) => ({ ok: true, identity: 'user', data: args[1] === '+messages-search' ? { messages: null } : args[1] === '+agenda' ? null : { items: null } }));
  assert.deepEqual(await empty(alice, { date: '2026-11-09' }, 0), []);
  for (const data of [{ messages: [], has_more: true }, { message_ids: ['om_x'] }, { messages: [], notice: 'restricted' }]) {
    await assert.rejects(createCollector(async () => ({ ok: true, identity: 'user', data }))(alice, {}, 0));
  }
  await assert.rejects(createCollector(async (_u, args) => ({ ok: true, identity: 'user', data: args[1] === '+messages-search' ? { messages: [{ message_id: 'om_x' }] } : { items: [], invalid_message_ids: ['om_x'] } }))(alice, {}, 0));
});
test('摘要模型没有工具或发消息权限；用量归本人且不暴露令牌', async () => {
  let request;
  const summarize = createSummarizer({ baseUrl: 'https://model.test/v1', model: 'test-model', keyFor: user => { assert.equal(user, alice); return 'test-only-key'; }, fetcher: async (url, init) => {
    request = { url, init }; return Response.json({ choices: [{ message: { content: '简短提醒' } }] });
  } });
  const result = await summarize(alice, [{ id: 't', text: '待办' }], { date: '2026-11-09' });
  assert.equal(String(request.url), 'https://model.test/v1/chat/completions');
  const body = JSON.parse(request.init.body); assert.equal(body.tools, undefined); assert.equal(body.stream, false);
  assert.ok(body.messages[1].content.includes('2026-11-09'));
  assert.deepEqual(result, { text: '简短提醒', model: 'test-model' }); assert.ok(!JSON.stringify(result).includes('key'));
});
test('Host 在确认持久化后才完成投递，确认丢失重投不重复添加消息', async () => {
  const events = []; let flushed = 0;
  const session = { append(type, data) { events.push({ type: 'event', event: { type, data, seq: events.length } }); } };
  const ctx = { sessions: { get: () => session, flush: async () => { flushed++; return true; } }, sessionController: {
    events: async () => ({ records: events, hasMore: false }), rename: async () => {},
  } };
  const record = { id: 'report-1', sessionId: 'session-1', date: '2026-11-09', at: 1, report: { text: '提醒', model: 'm' } };
  await deliverDailyReport(ctx, record, new AbortController().signal);
  await deliverDailyReport(ctx, record, new AbortController().signal);
  assert.equal(events.length, 1); assert.equal(flushed, 2);
  ctx.sessions.flush = async () => false;
  await assert.rejects(deliverDailyReport(ctx, record, new AbortController().signal), /persistence/);
});
test('容器读取使用独立 socket、固定用户和 argv；非零退出与截断结果不能冒充成功', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-docker-'));
  const socketPath = path.join(directory, 'docker.sock');
  let exitCode = 0, truncated = false, command, started = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.url.endsWith('/exec')) { command = body; res.end(JSON.stringify({ Id: 'fixed-exec' })); }
    else if (req.url.endsWith('/start')) {
      const content = Buffer.from('{"ok":true,"identity":"user","data":{"items":["会议 🐦"]}}');
      const split = content.indexOf(Buffer.from('会')) + 1;
      const frame = payload => {
        const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
      };
      res.end(Buffer.concat([frame(content.subarray(0, split)), frame(content.subarray(split)), ...(truncated ? [Buffer.from([1])] : [])]));
    } else res.end(JSON.stringify({ ExitCode: exitCode, Running: false }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  server.listen(socketPath); await once(server, 'listening');
  const read = createContainerReader({ ensureRunning: async slug => { assert.equal(slug, 'alice'); started++; }, socketPath });
  const args = ['task', '+get-my-tasks', '--complete=false', '--as', 'user'];
  assert.deepEqual((await read(alice, args)).data.items, ['会议 🐦']);
  assert.equal(command.User, '1001:1001'); assert.deepEqual(command.Cmd, ['/usr/local/bin/lark-cli', ...args]);
  assert.ok(command.Env.includes('TZ=Asia/Shanghai')); assert.equal(started, 1);
  exitCode = 1; await assert.rejects(read(alice, args), /failed/);
  exitCode = 0; truncated = true; await assert.rejects(read(alice, args), /Truncated/);
  await assert.rejects(read({ ...alice, slug: '../bob' }, args), /Invalid user/);
});
test('投递前再次核实已取消时，不追加消息也不确认成功', async () => {
  let appended = 0, flushed = 0;
  const ctx = { sessions: { get: () => ({ append() { appended++; } }), flush: async () => { flushed++; return true; } },
    sessionController: { events: async () => ({ records: [], hasMore: false }) } };
  const record = { id: 'cancelled', sessionId: 'own-session', report: {} };
  assert.equal(await deliverDailyReport(ctx, record, new AbortController().signal, async () => false), false);
  assert.equal(appended, 0); assert.equal(flushed, 0);
});
