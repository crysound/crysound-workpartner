import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MemoryStore } from '../store.mjs';
import { registerPanel, trustedRequest } from '../panel.mjs';

function fixture(t, limits) {
  const dir = mkdtempSync(join(tmpdir(), 'crysound-memory-'));
  const store = new MemoryStore(dir, limits);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
const report = { kind: 'preference', title: '报告格式', content: '报告使用 Markdown 表格' };
const coffee = { kind: 'preference', title: '咖啡偏好', content: 'COFFEE_TEST_ONLY_LATTE' };

test('new hosts recall saved facts; deletion preserves others and removes raw bytes', t => {
  const { store, dir } = fixture(t);
  store.save({ ...report, revision: 0 });
  const before = store.save({ ...coffee, revision: 1 });
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.deepEqual(other.snapshot(), before);
  const id = before.facts.find(x => x.title === coffee.title).id;
  store.remove({ id, revision: 2 });
  assert.deepEqual(other.snapshot().facts.map(x => x.content), [report.content]);
  assert.equal(readFileSync(join(dir, 'memory.sqlite')).includes(Buffer.from(coffee.content)), false);
  assert.deepEqual(readdirSync(dir), ['memory.sqlite']);
});

test('stale writers cannot overwrite facts or restore a deleted preference', t => {
  const { store, dir } = fixture(t);
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  const saved = store.save({ ...coffee, revision: 0 });
  assert.throws(() => other.save({ ...report, revision: 0 }), /记忆已变化/u);
  other.save({ ...report, revision: 1 });
  store.remove({ id: saved.facts[0].id, revision: 2 });
  assert.throws(() => other.save({ ...coffee, revision: 2 }), /记忆已变化/u);
  assert.deepEqual(store.snapshot().facts.map(x => x.content), [report.content]);
});

test('updates reuse the concept, capacity failures keep all previous facts', t => {
  const { store } = fixture(t, { maxMemories: 1 });
  store.save({ ...report, revision: 0 });
  const updated = store.save({ ...report, content: '报告先写结论', revision: 1 });
  assert.equal(updated.facts.length, 1);
  assert.throws(() => store.save({ ...coffee, revision: 2 }), /超出当前预算/u);
  assert.deepEqual(store.snapshot(), updated);
});

test('total recall stays within budget, including identifiers and revision', t => {
  const { store } = fixture(t, { recallChars: 512 });
  const first = store.save({ ...report, content: '甲'.repeat(240), revision: 0 });
  assert.ok(JSON.stringify(first).length <= 512);
  assert.throws(() => store.save({ ...coffee, content: '乙'.repeat(240), revision: 1 }), /超出当前预算/u);
  assert.deepEqual(store.snapshot(), first);
});

test('credential labels, common credential formats and invalid input are rejected at write time', t => {
  const { store } = fixture(t);
  for (const content of ['我的密码是 apple', 'password: apple', 'API key: abc', 'sk-example_secret_1234567890', '验证码1234', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => store.save({ ...report, content, revision: 0 }), /凭据/u);
  }
  assert.throws(() => store.save({ ...report, title: '\n', revision: 0 }));
  assert.throws(() => store.save({ ...report, kind: 'transient', revision: 0 }));
  assert.throws(() => store.remove({ id: '../outside', revision: 0 }));
  assert.deepEqual(store.snapshot(), { revision: 0, facts: [] });
});

test('independent personal data roots never share memory', t => {
  const one = fixture(t).store;
  const two = fixture(t).store;
  one.save({ ...coffee, revision: 0 });
  assert.equal(two.snapshot().facts.length, 0);
});

test('keyless replay of recorded model rounds preserves save, recall and both deletion paths', t => {
  const { store, dir } = fixture(t);
  const evidence = JSON.parse(readFileSync(new URL('../../memory-evaluation/trial-evidence.json', import.meta.url), 'utf8'));
  const ids = ['cc2259a0-d0aa-40e1-bbbf-abe887d94d51', 'b2944e78-e8f5-4a0e-91e2-f24a538f0cef', '7a9ae0ab-25fa-4e0c-9d45-310623799412', 'd3ac0f9a-b8e9-4ce9-a118-21afadbd73f5'];
  for (const id of ids) {
    // The recorded page confirmation happened between the third session and the restart.
    if (id === ids[3]) store.remove({ id: '82e09c2b58f388f268e314f8', revision: 4 });
    const session = evidence.sessions.find(s => s.session === 'session-' + id);
    assert.ok(session);
    const events = [...session.recall.map(x => ({ ...x, type: 'snapshot' })), ...session.memoryTools.map(x => ({ ...x, type: 'tool' }))].sort((a, b) => a.seq - b.seq);
    for (const event of events) {
      if (event.type === 'snapshot') assert.deepEqual(store.snapshot(), event.snapshot);
      else if (event.name === 'crysound_memory_save') store.save(event.arguments);
      else if (event.name === 'crysound_memory_forget') store.remove(event.arguments);
      else assert.equal(event.name, 'crysound_memory_list');
    }
  }
  const restarted = new MemoryStore(dir);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.deepEqual(restarted.snapshot().facts.map(f => f.title), ['工作方向']);
});

test('panel accepts configured public domains and refuses cross-site or rebound requests', () => {
  const startup = { trustedHosts: ['partner.example', 'exact.example:8080'] };
  const allowed = (headers) => trustedRequest({ headers }, startup, '172.22.0.3');
  assert.ok(allowed({ host: 'partner.example', origin: 'https://partner.example', 'sec-fetch-site': 'same-origin' }));
  assert.ok(allowed({ host: 'exact.example:8080', origin: 'https://exact.example:8080' }));
  assert.ok(allowed({ host: '172.22.0.3:3080' }));
  for (const headers of [
    { host: 'evil.example' }, { host: 'other.example', origin: 'https://other.example' },
    { host: 'partner.example', origin: 'https://evil.example' },
    { host: 'partner.example', origin: 'null' }, { host: 'partner.example', origin: 'https://partner.example/path' },
    { host: 'partner.example', 'sec-fetch-site': 'cross-site' },
    { host: 'partner.example', 'sec-fetch-site': 'same-site' }, { host: 'exact.example:8081' },
    { host: 'partner.example@evil.example' }, { host: 'partner.example/path' }, {},
  ]) assert.equal(allowed(headers), false, JSON.stringify(headers));
});

test('real HTTP panel reads and deletes with revision checks, method and content validation', async t => {
  const { store } = fixture(t);
  const data = store.save({ ...report, revision: 0 });
  const routes = new Map();
  const disposers = [];
  registerPanel({
    effect(fn) { disposers.push(fn()); },
    webStartup: { trustedHosts: [] },
    webServer: { host: '127.0.0.1', register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
  }, store);
  const server = createServer((req, res) => {
    for (const [path, handler] of routes) {
      if (req.url === path) { handler(req, res); return; }
    }
    res.writeHead(404); res.end();
  });
  t.after(async () => { disposers.forEach(fn => fn()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/crysound-memory/api/`;
  const get = await fetch(base + 'list');
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { ...data, limits: { maxMemories: 50, recallChars: 6000 } });
  assert.equal((await fetch(base + 'list', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + 'delete', { method: 'POST', body: '{}' })).status, 415);
  const post = body => fetch(base + 'delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(4097))).status, 413);
  assert.equal((await post(JSON.stringify({ id: data.facts[0].id, revision: 0 }))).status, 409);
  const removed = await post(JSON.stringify({ id: data.facts[0].id, revision: 1 }));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { revision: 2, facts: [], limits: { maxMemories: 50, recallChars: 6000 } });
  assert.equal(store.snapshot().facts.length, 0);
});
