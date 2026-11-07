import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchPage } from "./fetch-pipeline.mjs";
import { toolTiming } from "./timing.mjs";
import { timingReport, fetchTimingSummary } from "./timing-report.mjs";
import { issueToken } from "../gateway/market-auth.mjs";

const url = "https://8.8.8.8/report", page = "收入 1.2 亿元，增长 12%，仅适用于校准设备。".repeat(8);
const config = { fetchDeepSeek: true, fetchTreg: true, fetchSummary: true, fetchSummaryModel: "deepseek/deepseek-flash",
  fetchSummaryBaseURL: "https://model.example/v1", fetchSummaryMinChars: 12000,
  fetchSummaryTimeoutMs: 2000, fetchSummaryMaxTokens: 1600, fetchMaxOutputChars: 40000,
  fetchDirectTimeoutMs: 1500, fetchDeepSeekTimeoutMs: 8000, fetchDeepSeekMinChars: 80, fetchTregTimeoutMs: 8000, fetchTotalTimeoutMs: 9500 };
const original = () => Object.assign(new Error("原抓取错误"), { code: "WEB_PROVIDER_ERROR" });
const raw = () => ({ url, statusCode: 200, body: { kind: "text", content: page }, truncated: false });

function fixture(t, request, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-pipeline-")), tokenFile = path.join(root, "identity");
  const token = issueToken("signing-fixture", { unionId: "alice" });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = new Map([["CRYSOUND_TREG_BASE", { value: "http://zhaohua-partner-gateway:3091/_zp/treg/" }],["CRYSOUND_DS_TOOLS_BASE", { value: "http://zhaohua-partner-gateway:3091/_zp/ds-tools/" }],
    ["CRYSOUND_DS_TOOLS_TOKEN_FILE", { value: tokenFile }], ["DEEPSEEK_API_KEY", { value: "model-only-key" }]]);
  const calls = [], records = [], ctx = { web: { fetch: async () => { throw original(); } },
    get: name => name === "agents" ? { currentInitiator: () => ({ session: { append: (type, data) => records.push({ type, data }) } }) } : undefined };
  const services = { launchEnvironmentOf: () => environment, credentialRef: value => value, appendPluginRecord: (session, type, data) => session.append(type, data),
    request: async (endpoint, init) => { calls.push({ endpoint, init }); return request(endpoint, init); } };
  return { ctx, calls, records, environment, token, root,
    run: (signal, question = "收入和限制？") => fetchPage(ctx, { ...config, ...override }, { url }, question, value => ({ text: value.body.content, truncated: value.truncated }), signal, services) };
}

const reply = (provider, content = page) => Response.json(provider === "deepseek" ? { title: "年度数据", content }
  : { output: { pages: [{ ok: true, markdown: content }] } });
const providerOf = endpoint => endpoint.endsWith("/fetch") ? "deepseek" : "treg";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hanging = signal => new Promise((_, reject) => { signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });

test("normal pages never call either paid fallback", async t => {
  const f = fixture(t, async () => assert.fail("paid request")); f.ctx.web.fetch = async () => raw();
  assert.equal((await f.run()).body.content, page); assert.equal(f.calls.length, 0);
});

for (const winner of ["deepseek", "treg"]) test(`${winner} can win after both dispatch; loser aborts and only winning evidence is summarized`, async t => {
  const both = deferred(), finished = deferred();
  let loserSignal, count = 0;
  const f = fixture(t, async (endpoint, init) => {
    if (endpoint.endsWith("/messages")) { assert.match(init.body, /收入和限制/); assert.match(init.body, /winner evidence/); return Response.json({ content: [{ type: "text", text: "收入 1.2 亿元；仅限校准设备。" }] }); }
    if (++count === 2) both.resolve();
    const provider = providerOf(endpoint);
    await both.promise;
    if (provider === winner) return reply(provider, page + " winner evidence");
    loserSignal = init.signal;
    try { return await hanging(init.signal); } finally { finished.resolve(); }
  }, { fetchSummaryMinChars: 1 });
  const result = await f.run(); await finished.promise;
  assert.equal(count, 2); assert.equal(loserSignal.aborted, true); assert.equal(f.calls.length, 3);
  assert.match(result.body.content, /Source: https:\/\/8.8.8.8\/report/); assert.match(result.body.content, /校准设备/);
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call.init.headers.authorization, `Bearer ${f.token}`); assert.deepEqual(JSON.parse(call.init.body), { url });
    assert.equal(call.init.redirect, "error");
  }
  const treg = f.calls.find(call => providerOf(call.endpoint) === "treg");
  assert.equal(treg.init.headers["x-treg-route-prefer"], "crawl4ai");
  assert.equal(treg.init.headers["x-treg-route-waterfall"], "0"); assert.equal(treg.init.headers["x-treg-route-max-cost"], "0.005");
  assert.doesNotMatch(JSON.stringify(f.records), /model-only-key|zpd\.|responses|web-open/);
});

