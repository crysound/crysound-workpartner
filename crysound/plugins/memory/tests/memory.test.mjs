import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, recallData } from '../store.mjs';
import { registerPanel, trustedRequest } from '../panel.mjs';

function fixture(t, limits) {
  const dir = mkdtempSync(join(tmpdir(), 'crysound-memory-'));
  const store = new MemoryStore(dir, limits);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
const report = { kind: 'preference', title: '报告格式', content: '报告使用 Markdown 表格' };
const coffee = { kind: 'preference', title: '咖啡偏好', content: 'COFFEE_TEST_ONLY_LATTE' };

// Save also returns the just-committed record id; snapshots contain persisted state only.
const withoutReceipt = ({ savedId, ...snapshot }) => snapshot;

test('new hosts recall saved facts; deletion preserves others and removes raw bytes', t => {
  const { store, dir } = fixture(t);
  store.save({ ...report, revision: 0 });
  const before = store.save({ ...coffee, revision: 1 });
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.deepEqual(other.snapshot(), withoutReceipt(before));
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
  const updated = store.save({ ...report, content: '报告先写结论', id: store.snapshot().facts[0].id, revision: 1 });
  assert.equal(updated.facts.length, 1);
  assert.throws(() => store.save({ ...coffee, revision: 2 }), /超出当前预算/u);
  assert.deepEqual(store.snapshot(), withoutReceipt(updated));
});

test('total recall stays within budget, including identifiers and revision', t => {
  const { store } = fixture(t, { recallChars: 512 });
  const first = store.save({ ...report, content: '甲'.repeat(240), revision: 0 });
  assert.ok(JSON.stringify(recallData(first)).length <= 512);
  assert.throws(() => store.save({ ...coffee, content: '乙'.repeat(240), revision: 1 }), /超出当前预算/u);
  assert.deepEqual(store.snapshot(), withoutReceipt(first));
});

test('credential labels, common credential formats and invalid input are rejected at write time', t => {
  const { store } = fixture(t);
  for (const content of ['我的密码是 apple', 'password: apple', 'API key: abc', 'sk-example_secret_1234567890', '验证码1234', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => store.save({ ...report, content, revision: 0 }), /凭据/u);
  }
  assert.throws(() => store.save({ ...report, title: '\n', revision: 0 }));
  assert.throws(() => store.save({ ...report, kind: 'transient', revision: 0 }));
  assert.throws(() => store.remove({ id: '../outside', revision: 0 }));
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(store.snapshot().facts, []);
});

test('independent personal data roots never share memory', t => {
  const one = fixture(t).store;
  const two = fixture(t).store;
  one.save({ ...coffee, revision: 0 });
  assert.equal(two.snapshot().facts.length, 0);
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
  assert.deepEqual(await get.json(), { ...withoutReceipt(data), limits: { maxMemories: 50, recallChars: 6000 } });
  assert.equal((await fetch(base + 'list', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + 'delete', { method: 'POST', body: '{}' })).status, 415);
  const post = body => fetch(base + 'delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(4097))).status, 413);
  assert.equal((await post(JSON.stringify({ id: data.facts[0].id, revision: 0 }))).status, 409);
  const removed = await post(JSON.stringify({ id: data.facts[0].id, revision: 1 }));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ...store.snapshot(), limits: { maxMemories: 50, recallChars: 6000 } });
  assert.equal(store.snapshot().facts.length, 0);
  const action = (path, input) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const added = await (await action('save', { ...report, revision: 2 })).json();
  assert.equal(added.facts[0].source, 'manual');
  const edited = await (await action('save', { ...report, id: added.facts[0].id, content: '改用列表', revision: 3 })).json();
  assert.equal(edited.facts[0].source, 'edited');
  assert.equal(edited.facts[0].content, '改用列表');
  const rejected = await action('save', { ...report, content: '密码测试内容', revision: 4 });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.text()).includes('密码测试内容'), false);
  const off = await (await action('enabled', { revision: 4, enabled: false })).json();
  assert.equal(off.enabled, false);
  assert.equal(off.facts.length, 1);
  assert.equal((await action('clear', { revision: 5 })).status, 409);
  const cleared = await (await action('clear', { revision: 5, confirmed: true })).json();
  assert.equal(cleared.facts.length, 0);
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.autoLearning, true);
  const learningOff = await (await action('auto-learning', { revision: 6, autoLearning: false })).json();
  assert.equal(learningOff.autoLearning, false);
  assert.equal(learningOff.enabled, false);
  assert.equal((await action('auto-learning', { revision: 6, autoLearning: true })).status, 409);
  assert.equal((await action('auto-learning', { revision: 7, autoLearning: 'true' })).status, 409);
  assert.equal(store.snapshot().autoLearning, false);
});

