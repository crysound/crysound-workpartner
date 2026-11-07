// 真实 HTTP、假上游、临时通知状态：不读取部署凭据、不发生付费调用或真实通知。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createTreg } from "../treg.mjs";
import { tregLimits } from "../treg-state.mjs";
import { issueToken, tokenUser } from "../market-auth.mjs";

const key = "fake-signing-key", alice = { slug: "alice", unionId: "fake-alice" }, bob = { slug: "bob", unionId: "fake-bob" };
const headers = { authorization: `Bearer ${issueToken(key, alice)}`, "content-type": "application/json" };
const catalog = [{ slug: "web", name: "Web" }];
const ep = (id = "provider.web.search", extra = {}) => ({ id, platform: "web", kind: "data", method: "POST", platform_eligible: true, ...extra });
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "treg-gateway-"));
  const calls = [], spendRows = [];
  const nativeBudgets = new Map();
  let callStarted; const started = new Promise((resolve) => { callStarted = resolve; });
  let time = Date.parse("2026-10-31T15:59:00Z"), notifications = 0, response = () => Response.json({ results: ["ok"] }, { headers: { "x-treg-cost-micro": "1000" } });
  let platformRows = [{ slug: "web", label: "Web", category: "SEO/AEO" }];
  let lookup = (id) => ep(id), budgetFailure = false, reportResponse;
  const fetcher = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith("/catalog/platforms")) return Response.json({ platforms: platformRows });
    if (url.includes("/catalog/endpoints/")) return Response.json({ endpoint: lookup(decodeURIComponent(url.split("/").pop())) });
    if (url.includes("/catalog/search")) return Response.json({ results: [ep(), ep("provider.ai.generate", { platform: "ai" })] });
    if (url.includes("/budgets/")) {
      if (!budgetFailure) nativeBudgets.set(url.split("/budgets/user")[1] || "", JSON.parse(init.body));
      return Response.json({}, { status: budgetFailure ? 503 : 200 });
    }
    const slug = init.headers["x-treg-meta"]?.slice(5);
    const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    if (url.includes("/usage/by-tag")) {
      if (reportResponse) return reportResponse();
      const days = Number(new URL(url).searchParams.get("days"));
      const since = Date.parse(utcDay(time)) - (days - 1) * 86400000;
      return Response.json({ key: "user", rows: ["alice", "bob"].map((value) => ({ value,
        charged_micro: spendRows.filter((r) => r.slug === value && r.time >= since).reduce((sum, r) => sum + r.cost, 0),
      })), total_usd: 12345, unattributed_micro: 777 });
    }
    if (url.includes("/call/")) {
      // 假上游模拟其原生日/月预算；网关必须传对认证头、本人标签和预算。
      if (init.headers["x-treg-token"] !== "fake-company-token") return Response.json({}, { status: 401 });
      const caps = nativeBudgets.get("/" + slug) ?? nativeBudgets.get("");
      const rows = spendRows.filter((r) => r.slug === slug);
      for (const [period, cap, used] of [
        ["day", caps?.daily_cap_micro, rows.filter((r) => utcDay(r.time) === utcDay(time)).reduce((a, r) => a + r.cost, 0)],
        ["month", caps?.monthly_cap_micro, rows.filter((r) => utcDay(r.time).slice(0, 7) === utcDay(time).slice(0, 7)).reduce((a, r) => a + r.cost, 0)],
      ]) if (cap !== undefined && used + 1000 > cap) return Response.json({ detail: { error: "tag_spend_cap_reached", period, private: "secret" } }, { status: 429 });
      callStarted();
      const result = await response(url, init);
      if (result.ok) spendRows.push({ slug, time, cost: Number(result.headers.get("x-treg-cost-micro") ?? 1000) });
      return result;
    }
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
  return { dir, calls, spendRows, started, request, mcp, call, notifications: () => notifications, now: () => time,
    setTime: (next) => { time = Date.parse(next); }, setResponse: (next) => { response = next; },
    setPlatforms: (next) => { platformRows = next; },
    lookup: (next) => { lookup = next; }, failBudget: (value = true) => { budgetFailure = value; }, setReport: (next) => { reportResponse = next; }, restart: () => { handle = createTreg(config); } };
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

