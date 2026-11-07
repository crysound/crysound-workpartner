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
const config = { fetchDeepSeek: true, fetchOpen: true, fetchSummary: true, fetchSummaryModel: "deepseek/deepseek-flash",
  fetchSummaryBaseURL: "https://model.example/v1", fetchOpenModel: "codex/gpt-6-luna", fetchSummaryMinChars: 12000,
  fetchSummaryTimeoutMs: 2000, fetchSummaryMaxTokens: 1600, fetchMaxOutputChars: 40000,
  fetchDirectTimeoutMs: 3000, fetchDeepSeekTimeoutMs: 8000, fetchDeepSeekMinChars: 80, fetchOpenTimeoutMs: 6000, fetchTotalTimeoutMs: 9500 };
const original = () => Object.assign(new Error("原抓取错误"), { code: "WEB_PROVIDER_ERROR" });
const raw = () => ({ url, statusCode: 200, body: { kind: "text", content: page }, truncated: false });
const opened = () => ({ status: "completed", output: [
  { type: "web_search_call", status: "completed", action: { type: "open_page", url } },
  { type: "message", content: [{ type: "output_text", text: JSON.stringify({ readable: true, summary: page }) }] },
] });

function fixture(t, request, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-pipeline-")), tokenFile = path.join(root, "identity");
  const token = issueToken("signing-fixture", { unionId: "alice" });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = new Map([["CRYSOUND_DS_TOOLS_BASE", { value: "http://zhaohua-partner-gateway:3091/_zp/ds-tools/" }],
    ["CRYSOUND_DS_TOOLS_TOKEN_FILE", { value: tokenFile }], ["DEEPSEEK_API_KEY", { value: "model-only-key" }]]);
  const calls = [], records = [], ctx = { web: { fetch: async () => { throw original(); } },
    get: name => name === "agents" ? { currentInitiator: () => ({ session: { append: (type, data) => records.push({ type, data }) } }) } : undefined };
  const services = { launchEnvironmentOf: () => environment, credentialRef: value => value, appendPluginRecord: (session, type, data) => session.append(type, data),
    request: async (endpoint, init) => { calls.push({ endpoint, init }); return request(endpoint, init); } };
  return { ctx, calls, records, environment, token, root,
    run: (signal, question = "收入和限制？") => fetchPage(ctx, { ...config, ...override }, { url }, question, value => ({ text: value.body.content, truncated: value.truncated }), signal, services) };
}