test('learning defaults on, persists independently of recall, and rejects stale writers', t => {
  const { store, dir } = fixture(t);
  assert.equal(store.snapshot().autoLearning, true);
  const saved = store.save({ ...report, revision: 0 });
  const recalled = recallData(saved);
  const off = store.setAutoLearning({ autoLearning: false, revision: 1 });
  assert.equal(off.enabled, true);
  assert.deepEqual(off.facts, saved.facts);
  assert.deepEqual(recallData(off), { ...recalled, revision: 2 });
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.equal(other.snapshot().autoLearning, false);
  assert.throws(() => other.setAutoLearning({ autoLearning: true, revision: 1 }), /已变化/u);
  assert.throws(() => other.setAutoLearning({ autoLearning: 0, revision: 2 }), /开启或关闭自动学习/u);
  assert.equal(other.snapshot().revision, 2);
  store.setEnabled({ enabled: false, revision: 2 });
  assert.equal(other.snapshot().autoLearning, false);
  other.setEnabled({ enabled: true, revision: 3 });
  const restored = store.setAutoLearning({ autoLearning: true, revision: 4 });
  assert.equal(restored.autoLearning, true);
  assert.deepEqual(restored.facts, saved.facts);
});

test('released format 1 upgrades once without changing facts, revision, or the disabled recall switch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'crysound-memory-v1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'memory.sqlite'));
  const fact = { id: 'a'.repeat(24), ...report, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', source: 'manual' };
  try {
    db.exec(`CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
      INSERT INTO meta VALUES (1, 17, 0);
      CREATE TABLE facts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, source TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?)').run(fact.id, fact.kind, fact.title, fact.content, fact.createdAt, fact.updatedAt, fact.source);
  } finally { db.close(); }
  const first = new MemoryStore(dir);
  try {
    const upgraded = first.snapshot();
    assert.equal(upgraded.revision, 17);
    assert.equal(upgraded.enabled, false);
    assert.equal(upgraded.autoLearning, true);
    assert.deepEqual(upgraded.facts, [fact]);
    assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 2);
    first.setAutoLearning({ autoLearning: false, revision: 17 });
  } finally { first.close(); }
  const second = new MemoryStore(dir);
  try {
    assert.equal(second.snapshot().autoLearning, false);
    assert.equal(second.snapshot().enabled, false);
    assert.equal(second.snapshot().revision, 18);
    assert.deepEqual(second.snapshot().facts, [fact]);
    assert.equal(second.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { second.close(); }
});

test('random ids survive rename; creation and update metadata persist across hosts', t => {
  const { store, dir } = fixture(t);
  const saved = store.save({ ...report, revision: 0 });
  const first = saved.facts[0];
  const updated = store.save({ ...report, id: first.id, title: '汇报方式', content: '用要点列表', revision: 1 }, { source: 'edited', requireEnabled: false });
  assert.equal(updated.facts.length, 1);
  assert.equal(updated.facts[0].id, first.id);
  assert.equal(updated.facts[0].createdAt, first.createdAt);
  assert.equal(updated.facts[0].source, 'edited');
  assert.equal(recallData(updated).facts[0].updatedDate, updated.facts[0].updatedAt.slice(0, 10));
  assert.ok(!JSON.stringify(recallData(updated)).includes('createdAt'));
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.deepEqual(other.snapshot(), withoutReceipt(updated));
  const independent = fixture(t).store.save({ ...report, revision: 0 });
  assert.notEqual(independent.facts[0].id, first.id);
});

test('disabled memory persists, hides recall, rejects model save and retains editable facts', t => {
  const { store, dir } = fixture(t);
  store.save({ ...report, revision: 0 });
  const disabled = store.setEnabled({ enabled: false, revision: 1 });
  assert.deepEqual(recallData(disabled).facts, []);
  assert.equal(disabled.facts.length, 1);
  assert.throws(() => store.save({ ...coffee, revision: 2 }), /个人记忆已关闭/u);
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.equal(other.snapshot().enabled, false);
  const added = other.save({ ...coffee, revision: 2 }, { source: 'manual', requireEnabled: false });
  assert.equal(added.facts.find(f => f.title === coffee.title).source, 'manual');
  const enabled = store.setEnabled({ enabled: true, revision: 3 });
  assert.equal(recallData(enabled).facts.length, 2);
});

test('confirmed full-capacity merge and new fact commit together, failures roll everything back', t => {
  const { store } = fixture(t, { maxMemories: 2 });
  const a = store.save({ ...report, revision: 0 }).facts[0];
  const before = store.save({ ...coffee, revision: 1 });
  const b = before.facts.find(f => f.id !== a.id);
  assert.equal(before.usage.nearCapacity, true);
  const plan = { kind: 'project', title: '长期项目', content: '声学校准', revision: 2,
    removeIds: [b.id], updates: [{ ...report, id: a.id, content: '先给结论再用表格' }] };
  assert.throws(() => store.save(plan), /先让用户确认/u);
  assert.deepEqual(store.snapshot(), withoutReceipt(before));
  for (const broken of [
    { ...plan, content: '密码是不可以保存的' },
    { ...plan, updates: [{ ...report, id: 'a'.repeat(24) }] },
    { ...plan, removeIds: [b.id, b.id] },
    { ...plan, updates: [{ ...report, id: a.id, content: '密码' }] },
  ]) {
    assert.throws(() => store.save({ ...broken, confirmed: true }));
    assert.deepEqual(store.snapshot(), withoutReceipt(before));
  }
  const after = store.save({ ...plan, confirmed: true });
  assert.equal(after.revision, 3);
  assert.equal(after.facts.length, 2);
  assert.equal(after.facts.find(f => f.id === a.id).content, '先给结论再用表格');
  assert.ok(after.facts.some(f => f.title === '长期项目'));
  assert.ok(!after.facts.some(f => f.id === b.id));
});

test('over-budget multi-change rolls back removals, updates and new content', t => {
  const { store } = fixture(t, { recallChars: 512 });
  const before = store.save({ ...report, revision: 0 });
  assert.throws(() => store.save({ ...coffee, content: '新'.repeat(240), revision: 1, confirmed: true,
    updates: [{ ...report, id: before.facts[0].id, content: '长'.repeat(240) }] }), /预算/u);
  assert.deepEqual(store.snapshot(), withoutReceipt(before));
});

test('clear requires confirmation and removes all original bytes while preserving the switch', t => {
  const { store, dir } = fixture(t);
  store.save({ ...coffee, revision: 0 });
  store.save({ ...report, revision: 1 });
  assert.throws(() => store.clear({ revision: 2 }), /再次确认/u);
  store.setEnabled({ enabled: false, revision: 2 });
  assert.throws(() => store.clear({ revision: 2, confirmed: true }), /已变化/u);
  const cleared = store.clear({ revision: 3, confirmed: true });
  assert.equal(cleared.facts.length, 0);
  assert.equal(cleared.enabled, false);
  const bytes = readFileSync(join(dir, 'memory.sqlite'));
  for (const text of [coffee.title, coffee.content, report.title, report.content]) assert.equal(bytes.includes(Buffer.from(text)), false);
  assert.deepEqual(readdirSync(dir), ['memory.sqlite']);
});

test('identity and bank number formats are refused without echoing the rejected text', t => {
  const { store } = fixture(t);
  for (const number of ['11010519491231002X', '110105194912310021', '6222021234567890', '6222021234567890123']) {
    for (const field of ['title', 'content']) {
      assert.throws(() => store.save({ ...report, [field]: number, revision: 0 }), error => {
        assert.match(error.message, /身份证号或银行卡号/u);
        assert.equal(error.message.includes(number), false);
        return true;
      });
    }
  }
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.snapshot().facts.length, 0);
});

test('keyless replay of current recorded saves and rename keeps one fact per concept', t => {
  const { store } = fixture(t);
  const evidence = JSON.parse(readFileSync(new URL('../../memory-evaluation/personal-memory-evidence.json', import.meta.url), 'utf8'));
  const session = evidence.sessions.find(s => s.session === evidence.scenarios.autoUpdate);
  const ids = new Map();
  const normalize = facts => facts.map(({ id, kind, title, content }) => ({ id, kind, title, content })).sort((a, b) => a.id.localeCompare(b.id));
  for (const call of session.memoryTools) {
    const args = { ...call.arguments };
    if (args.id) args.id = ids.get(args.id);
    const actual = call.name === 'crysound_memory_save' ? store.save(args) : store.snapshot();
    const recorded = JSON.parse(session.memoryResults.find(r => r.callId === call.callId).text);
    assert.equal(recorded.ok, true);
    assert.equal(actual.revision, recorded.revision);
    for (const fact of recorded.facts) {
      if (!ids.has(fact.id)) {
        ids.set(fact.id, actual.facts.find(a => a.title === fact.title && a.content === fact.content).id);
      }
      assert.match(fact.updatedDate, /^\d{4}-\d{2}-\d{2}$/u);
    }
    assert.deepEqual(normalize(actual.facts), normalize(recorded.facts.map(f => ({ ...f, id: ids.get(f.id) }))));
  }
  assert.equal(store.snapshot().facts.length, 2);
  assert.ok(store.snapshot().facts.some(f => f.content.includes('要点列表')));
});