test("MCP 协议探测返回方法不存在并保留标识，随后仍能握手和列工具", async (t) => {
  const f = await fixture(t);
  for (const id of [0, 42, "discover-1"]) {
    const probe = await f.mcp("unused", {}, { method: "server/discover", params: {}, id });
    assert.equal(probe.status, 200);
    assert.deepEqual(probe.body, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    assert.match(probe.headers.get("content-type"), /application\/json/);
  }
  const initialized = await f.mcp("unused", {}, { method: "initialize", params: {} });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-03-26");
  const list = await f.mcp("unused", {}, { method: "tools/list", params: {} });
  assert.deepEqual(list.body.result.tools.map((tool) => tool.name), ["catalog_search", "catalog_get", "call"]);
  assert.equal(f.calls.length, 0);
});

test("MCP 协议探测不能绕过身份校验和服务开关", async (t) => {
  const f = await fixture(t);
  const probe = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }) };
  for (const h of [{}, { cookie: "zp_sid=fake" }, { authorization: "Bearer fake" },
    { authorization: `Bearer ${issueToken(key, alice, 0)}` },
    { authorization: `Bearer ${issueToken(key, { unionId: "stranger" })}` }]) {
    assert.equal((await f.request("/mcp/", { ...probe, headers: h })).status, 401);
  }
  assert.equal(f.calls.length, 0);
  for (const config of [{ enabled: false }, { token: () => "" }]) {
    const disabled = await fixture(t, config);
    assert.equal((await disabled.request("/mcp/", probe)).status, 503);
    assert.equal((await disabled.request("/mcp/", { ...probe, headers: {} })).status, 401);
    assert.equal(disabled.calls.length, 0);
  }
});