test("normal pages use no paid or Codex calls; DeepSeek evidence is cited and question summaries use existing model", async t => {
  const f = fixture(t, async endpoint => endpoint.endsWith("/fetch") ? Response.json({ title: "年度数据", content: page }) : Response.json({ content: [{ type: "text", text: "收入 1.2 亿元；仅限校准设备。" }] }), { fetchSummaryMinChars: 1 });
  f.ctx.web.fetch = async () => raw();
  // Disable the question to isolate normal retrieval from the separately configured summary behavior.
  assert.equal((await f.run(undefined, "")).body.content, page); assert.equal(f.calls.length, 0);
  f.ctx.web.fetch = async () => { throw original(); };
  const result = await f.run();
  assert.deepEqual(f.calls.map(call => call.endpoint), ["http://zhaohua-partner-gateway:3091/_zp/ds-tools/fetch", "https://model.example/v1/messages"]);
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${f.token}`);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { url });
  assert.match(f.calls[1].init.body, /收入和限制/); assert.match(result.body.content, /Source: https:\/\/8.8.8.8\/report/);
  assert.match(result.body.content, /仅限校准设备/); assert.doesNotMatch(JSON.stringify(f.records), /model-only-key|zpd\./);
});

test("unreadable, invalid, denied and failed paid requests fall back once to the target Codex open", async t => {
  for (const kind of ["thin", "invalid", "json", "http", "network"]) {
    const f = fixture(t, async endpoint => {
      if (endpoint.endsWith("/responses")) return Response.json(opened());
      if (kind === "thin") return Response.json({ title: "登录", content: "字".repeat(65) });
      if (kind === "invalid") return Response.json({ title: "标题" });
      if (kind === "json") return new Response("broken");
      if (kind === "http") return new Response(null, { status: 429 });
      throw new Error("offline");
    });
    assert.match((await f.run()).body.content, /Question-focused page summary/);
    assert.equal(f.calls.length, 2, kind);
    assert.match(f.calls[1].init.body, /收入和限制/);
  }
  const failure = original(), f = fixture(t, async () => new Response(null, { status: 503 }));
  f.ctx.web.fetch = async () => { throw failure; };
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.calls.length, 2);
});

test("direct and paid deadlines share total budget, abort sockets and never dispatch Codex after exhaustion", async t => {
  let now = 0, paidStarted, directSignal, paidSignal;
  t.mock.method(performance, "now", () => now);
  const ready = new Promise(resolve => { paidStarted = resolve; });
  const f = fixture(t, async (_endpoint, init) => {
    paidSignal = init.signal; paidStarted();
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  f.ctx.web.fetch = (_input, signal) => { directSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.run();
  await new Promise(resolve => setImmediate(resolve)); now = 3000; t.mock.timers.tick(3000);
  await ready; assert.equal(directSignal.aborted, true);
  now = 9500; t.mock.timers.tick(6500);
  await assert.rejects(pending, { code: "WEB_FETCH_TIMEOUT" });
  assert.equal(paidSignal.aborted, true); assert.equal(f.calls.length, 1);
});

test("paid success near total deadline preserves readable evidence when summary is cancelled", async t => {
  let now = 0, summaryStarted, summarySignal;
  t.mock.method(performance, "now", () => now);
  const ready = new Promise(resolve => { summaryStarted = resolve; });
  const f = fixture(t, async (endpoint, init) => {
    if (endpoint.endsWith("/fetch")) { now = 9000; return Response.json({ title: "标题", content: page }); }
    summarySignal = init.signal; summaryStarted();
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  }, { fetchSummaryMinChars: 1 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.run(); await ready; now = 9500; t.mock.timers.tick(500);
  const result = await pending;
  assert.match(result.body.content, /收入 1.2 亿元/); assert.match(result.body.content, /Source:/);
  assert.equal(summarySignal.aborted, true); assert.equal(f.calls.length, 2);
});

test("safety failures, disabled fallbacks, invalid gateway and caller cancellation never leak a destination or identity", async t => {
  const f = fixture(t, async () => { assert.fail("unexpected dispatch"); });
  const failure = Object.assign(original(), { code: "WEB_BLOCKED_URL" });
  f.ctx.web.fetch = async () => { throw failure; };
  await assert.rejects(f.run(), error => error === failure);
  const cancelled = new AbortController(); cancelled.abort(new Error("本人取消"));
  await assert.rejects(f.run(cancelled.signal), /本人取消/);
  const g = fixture(t, async () => { assert.fail("identity leaked to wrong host"); }, { fetchOpen: false });
  g.environment.set("CRYSOUND_DS_TOOLS_BASE", { value: "https://untrusted.example/_zp/ds-tools/" });
  await assert.rejects(g.run(), /原抓取错误/);
  const h = fixture(t, async (_endpoint, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    queueMicrotask(() => stop.abort(new Error("本人取消")));
  }));
  const stop = new AbortController();
  await assert.rejects(h.run(stop.signal), /本人取消/); assert.equal(h.calls.length, 1);
});

test("timing report counts dispatched paid and Codex calls, excluding missing credentials", async t => {
  const f = fixture(t, async () => new Response(null, { status: 429 }));
  const file = path.join(f.root, "timing.jsonl"); toolTiming.open(file);
  for (const id of ["paid", "no-gateway"]) {
    const attempt = toolTiming.attempt("fixture", 1, 1, id);
    attempt.chunk({ type: "block-end", block: { type: "tool-call", id, name: "web_fetch" } });
    if (id === "no-gateway") f.environment.delete("CRYSOUND_DS_TOOLS_BASE");
    await attempt.execute(() => toolTiming.dispatch({ callId: id }, async () => {
      try { return { result: await f.run() }; } catch (error) { return { result: { isError: true } }; }
    })); attempt.flush();
  }
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse), summary = fetchTimingSummary(timingReport(records));
  assert.deepEqual(summary.fallbackCalls, { deepseek: 1, codex: 2 });
  assert.equal(summary.stages.deepseek.count, 2);
  assert.doesNotMatch(JSON.stringify(records), /zpd\.|model-only-key|8.8.8.8/);
});
