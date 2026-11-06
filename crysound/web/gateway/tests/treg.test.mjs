// 真实 HTTP、假上游、临时账本：不读取部署凭据、不发生付费调用或真实通知。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createTreg } from "../treg.mjs";
import { createTregLedger, tregLimits } from "../treg-ledger.mjs";
import { issueToken, tokenUser } from "../market-auth.mjs";

const key = "fake-signing-key", alice = { slug: "alice", unionId: "fake-alice" }, bob = { slug: "bob", unionId: "fake-bob" };
const headers = { authorization: `Bearer ${issueToken(key, alice)}`, "content-type": "application/json" };
const catalog = { categories: [{ platforms: [{ slug: "web", name: "Web" }] }] };
const ep = (id = "provider.web.search", extra = {}) => ({ id, platform: "web", kind: "data", method: "POST", platform_eligible: true, ...extra });
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "treg-gateway-"));
  const calls = [];
  let callStarted; const started = new Promise((resolve) => { callStarted = resolve; });
  let time = Date.parse("2026-10-31T15:59:00Z"), notifications = 0, response = () => Response.json({ results: ["ok"] }, { headers: { "x-treg-cost-micro": "1000" } });
  let lookup = (id) => ep(id), budgetFailure = false;
  const fetcher = async (url, init) => {
    calls.push({ url, ...init });
    if (url.includes("/catalog/endpoints/")) return Response.json({ endpoint: lookup(decodeURIComponent(url.split("/").pop())) });
    if (url.includes("/catalog/search")) return Response.json({ results: [ep(), ep("provider.ai.generate", { platform: "ai" })] });
    if (url.includes("/budgets/")) return Response.json({}, { status: budgetFailure ? 503 : 200 });
    if (url.includes("/call/")) { callStarted(); return response(); }
    throw new Error("unexpected fixture request");
  };
  const config = { enabled: true, token: () => "fake-company-token", orgId: "123", orgSlug: "fake-org", attributionVerified: true,
    stateDir: dir, authenticate: (req) => tokenUser(req, key, [alice, bob]), catalog: async () => catalog,
    env: { TREG_DAILY_USD: "1", TREG_MONTHLY_USD: "2", TREG_CALL_MAX_USD: "0.1" }, fetcher,
    now: () => time, notify: async () => { notifications++; }, ...options };
  let handle = createTreg(config);
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, "http://fixture.test"))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, init = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/_zp/treg${route}`, { headers, ...init });
    const text = await r.text(); return { status: r.status, headers: r.headers, text, body: text ? JSON.parse(text) : null };
  };
  const mcp = (name, args = {}, extra = {}) => request("/mcp/", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }, ...extra }) });
  const call = (init = {}) => request("/call/provider.web.search", { method: "POST", body: '{"q":"company"}', ...init });
  return { dir, calls, started, request, mcp, call, notifications: () => notifications, now: () => time,
    setTime: (next) => { time = Date.parse(next); }, setResponse: (next) => { response = next; },
    lookup: (next) => { lookup = next; }, failBudget: () => { budgetFailure = true; }, restart: () => { handle = createTreg(config); } };
}

test("鉴权先于上游：网页 Cookie、伪造、过期及未开通身份均不能调用", async (t) => {
  const f = await fixture(t);
  for (const h of [{}, { cookie: "zp_sid=fake" }, { authorization: "Bearer fake" },
    { authorization: `Bearer ${issueToken("wrong-key", alice)}` }, { authorization: `Bearer ${issueToken(key, { unionId: "stranger" })}` },
    { authorization: `Bearer ${issueToken(key, alice, 0)}` }]) {
    assert.equal((await f.call({ headers: { ...h, "x-treg-meta": "user=bob" } })).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test("REST 强制本人归属、单次预留上限与原生日预算；实扣和本人用量持久化", async (t) => {
  const f = await fixture(t);
  const r = await f.call({ headers: { ...headers, "x-treg-meta": "user=bob", "x-treg-route-max-cost": "999", "x-treg-org": "other", "x-treg-token": "fake-user-token" } });
  assert.equal(r.status, 200);
  const budget = f.calls.find((x) => x.url.includes("/budgets/"));
  assert.match(budget.url, /budgets\/user\/alice$/); assert.deepEqual(JSON.parse(budget.body), { daily_cap_micro: 1000000 });
  const forwarded = f.calls.find((x) => x.url.includes("/call/"));
  assert.equal(forwarded.headers["x-treg-meta"], "user=alice"); assert.equal(forwarded.headers["x-treg-route-max-cost"], "0.1");
  assert.equal(forwarded.headers.authorization, "Bearer fake-company-token"); assert.equal(forwarded.headers["x-treg-org"], "fake-org");
  assert.doesNotMatch(r.text, /fake-company-token|fake-org/);
  f.restart();
  const usage = (await f.request("/usage")).body;
  assert.equal(usage.timezone, "Asia/Shanghai"); assert.equal(usage.daily.usedUsd, .001); assert.equal(usage.monthly.usedUsd, .001);
  const other = await f.request("/usage", { headers: { authorization: `Bearer ${issueToken(key, bob)}` } });
  assert.equal(other.body.monthly.usedUsd, 0);
  const row = JSON.parse(fs.readFileSync(path.join(f.dir, "2026-10.json"))).entries[0];
  assert.equal(row.reservedMicro, 100000); assert.equal(row.actualMicro, 1000);
  assert.equal(fs.statSync(path.join(f.dir, "2026-10.json")).mode & 0o777, 0o600);
});

test("受限 MCP 只列三项工具，调用复用 REST 费用上限；请求头与管理工具不能绕过", async (t) => {
  const f = await fixture(t);
  const list = await f.mcp("unused", {}, { method: "tools/list", params: {} });
  assert.deepEqual(list.body.result.tools.map((x) => x.name), ["catalog_search", "catalog_get", "call"]);
  const r = await f.mcp("call", { endpoint_id: "provider.web.search", params: { q: "test" } });
  assert.equal(r.body.result.isError, false); assert.equal(r.body.result.structuredContent.cost_usd, .001);
  assert.equal(f.calls.find((x) => x.url.includes("/call/")).headers["x-treg-meta"], "user=alice");
  for (const [name, args] of [["balance", {}], ["my_tools", {}], ["hub_create", {}],
    ["call", { endpoint_id: "provider.web.search", headers: { "X-Treg-Meta": "user=bob" } }],
    ["call", { endpoint_id: "own-tool/path" }]]) {
    assert.equal((await f.mcp(name, args)).body.result.isError, true);
  }
  assert.equal(f.calls.filter((x) => x.url.includes("/call/")).length, 1);
  const batch = await f.request("/mcp/", { method: "POST", body: "[]" }); assert.equal(batch.status, 400);
  assert.equal((await f.mcp("x", {}, { method: "resources/list" })).status, 403);
});

test("AI、管理端点、未知路径、路由内 AI 和私有工具同时在 REST 与 MCP 被拒", async (t) => {
  const f = await fixture(t);
  f.lookup((id) => id.includes("generate") ? ep(id, { platform: "ai" }) : id.includes("management") ? ep(id, { kind: "management" })
    : id.includes("routed") ? ep(id, { kind: "routed", routed_children: ["provider.ai.generate"] }) : ep(id));
  for (const id of ["provider.ai.generate", "provider.management.list", "provider.routed.search", "tools/private", "%2e%2e/admin"]) {
    assert.equal((await f.request(`/call/${id}`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await f.mcp("call", { endpoint_id: id, params: {} })).body.result.isError, true);
  }
  for (const route of ["/orgs/123/budgets", "/billing", "/secrets", "/tools", "/catalog/search?include_hidden=1", "/catalog/providers/secret"]) assert.equal((await f.request(route)).status, 403);
  assert.equal(f.calls.filter((x) => x.url.includes("/call/")).length, 0);
  const search = await f.request("/catalog/search?q=search"); assert.equal(search.body.count, 1);
  assert.doesNotMatch(search.text, /ai.generate/);
});

test("并发先预留，剩余额度缩小单次上限；未知结果不退账，重启后不能超额", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { env: { TREG_DAILY_USD: ".001", TREG_MONTHLY_USD: "1", TREG_CALL_MAX_USD: "1" } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.setResponse(async () => { await gate; throw new Error("private-network-error"); });
  t.after(() => release());
  const first = f.call();
  await f.started;
  assert.equal(f.calls.find((x) => x.url.includes("/call/")).headers["x-treg-route-max-cost"], "0.001");
  assert.equal((await f.call()).status, 429); release();
  const result = await first; assert.match(result.body.error, /结果未知/); assert.doesNotMatch(result.text, /private/);
  f.restart(); assert.equal((await f.call()).status, 429);
  assert.equal((await f.request("/usage")).body.daily.usedUsd, .001);
});

test("北京时间跨日跨月自然恢复；跨月响应仍结算原账目，其他人的额度独立", async (t) => {
  const f = await fixture(t, { env: { TREG_DAILY_USD: ".001", TREG_MONTHLY_USD: ".002", TREG_CALL_MAX_USD: ".001" } });
  assert.equal((await f.call()).status, 200); assert.equal((await f.call()).status, 429);
  f.setTime("2026-10-31T16:00:00Z");
  assert.equal((await f.request("/usage")).body.monthly.usedUsd, 0);
  assert.equal((await f.call()).status, 200);
  f.setTime("2026-11-01T16:00:00Z"); assert.equal((await f.call()).status, 200);
  f.setTime("2026-11-02T16:00:00Z"); const capped = await f.call(); assert.match(capped.body.error, /本月/);
  assert.equal((await f.call({ headers: { authorization: `Bearer ${issueToken(key, bob)}` } })).status, 200);
  const ledger = createTregLedger({ dir: f.dir, now: f.now });
  f.setTime("2026-11-30T15:59:59Z"); const hold = ledger.reserve("carol", "/call/data", { daily: 10, monthly: 10, call: 10 });
  f.setTime("2026-11-30T16:00:00Z"); ledger.settle(hold, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "2026-11.json"))).entries.at(-1).actualMicro, 4);
  assert.equal(ledger.usage("carol", { daily: 10, monthly: 10 }).monthly.usedUsd, 0);
});

test("公司额度报错中文脱敏，每个北京日只通知一次，重启与并发不重复", async (t) => {
  const f = await fixture(t);
  f.setResponse(() => Response.json({ error: "insufficient_balance", balance_micro: 4810000, topup_url: "https://private-billing" }, { status: 402, headers: { "x-treg-cost-micro": "0" } }));
  const results = await Promise.all([f.call(), f.call(), f.mcp("call", { endpoint_id: "provider.web.search", params: {} })]);
  for (const r of results) { assert.match(r.text, /公司数据额度暂时用完/); assert.doesNotMatch(r.text, /4810000|private-billing|balance_micro/); }
  assert.equal(f.notifications(), 1); f.restart(); await f.call(); assert.equal(f.notifications(), 1);
  f.setTime("2026-10-31T16:00:00Z");
  f.setResponse(() => Response.json({ detail: { error: "platform_daily_cap_reached" }, balance: "private" }, { status: 429, headers: { "x-treg-cost-micro": "0" } }));
  await f.call(); assert.equal(f.notifications(), 2);
  f.setResponse(() => Response.json({ error: "tag_spend_cap_reached", period: "day", balance: "private" }, { status: 429, headers: { "x-treg-cost-micro": "0" } }));
  const capped = await f.call(); assert.match(capped.text, /今天/); assert.doesNotMatch(capped.text, /private/);
});

test("缺费用按预留计费，幂等标识隔离到本人；原生预算失败不能发送付费请求", async (t) => {
  const f = await fixture(t);
  f.setResponse(() => Response.json({ ok: true }));
  const r = await f.call({ headers: { ...headers, "idempotency-key": "same-key" } }); assert.equal(r.headers.get("x-zp-cost-estimated"), "1");
  assert.equal((await f.request("/usage")).body.monthly.usedUsd, .1);
  await f.call({ headers: { authorization: `Bearer ${issueToken(key, bob)}`, "idempotency-key": "same-key" } });
  const requests = f.calls.filter((x) => x.url.includes("/call/")); assert.notEqual(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
  const failed = await fixture(t); failed.failBudget(); assert.equal((await failed.call()).status, 503);
  assert.equal(failed.calls.filter((x) => x.url.includes("/call/")).length, 0);
});

test("开关、未验证归属和损坏账本均关闭付费入口；无令牌不连接上游", async (t) => {
  for (const config of [{ enabled: false }, { token: () => "" }, { attributionVerified: false }]) {
    const f = await fixture(t, config); assert.equal((await f.call()).status, 503); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t); await f.call();
  fs.writeFileSync(path.join(f.dir, "2026-10.json"), "broken ledger"); f.calls.length = 0;
  assert.equal((await f.call()).status, 503); assert.equal(f.calls.length, 0);
});

test("个人覆盖在配置边界解析，负数、未知字段和超过微美元精度拒绝", () => {
  const limits = tregLimits({}, { alice: { dailyUsd: .001, monthlyUsd: 0, callMaxUsd: .00001 } });
  assert.deepEqual(limits("alice"), { daily: 1000, monthly: 0, call: 10 }); assert.equal(limits("bob").monthly, 10000000);
  for (const value of [-1, "", "NaN", .0000001, Infinity]) assert.throws(() => tregLimits({ TREG_DAILY_USD: value }));
  assert.throws(() => tregLimits({}, { alice: { unknown: 1 } }));
});


test("GET 数据调用保留重复查询参数，供应商方法不能被改成其他操作", async (t) => {
  const f = await fixture(t); f.lookup((id) => ep(id, { method: "GET" }));
  const r = await f.request("/call/provider.web.lookup?q=one&q=two&limit=2"); assert.equal(r.status, 200);
  const forwarded = f.calls.find((x) => x.url.includes("/call/"));
  assert.deepEqual(new URL(forwarded.url).searchParams.getAll("q"), ["one", "two"]);
  assert.equal((await f.call()).status, 403);
});