test("MCP 其他受限方法仍拒绝，协议探测仍校验格式和请求标识", async (t) => {
  const f = await fixture(t);
  for (const method of ["resources/list", "prompts/list", "server/other", "admin", "unknown"]) {
    assert.equal((await f.mcp("unused", {}, { method })).status, 403);
  }
  for (const extra of [{ id: undefined }, { id: null }, { jsonrpc: "1.0" }, { unexpected: true }]) {
    assert.equal((await f.mcp("unused", {}, { method: "server/discover", ...extra })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("REST 强制本人归属与认证、日/月默认预算；普通用户不创建逐人预算", async (t) => {
  const f = await fixture(t);
  const r = await f.call({ headers: { ...headers, "x-treg-meta": "user=bob", "x-treg-route-max-cost": "999", "x-treg-org": "other", "x-treg-token": "fake-user-token" } });
  assert.equal(r.status, 200);
  await f.call({ headers: { authorization: `Bearer ${issueToken(key, bob)}` } });
  const budgets = f.calls.filter((x) => x.url.includes("/budgets/"));
  assert.equal(budgets.length, 1); assert.match(budgets[0].url, /budgets\/user$/);
  assert.deepEqual(JSON.parse(budgets[0].body), { daily_cap_micro: 1000000, monthly_cap_micro: 2000000 });
  const forwarded = f.calls.find((x) => x.url.includes("/call/"));
  assert.equal(forwarded.headers["x-treg-meta"], "user=alice"); assert.equal(forwarded.headers["x-treg-route-max-cost"], "0.1");
  assert.equal(forwarded.headers["x-treg-token"], "fake-company-token"); assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(forwarded.headers["x-treg-org"], "fake-org"); assert.doesNotMatch(r.text, /fake-company-token|fake-org/);
  f.restart();
  const usage = await f.request("/usage");
  assert.equal(usage.body.timezone, "UTC"); assert.equal(usage.body.daily.usedUsd, .001); assert.equal(usage.body.monthly.usedUsd, .001);
  assert.doesNotMatch(usage.text, /12345|777|alice|bob|total_usd|unattributed/);
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

test("原生日月预算按 UTC 恢复，月份查询使用 UTC 当月日数；用户相互独立", async (t) => {
  const f = await fixture(t, { env: { TREG_DAILY_USD: ".001", TREG_MONTHLY_USD: ".002", TREG_CALL_MAX_USD: ".001" } });
  assert.equal((await f.call()).status, 200);
  const dayCap = await f.call(); assert.equal(dayCap.status, 429); assert.match(dayCap.text, /每天 08:00/);
  f.setTime("2026-10-31T16:00:00Z"); // 北京已到十一月，UTC 仍是十月。
  assert.equal((await f.request("/usage")).body.month, "2026-10");
  assert.match(f.calls.at(-1).url, /days=31$/); assert.equal((await f.call()).status, 429);
  f.setTime("2026-11-01T00:00:00Z"); assert.equal((await f.request("/usage")).body.monthly.usedUsd, 0);
  assert.equal((await f.call()).status, 200);
  f.setTime("2026-11-02T00:00:00Z"); assert.equal((await f.call()).status, 200);
  f.setTime("2026-11-03T00:00:00Z");
  const monthCap = await f.call(); assert.equal(monthCap.status, 429); assert.match(monthCap.text, /每月 1 日 08:00/); assert.doesNotMatch(monthCap.text, /secret/);
  assert.equal((await f.call({ headers: { authorization: `Bearer ${issueToken(key, bob)}` } })).status, 200);
  f.restart(); assert.equal((await f.call()).status, 429);
  f.setTime("2026-12-01T00:00:00Z"); assert.equal((await f.call()).status, 200);
});

test("未知费用不冒充实扣，断连不自动重试；用量仍从上游账单读取", async (t) => {
  const f = await fixture(t);
  f.setResponse(() => Response.json({ ok: true }));
  const result = await f.mcp("call", { endpoint_id: "provider.web.search", params: {} });
  assert.equal(result.body.result.structuredContent.cost_usd, null);
  assert.equal(result.body.result.structuredContent.costEstimated, true);
  assert.equal((await f.request("/usage")).body.daily.usedUsd, .001);
  f.setResponse(() => { throw new Error("private-network-error"); });
  const failed = await f.call(); assert.equal(failed.status, 502); assert.match(failed.text, /结果未知/); assert.doesNotMatch(failed.text, /计入|private/);
  assert.equal(f.calls.filter((r) => r.url.includes("/call/")).length, 2);
  f.restart(); assert.equal((await f.request("/usage")).body.daily.usedUsd, .001);
});

test("公司额度报错中文脱敏，每个北京日只通知一次，重启与并发不重复", async (t) => {
  const f = await fixture(t);
  f.setResponse(() => Response.json({ error: "insufficient_balance", balance_micro: 4810000, topup_url: "https://private-billing" }, { status: 402, headers: { "x-treg-cost-micro": "0" } }));
  const results = await Promise.all([f.call(), f.call(), f.mcp("call", { endpoint_id: "provider.web.search", params: {} })]);
  for (const r of results) { assert.match(r.text, /公司数据额度暂时用完/); assert.doesNotMatch(r.text, /4810000|private-billing|balance_micro/); }
  assert.equal(f.calls.filter((x) => x.url.includes("/budgets/")).length, 1);
  assert.equal(f.notifications(), 1); f.restart(); await f.call(); assert.equal(f.notifications(), 1);
  f.setTime("2026-10-31T16:00:00Z");
  f.setResponse(() => Response.json({ detail: { error: "platform_daily_cap_reached" }, balance: "private" }, { status: 429, headers: { "x-treg-cost-micro": "0" } }));
  await f.call(); assert.equal(f.notifications(), 2);
  f.setResponse(() => Response.json({ error: "tag_spend_cap_reached", period: "day", balance: "private" }, { status: 429, headers: { "x-treg-cost-micro": "0" } }));
  const capped = await f.call(); assert.match(capped.text, /今天/); assert.doesNotMatch(capped.text, /private/);
});

test("个人例外同步日月上限但不改暂停状态；预算失败不能发送付费请求", async (t) => {
  const f = await fixture(t, { overrides: { alice: { dailyUsd: .01, monthlyUsd: .1 } } });
  await f.call({ headers: { ...headers, "idempotency-key": "same-key" } });
  await f.call({ headers: { authorization: `Bearer ${issueToken(key, bob)}`, "idempotency-key": "same-key" } });
  const budgets = f.calls.filter((x) => x.url.includes("/budgets/")); assert.equal(budgets.length, 2);
  assert.match(budgets[1].url, /budgets\/user\/alice$/);
  assert.deepEqual(JSON.parse(budgets[1].body), { daily_cap_micro: 10000, monthly_cap_micro: 100000 });
  const requests = f.calls.filter((x) => x.url.includes("/call/")); assert.notEqual(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
  const failed = await fixture(t); failed.failBudget(); assert.equal((await failed.call()).status, 503);
  assert.equal(failed.calls.filter((x) => x.url.includes("/call/")).length, 0);
  failed.failBudget(false); assert.equal((await failed.call()).status, 200);
});

test("开关与归属验证关闭付费入口；暂停提示不声称到期自动恢复", async (t) => {
  for (const config of [{ enabled: false }, { token: () => "" }, { attributionVerified: false }]) {
    const f = await fixture(t, config); assert.equal((await f.call()).status, 503); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  f.setResponse(() => Response.json({ detail: { error: "tag_blocked", private: "secret" } }, { status: 403 }));
  const blocked = await f.call(); assert.equal(blocked.status, 429); assert.match(blocked.text, /已暂停/); assert.doesNotMatch(blocked.text, /恢复|secret/);
});

test("个人覆盖在配置边界解析，负数、未知字段和超过微美元精度拒绝", () => {
  const limits = tregLimits({}, { alice: { dailyUsd: .001, monthlyUsd: 0, callMaxUsd: .00001 } });
  assert.deepEqual(limits("alice"), { daily: 1000, monthly: 0, call: 10 }); assert.equal(limits("bob").monthly, 5000000);
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


test("上游用量失败或本人金额无效时不显示零用量，不泄漏团队报表", async (t) => {
  const f = await fixture(t);
  for (const report of [
    () => Response.json({ private: "company-balance" }, { status: 500 }),
    () => new Response("private-invalid-json"),
    () => Response.json({ key: "user", rows: [{ value: "alice", charged_micro: -1 }] }),
    () => Response.json({ key: "user", rows: [{ value: "alice", charged_micro: "1000" }] }),
    () => Response.json({ key: "user", rows: [{ value: "alice", charged_micro: 1 }, { value: "alice", charged_micro: 2 }] }),
    () => Response.json({ key: "other", rows: [] }),
  ]) {
    f.setReport(report);
    const result = await f.request("/usage");
    assert.ok(result.status >= 500); assert.equal(result.body.daily, undefined);
    assert.doesNotMatch(result.text, /company-balance|private-invalid-json|charged_micro/);
  }
});


test("无市场目录缓存：真实调用按当前公共平台白名单校验，不向目录附凭据", async (t) => {
  const f = await fixture(t, { catalog: undefined });
  assert.equal((await f.call()).status, 200);
  const listing = await f.request("/catalog/platforms");
  assert.deepEqual(listing.body.platforms, [{ slug: "web", name: "Web", category: "SEO/AEO" }]);
  f.setPlatforms([{ slug: "web", label: "Web", category: "AI generation" }]);
  assert.equal((await f.call()).status, 403);
  assert.equal(f.calls.filter((call) => call.url.includes("/call/")).length, 1);
  for (const call of f.calls.filter((call) => call.url.endsWith("/catalog/platforms"))) {
    assert.deepEqual(call.headers, { accept: "application/json" });
    assert.equal(call.redirect, "error");
  }
});

test("网页提取只开放一个固定路由，锁定 Crawl4AI 并计入本人预算", async t => {
  const f = await fixture(t, { catalog: async () => [] });
  f.lookup(id => ep(id, { kind: "routed", routed_children: ["crawl4ai.web.scrape", "blocked.ai.generate"] }));
  f.setResponse(() => Response.json({ output: { pages: [{ ok: true, markdown: "公开正文" }] } }, { headers: { "x-treg-cost-micro": "150" } }));
  const route = "/call/treg.web.extract", init = { method: "POST", headers: { ...headers, "x-treg-route-prefer": "serper", "x-treg-route-waterfall": "1", "x-treg-route-max-cost": "999", "x-treg-meta": "user=bob" }, body: JSON.stringify({ url: "https://example.com/report.pdf" }) };
  const result = await f.request(route, init); assert.equal(result.status, 200); assert.match(result.text, /公开正文/);
  const call = f.calls.find(row => row.url.includes("/call/"));
  assert.equal(call.url, "https://treg.to/call/treg.web.extract"); assert.equal(call.headers["x-treg-meta"], "user=alice");
  assert.equal(call.headers["x-treg-route-prefer"], "crawl4ai"); assert.equal(call.headers["x-treg-route-waterfall"], "0");
  assert.equal(call.headers["x-treg-route-max-cost"], "0.005"); assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(call.body), { url: "https://example.com/report.pdf" });
  assert.equal((await f.request("/usage")).body.daily.usedUsd, .00015);
  assert.equal((await f.request("/call/treg.web.other", init)).status, 403);
  for (const body of [{ url: "https://example.com", provider: "serper" }, { url: "file:///etc/passwd" }, { url: "https://key:secret@example.com" }, {}]) assert.equal((await f.request(route, { ...init, body: JSON.stringify(body) })).status, 400);
  assert.equal((await f.request(route + "?token=x", init)).status, 400);
  assert.equal(f.calls.filter(row => row.url.includes("/call/")).length, 1);
});

test("网页提取遵守低单次额度、本人日/月额度；用完不再调用", async t => {
  const f = await fixture(t, { env: { TREG_DAILY_USD: "0.001", TREG_MONTHLY_USD: "0.001", TREG_CALL_MAX_USD: "0.0002" } });
  f.lookup(id => ep(id, { kind: "routed", routed_children: ["crawl4ai.web.scrape"] }));
  const request = () => f.request("/call/treg.web.extract", { method: "POST", body: JSON.stringify({ url: "https://example.com" }) });
  assert.equal((await request()).status, 200); assert.equal((await request()).status, 429);
  assert.equal(f.calls.find(row => row.url.includes("/call/")).headers["x-treg-route-max-cost"], "0.0002");
  const zero = await fixture(t, { env: { TREG_MONTHLY_USD: "0" } });
  zero.lookup(id => ep(id, { kind: "routed", routed_children: ["crawl4ai.web.scrape"] }));
  assert.equal((await zero.request("/call/treg.web.extract", { method: "POST", body: '{"url":"https://example.com"}' })).status, 429);
  assert.equal(zero.calls.filter(row => row.url.includes("/call/")).length, 0);
});

test("网页提取客户端断连会取消上游，已计费用不自动重试", async t => {
  const f = await fixture(t); let ready, closed, outgoing;
  const entered = new Promise(resolve => { ready = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
  const upstream = http.createServer((req, res) => { req.resume(); res.on("close", closed); ready(); });
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  f.lookup(id => ep(id, { kind: "routed", routed_children: ["crawl4ai.web.scrape"] }));
  f.setResponse((_url, init) => { outgoing = init.signal; return fetch(`http://127.0.0.1:${upstream.address().port}/fake-extract`, init); });
  const stop = new AbortController(), pending = f.request("/call/treg.web.extract", { method: "POST", body: '{"url":"https://example.com"}', signal: stop.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered; stop.abort(); await rejected; await disconnected; assert.equal(outgoing.aborted, true);
  assert.equal(f.calls.filter(row => row.url.includes("/call/")).length, 1);
});

test("web.search 固定 Exa 且关闭瀑布，上限不超过个人设置和一美分，仍按本人预算收费", async t => {
  const f = await fixture(t);
  f.lookup(id => id === "treg.web.search" ? ep(id, { kind: "routed", routed_children: ["exa.web.search"] }) : ep(id));
  const result = await f.request("/call/treg.web.search", { method: "POST", body: '{"q":"Rust","limit":10}', headers: {
    ...headers, "x-treg-route-prefer": "other", "x-treg-route-waterfall": "1", "x-treg-route-max-cost": "999", "x-treg-meta": "user=bob",
  } });
  assert.equal(result.status, 200);
  const forwarded = f.calls.find(r => r.url.endsWith("/call/treg.web.search"));
  assert.equal(forwarded.headers["x-treg-route-prefer"], "exa");
  assert.equal(forwarded.headers["x-treg-route-waterfall"], "0");
  assert.equal(forwarded.headers["x-treg-route-max-cost"], "0.01");
  assert.equal(forwarded.headers["x-treg-meta"], "user=alice");
  assert.deepEqual(JSON.parse(forwarded.body), { q: "Rust", limit: 10 });
  assert.equal((await f.request("/usage")).body.daily.usedUsd, .001);
  const denied = await fixture(t);
  denied.lookup(id => id === "treg.web.search" ? ep(id, { kind: "routed", routed_children: ["exa.web.search"] }) : ep(id, { platform: "ai" }));
  assert.equal((await denied.request("/call/treg.web.search", { method: "POST", body: '{"q":"Rust"}' })).status, 403);
  assert.equal(denied.calls.filter(r => r.url.includes("/call/")).length, 0);
  const missing = await fixture(t);
  missing.lookup(id => ep(id, { kind: "routed", routed_children: ["other.web.search"] }));
  assert.equal((await missing.request("/call/treg.web.search", { method: "POST", body: '{"q":"Rust"}' })).status, 403);
  const limited = await fixture(t, { env: { TREG_CALL_MAX_USD: ".005" } });
  await limited.request("/call/treg.web.search", { method: "POST", body: '{"q":"Rust"}' });
  assert.equal(limited.calls.find(r => r.url.includes("/call/")).headers["x-treg-route-max-cost"], "0.005");
  const blocked = await fixture(t, { env: { TREG_MONTHLY_USD: "0" } });
  assert.equal((await blocked.request("/call/treg.web.search", { method: "POST", body: '{"q":"Rust"}' })).status, 429);
  assert.equal(blocked.calls.filter(r => r.url.includes("/call/")).length, 0);
});