test("thin, invalid, denied and failed responses never beat the readable other provider", async t => {
  for (const rejected of ["deepseek", "treg"]) for (const kind of ["thin", "invalid", "json", "http", "network"]) {
    const bad = deferred();
    const f = fixture(t, async endpoint => {
      const provider = providerOf(endpoint);
      if (provider !== rejected) { await bad.promise; return reply(provider); }
      bad.resolve();
      if (kind === "thin") return reply(provider, "字".repeat(65));
      if (kind === "invalid") return Response.json(provider === "treg" ? { output: { pages: [] } } : { title: "标题" });
      if (kind === "json") return new Response("broken");
      if (kind === "http") return new Response(null, { status: 429 });
      throw new Error("offline");
    });
    assert.match((await f.run()).body.content, /1.2 亿元/); assert.equal(f.calls.length, 2);
  }
  const failure = original(), f = fixture(t, async () => new Response(null, { status: 503 }));
  f.ctx.web.fetch = async () => { throw failure; };
  await assert.rejects(f.run(), error => error === failure); assert.equal(f.calls.length, 2);
  f.ctx.web.fetch = async () => ({ ...raw(), statusCode: 403 });
  assert.equal((await f.run()).statusCode, 403);
});

test("direct and parallel requests share a total deadline; both sockets abort without Codex", async t => {
  let now = 0, directSignal; const both = deferred(), signals = [];
  t.mock.method(performance, "now", () => now);
  const f = fixture(t, async (_endpoint, init) => { signals.push(init.signal); if (signals.length === 2) both.resolve(); return hanging(init.signal); });
  f.ctx.web.fetch = (_input, signal) => { directSignal = signal; return hanging(signal); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.run(); const rejected = assert.rejects(pending, { code: "WEB_FETCH_TIMEOUT" });
  await new Promise(resolve => setImmediate(resolve)); now = 1500; t.mock.timers.tick(1500);
  await both.promise; assert.equal(directSignal.aborted, true);
  now = 9500; t.mock.timers.tick(8000); await rejected;
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(f.calls.length, 2);
});

test("winning evidence near total deadline survives summary cancellation", async t => {
  let now = 0, summarySignal; const ready = deferred(); t.mock.method(performance, "now", () => now);
  const f = fixture(t, async (endpoint, init) => {
    if (endpoint.endsWith("/fetch")) { now = 9000; return reply("deepseek"); }
    if (endpoint.includes("/call/")) return hanging(init.signal);
    summarySignal = init.signal; ready.resolve(); return hanging(init.signal);
  }, { fetchSummaryMinChars: 1 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.run(); await ready.promise; now = 9500; t.mock.timers.tick(500);
  assert.match((await pending).body.content, /收入 1.2 亿元/); assert.equal(summarySignal.aborted, true);
});

test("blocked destinations, disabled providers, invalid gateway and cancellation never leak credentials", async t => {
  const f = fixture(t, async () => assert.fail("dispatch"));
  const failure = Object.assign(original(), { code: "WEB_BLOCKED_URL" }); f.ctx.web.fetch = async () => { throw failure; };
  await assert.rejects(f.run(), error => error === failure);
  const cancelled = new AbortController(); cancelled.abort(new Error("本人取消")); await assert.rejects(f.run(cancelled.signal), /本人取消/);
  const disabled = fixture(t, async () => assert.fail("disabled"), { fetchTreg: false, fetchDeepSeek: false }); await assert.rejects(disabled.run(), /原抓取错误/);
  const invalid = fixture(t, async () => assert.fail("wrong gateway"));
  invalid.environment.set("CRYSOUND_DS_TOOLS_BASE", { value: "https://untrusted.example/" }); invalid.environment.set("CRYSOUND_TREG_BASE", { value: "https://untrusted.example/" });
  await assert.rejects(invalid.run(), /原抓取错误/);
  const both = deferred(), stop = new AbortController(), signals = [];
  const h = fixture(t, async (_endpoint, init) => { signals.push(init.signal); if (signals.length === 2) both.resolve(); return hanging(init.signal); });
  const pending = h.run(stop.signal), rejected = assert.rejects(pending, /本人取消/);
  await both.promise; stop.abort(new Error("本人取消")); await rejected; assert.ok(signals.every(signal => signal.aborted));
});

test("timing report counts actual requests and winners, excluding missing credentials", async t => {
  const both = deferred(); let count = 0;
  const f = fixture(t, async (endpoint, init) => { if (++count === 2) both.resolve(); await both.promise; return providerOf(endpoint) === "treg" ? reply("treg") : hanging(init.signal); });
  const file = path.join(f.root, "timing.jsonl"); toolTiming.open(file);
  for (const id of ["paid", "no-gateway"]) {
    const attempt = toolTiming.attempt("fixture", 1, 1, id);
    attempt.chunk({ type: "block-end", block: { type: "tool-call", id, name: "web_fetch" } });
    if (id === "no-gateway") { f.environment.delete("CRYSOUND_DS_TOOLS_BASE"); f.environment.delete("CRYSOUND_TREG_BASE"); }
    await attempt.execute(() => toolTiming.dispatch({ callId: id }, async () => {
      try { return { result: await f.run() }; } catch (error) { return { result: { isError: true } }; }
    })); attempt.flush();
  }
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse), summary = fetchTimingSummary(timingReport(records));
  assert.deepEqual(summary.fallbackCalls, { deepseek: 1, treg: 1 });
  assert.equal(summary.stages.treg.outcomes.winner, 1); assert.equal(summary.stages.deepseek.outcomes.cancelled, 1);
  assert.doesNotMatch(JSON.stringify(records), /zpd\.|model-only-key|8.8.8.8|codex/);
});
