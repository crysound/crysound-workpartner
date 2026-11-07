import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWithFallback } from "./search.mjs";
import { patchWebTools } from "./patch.mjs";
import { released, WebError } from "./release-fixture.mjs";
import { toolTiming } from "./timing.mjs";
import { timingReport } from "./timing-report.mjs";

const env = { CRYSOUND_DS_TOOLS_BASE: "http://zhaohua-partner-gateway:3091/_zp/ds-tools/", CRYSOUND_DS_TOOLS_TOKEN_FILE: "/fixture/identity" };
const identity = "zpd.fixture." + "a".repeat(43);
const options = { baseURL: "https://model.example/v1", apiKey: "model-only-key", apiVersion: "2023-06-01", maxTokens: 4096, maxUses: 5 };
const native = { content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://weather.example/native", title: "备用天气" }] }] };
const apiResult = () => ({ results: Array.from({ length: 10 }, (_, i) => ({ title: `天气 ${i}`, url: `https://weather.example/${i}`, date: "2026-11-07", summary: "杭州晴，22℃。" + "证".repeat(900), snippet: "天气预报", content: "unused full text" })) });

async function fixture(t, modelFetch = async () => Response.json(native)) {
  const root = await mkdtemp(join(tmpdir(), "partner-search-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["dsh-tool-web", "dsh-web-fetch-http", "dsh-web-search-deepseek"]) {
    const target = join(root, "@deepseek-ai", name);
    await mkdir(join(target, "lib"), { recursive: true });
    await cp(join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai", name, "package.json"), join(target, "package.json"));
    await cp(join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai", name, "lib/index.js"), join(target, "lib/index.js"));
  }
  patchWebTools(root);
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { root, fetch: modelFetch });
  return { root, Provider: DeepSeekSearchProvider, services: { env, readToken: async () => identity, fetcher: async () => Response.json(apiResult()) } };
}

function virtualTime(t) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  return milliseconds => { now += milliseconds; t.mock.timers.tick(milliseconds); };
}

test("released provider validates all search budgets before registering", async t => {
  const f = await fixture(t);
  const api = await released("dsh-web-search-deepseek", { root: f.root });
  const defaults = api.Config({});
  const expected = { searchTotalTimeoutMs: 18000, searchApiTimeoutMs: 4000, searchFlashTimeoutMs: 12000, searchLunaReserveMs: 6000 };
  for (const [key, value] of Object.entries(expected)) assert.equal(defaults[key], value);
  let registrations = 0;
  const ctx = { environment: new Map(), get: () => undefined,
    web: { registerSearchProvider: () => { registrations++; } } };
  const apply = values => api.apply(ctx, Object.fromEntries(Object.entries({ ...defaults, ...values }).map(([key, value]) => [key, { get: () => value }])));
  for (const key of Object.keys(expected)) {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, 2147483648, "1000", null, undefined]) {
      assert.throws(() => apply({ [key]: invalid }), new RegExp(key));
    }
  }
  for (const values of [{ searchApiTimeoutMs: 18001 }, { searchFlashTimeoutMs: 18001 }, { searchLunaReserveMs: 18000 }]) {
    assert.throws(() => apply(values), /Search budgets/);
  }
  assert.equal(registrations, 0, "invalid configuration must fail before registering");
  apply({});
  assert.equal(registrations, 1);
});

test("released registration uses custom budgets and rereads volatile settings on the next search", async t => {
  const f = await fixture(t);
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  process.env.CRYSOUND_DS_TOOLS_BASE = env.CRYSOUND_DS_TOOLS_BASE;
  process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE = join(f.root, "identity");
  await writeFile(process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE, identity, { mode: 0o600 });
  t.after(() => { for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const tick = virtualTime(t), budgets = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", ms => { budgets.push(ms); return timeout(ms); });
  let began;
  let ready = new Promise(resolve => { began = resolve; });
  t.mock.method(globalThis, "fetch", async () => { began(); return new Promise(() => {}); });
  const api = await released("dsh-web-search-deepseek", { root: f.root, fetch: async (_url, init) => {
    if (JSON.parse(init.body).model.includes("flash")) { began(); return new Promise(() => {}); }
    return Response.json(native);
  } });
  const values = { ...api.Config({}), ...options, searchTotalTimeoutMs: 9000,
    searchApiTimeoutMs: 1000, searchFlashTimeoutMs: 5000, searchLunaReserveMs: 3000 };
  let provider;
  api.apply({ environment: new Map(), get: () => undefined,
    web: { registerSearchProvider: value => { provider = value; } } },
  Object.fromEntries(Object.keys(values).map(key => [key, { get: () => values[key] }])));
  const run = async (apiMs, flashMs) => {
    ready = new Promise(resolve => { began = resolve; });
    const pending = provider.search({ query: "杭州天气" });
    await ready;
    ready = new Promise(resolve => { began = resolve; }); tick(apiMs);
    await ready; tick(flashMs);
    assert.equal((await pending).sources[0].title, "备用天气");
  };
  await run(1000, 5000);
  assert.deepEqual(budgets, [1000, 5000, 3000]);
  Object.assign(values, { searchTotalTimeoutMs: 7000, searchApiTimeoutMs: 500,
    searchFlashTimeoutMs: 4000, searchLunaReserveMs: 2500 });
  budgets.length = 0;
  await run(500, 4000);
  assert.deepEqual(budgets, [500, 4000, 2500]);
  values.searchTotalTimeoutMs = 0;
  assert.throws(() => provider.search({ query: "杭州天气" }), /searchTotalTimeoutMs/);
});

test("API returns bounded per-source summaries, dates and links with no model call", async t => {
  const f = await fixture(t, async () => { assert.fail("API success must not call a model"); });
  const calls = [];
  f.services.fetcher = async (url, init) => { calls.push({ url, init }); return Response.json(apiResult()); };
  const query = "😀".repeat(130);
  const result = await searchWithFallback(f.Provider, WebError, options, { query }, undefined, 12000, f.services);
  assert.equal(result.content, "");
  assert.equal(result.sources.length, 10);
  assert.equal(result.sources[0].publishedAt, "2026-11-07");
  assert.equal(result.sources[0].summary.length, 800);
  assert.ok(result.sources[0].summary.endsWith("…"));
  assert.equal(calls[0].url, env.CRYSOUND_DS_TOOLS_BASE + "search");
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: "😀".repeat(128), count: 10 });
  assert.equal(calls[0].init.headers.authorization, `Bearer ${identity}`);
  assert.equal(calls[0].init.redirect, "error");
  assert.doesNotMatch(JSON.stringify(calls), /model-only-key/);
});

test("actual released tool runs one API request per query concurrently and renders citeable sources", async t => {
  const f = await fixture(t);
  const calls = [], releases = [];
  t.mock.method(globalThis, "fetch", (url, init) => new Promise(resolve => {
    calls.push(JSON.parse(init.body));
    assert.equal(url, env.CRYSOUND_DS_TOOLS_BASE + "search");
    releases.push(() => resolve(Response.json(apiResult())));
    if (releases.length === 2) releases.forEach(release => release());
  }));
  const oldBase = process.env.CRYSOUND_DS_TOOLS_BASE, oldFile = process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE;
  process.env.CRYSOUND_DS_TOOLS_BASE = env.CRYSOUND_DS_TOOLS_BASE;
  const { writeFile } = await import("node:fs/promises");
  process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE = join(f.root, "identity");
  await writeFile(process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE, identity, { mode: 0o600 });
  t.after(() => {
    if (oldBase === undefined) delete process.env.CRYSOUND_DS_TOOLS_BASE; else process.env.CRYSOUND_DS_TOOLS_BASE = oldBase;
    if (oldFile === undefined) delete process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE; else process.env.CRYSOUND_DS_TOOLS_TOKEN_FILE = oldFile;
  });
  const providerAPI = await released("dsh-web-search-deepseek", { root: f.root });
  let registered;
  providerAPI.apply({ environment: new Map(), get: name => name === "environment" ? new Map() : undefined, effect: operation => operation(), web: { registerSearchProvider: value => { registered = value; return () => {}; } } }, Object.fromEntries(Object.entries(providerAPI.Config({})).map(([key, value]) => [key, { get: () => value }])));
  const tools = await released("dsh-tool-web", { root: f.root });
  const registeredTools = [];
  tools.apply({ tools: { register: value => registeredTools.push(value) }, systemPrompt: { section() {}, getSectionOrder() { return 0; } }, web: { search: (...args) => registered.search(...args) } }, tools.Config({}));
  const tool = registeredTools.find(value => value.name === "web_search");
  const result = await tool.execute({ queries: ["杭州天气", "上海天气"] }, { signal: new AbortController().signal });
  assert.deepEqual(calls.map(value => value.query).sort(), ["杭州天气", "上海天气"].sort());
  const rendered = tool.output.render({}, result)[0].text;
  assert.match(rendered, /https:\/\/weather.example\/0/);
  assert.match(rendered, /杭州晴/);
  assert.match(rendered, /2026-11-07/);
});

test("English API and Exa requests overlap, merge sources and retain both timing reports", async t => {
  const f = await fixture(t, async () => { assert.fail("API success must not call a model"); });
  const calls = [], releases = [], metrics = [];
  f.services.env = { ...env, CRYSOUND_MARKET_ORIGIN: "http://fixture-gateway", CRYSOUND_MARKET_TOKEN_FILE: "/fixture/identity" };
  f.services.fetcher = (url, init) => new Promise(resolve => {
    const api = String(url) === env.CRYSOUND_DS_TOOLS_BASE + "search";
    calls.push(api ? "api" : "exa");
    if (!api) {
      assert.match(String(url), /\/_zp\/treg\/call\/treg.web.search$/);
      assert.equal(init.headers["X-Treg-Route-Max-Cost"], "0.01");
    }
    releases.push(() => resolve(Response.json(api ? apiResult() : { output: { results: [
      { url: "https://official.example/release", title: "Official release", publishedDate: "2026-11-07", summary: "Current release" },
    ] } })));
    if (releases.length === 2) releases.forEach(release => release());
  });
  const record = (stage, extra) => metrics.push({ stage, ...extra, callId: "combined", name: "web_search" });
  const result = await searchWithFallback(f.Provider, WebError, { ...options, recordSearch: record, recordExa: record },
    { query: "latest stable Rust release", maxResults: 10 }, undefined, 12000, f.services);
  assert.deepEqual(calls.sort(), ["api", "exa"]);
  assert.equal(result.content, "");
  assert.equal(result.sources.length, 10);
  assert.equal(result.sources[0].url, "https://official.example/release");
  assert.equal(result.sources[1].url, "https://weather.example/0");
  const report = timingReport(metrics)[0];
  assert.deepEqual(report.searchPhases.map(phase => [phase.provider, phase.won]), [["search-api", true]]);
  assert.equal(report.exa.calls, 1);
  assert.equal(report.exa.adopted, true);
});

test("short configured total also bounds stalled English supplement", async t => {
  const f = await fixture(t);
  const tick = virtualTime(t);
  let exaStarted, primaryFinished;
  const exaReady = new Promise(resolve => { exaStarted = resolve; });
  const primaryReady = new Promise(resolve => { primaryFinished = resolve; });
  f.services.env = { ...env, CRYSOUND_MARKET_ORIGIN: "http://fixture-gateway", CRYSOUND_MARKET_TOKEN_FILE: "/fixture/identity" };
  f.services.fetcher = async url => {
    if (String(url).endsWith("/ds-tools/search")) return Response.json(apiResult());
    exaStarted(); return new Promise(() => {});
  };
  const pending = searchWithFallback(f.Provider, WebError, { ...options,
    searchBudget: { searchTotalTimeoutMs: 1000, searchApiTimeoutMs: 500, searchFlashTimeoutMs: 500, searchLunaReserveMs: 200 },
    recordSearch: stage => { if (stage === "search-phase-end") primaryFinished(); },
  }, { query: "latest stable Rust release" }, undefined, undefined, f.services);
  await Promise.all([exaReady, primaryReady]); tick(1000);
  assert.equal((await pending).sources[0].url, "https://weather.example/0");
});

test("missing gateway, disabled gateway, invalid identity and unsafe gateway go straight to Flash", async t => {
  const calls = [];
  const f = await fixture(t, async (_url, init) => { calls.push(JSON.parse(init.body).model); return Response.json(native); });
  for (const mode of ["missing", "disabled", "missing-key", "identity", "unsafe"]) {
    let dispatched = 0;
    const services = { ...f.services, env: mode === "missing" ? {} : mode === "unsafe" ? { ...env, CRYSOUND_DS_TOOLS_BASE: "https://untrusted.example/_zp/ds-tools/" } : env,
      readToken: async () => mode === "identity" ? "" : identity,
      fetcher: async () => { dispatched++; return new Response(null, { status: 503 }); } };
    await searchWithFallback(f.Provider, WebError, options, { query: "杭州天气" }, undefined, 12000, services);
    assert.equal(dispatched, ["disabled", "missing-key"].includes(mode) ? 1 : 0);
  }
  assert.deepEqual(calls, Array(5).fill("deepseek/deepseek-flash"));
});

test("HTTP, network, malformed and empty API responses fall back through Flash to Luna", async t => {
  const calls = [];
  const f = await fixture(t, async (_url, init) => {
    const model = JSON.parse(init.body).model; calls.push(model);
    return model.includes("flash") ? new Response(null, { status: 502 }) : Response.json(native);
  });
  for (const mode of ["http", "network", "json", "empty", "row", "url"]) {
    f.services.fetcher = async () => {
      if (mode === "http") return new Response(null, { status: 429 });
      if (mode === "network") throw new TypeError("network failed");
      if (mode === "json") return new Response("bad json");
      if (mode === "empty") return Response.json({ results: [] });
      const result = apiResult();
      if (mode === "row") delete result.results[0].summary;
      if (mode === "url") result.results[0].url = "file:///private";
      return Response.json(result);
    };
    const result = await searchWithFallback(f.Provider, WebError, options, { query: "杭州天气" }, undefined, 12000, f.services);
    assert.equal(result.sources[0].title, "备用天气");
  }
  assert.deepEqual(calls, Array(6).fill(["deepseek/deepseek-flash", "codex/gpt-6-luna"]).flat());
});

test("four-second API timeout leaves eight seconds for Flash and six for Luna", async t => {
  const f = await fixture(t);
  const tick = virtualTime(t), phases = [];
  let apiStarted, flashStarted, lunaStarted;
  const apiReady = new Promise(resolve => { apiStarted = resolve; });
  const flashReady = new Promise(resolve => { flashStarted = resolve; });
  const lunaReady = new Promise(resolve => { lunaStarted = resolve; });
  f.services.fetcher = async () => { apiStarted(); return new Promise(() => {}); };
  const api = await released("dsh-web-search-deepseek", { root: f.root, fetch: async (_url, init) => {
    if (JSON.parse(init.body).model.includes("flash")) { flashStarted(); return new Promise(() => {}); }
    return new Promise(resolve => { setTimeout(() => resolve(Response.json(native)), 5200); lunaStarted(); });
  } });
  const pending = searchWithFallback(api.DeepSeekSearchProvider, WebError, { ...options, recordSearch: (stage, extra) => phases.push({ stage, ...extra }) }, { query: "杭州天气" }, undefined, 12000, f.services);
  await apiReady; tick(4000);
  await flashReady; tick(8000);
  await lunaReady; tick(5200);
  assert.equal((await pending).sources[0].title, "备用天气");
  assert.deepEqual(phases.filter(value => value.stage === "search-phase-start").map(value => value.budgetMs), [4000, 8000, 6000]);
  assert.deepEqual(phases.filter(value => value.stage === "search-phase-end").map(value => [value.status, value.won]), [["timeout", false], ["timeout", false], ["success", true]]);
});

test("all stalled stages stop at eighteen seconds including a stalled API body", async t => {
  let start;
  const f = await fixture(t, async () => { start(); return new Promise(() => {}); });
  const tick = virtualTime(t), phases = [];
  let ready = new Promise(resolve => { start = resolve; });
  f.services.fetcher = async () => ({ ok: true, json: async () => { start(); return new Promise(() => {}); } });
  const pending = searchWithFallback(f.Provider, WebError, { ...options, recordSearch: (stage, extra) => { phases.push({ stage, ...extra }); } }, { query: "杭州天气" }, undefined, 12000, f.services);
  const rejected = assert.rejects(pending, error => error.code === "WEB_PROVIDER_ERROR" && error.cause.errors.length === 3);
  await ready;
  ready = new Promise(resolve => { start = resolve; }); tick(4000); await ready;
  ready = new Promise(resolve => { start = resolve; }); tick(8000); await ready;
  tick(6000); await rejected;
  assert.equal(phases.filter(value => value.stage === "search-phase-end").reduce((sum, value) => sum + value.durationMs, 0), 18000);
});

test("cancelled API and late identity reads never dispatch a fallback or late paid request", async t => {
  const f = await fixture(t, async () => { assert.fail("cancelled API must not call a model"); });
  let read;
  f.services.readToken = () => new Promise(resolve => { read = resolve; });
  const stop = new AbortController();
  const pending = searchWithFallback(f.Provider, WebError, options, { query: "杭州天气" }, stop.signal, 12000, f.services);
  stop.abort(new Error("user stopped"));
  await assert.rejects(pending, /user stopped/);
  let calls = 0;
  f.services.fetcher = async () => { calls++; return Response.json(apiResult()); };
  read(identity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("identity timeout starts Flash and a late identity read cannot send a paid request", async t => {
  let read, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t);
  const tick = virtualTime(t);
  let calls = 0;
  f.services.readToken = () => { started(); return new Promise(resolve => { read = resolve; }); };
  f.services.fetcher = async () => { calls++; return Response.json(apiResult()); };
  const pending = searchWithFallback(f.Provider, WebError, options, { query: "杭州天气" }, undefined, 12000, f.services);
  await ready; tick(4000);
  assert.equal((await pending).sources[0].title, "备用天气");
  read(identity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("timing report records each provider duration and winner without question or identity", async t => {
  let now = 0, modelCalls = 0;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, async () => {
    now += ++modelCalls === 1 ? 30 : 40;
    return modelCalls === 1 ? new Response(null, { status: 502 }) : Response.json(native);
  });
  f.services.fetcher = async () => { now += 20; return new Response(null, { status: 503 }); };
  const log = join(f.root, "timing.jsonl");
  toolTiming.open(log);
  const attempt = toolTiming.attempt("fixture", 1, 1, "attempt");
  attempt.chunk({ type: "block-end", block: { type: "tool-call", id: "call", name: "web_search" } });
  await attempt.execute(() => toolTiming.dispatch({ callId: "call" }, async () => {
    await searchWithFallback(f.Provider, WebError, { ...options, recordSearch: (stage, extra) => toolTiming.search(stage, extra) }, { query: "private question" }, undefined, 12000, f.services);
    return { result: {} };
  }));
  attempt.flush();
  const bytes = await readFile(log, "utf8");
  assert.doesNotMatch(bytes, /private question|model-only-key|zpd\.|weather\.example/);
  const records = bytes.trim().split("\n").map(JSON.parse);
  const report = timingReport(records)[0];
  assert.deepEqual(report.searchPhases, [
    { provider: "search-api", status: "failed", won: false, durationMs: 20 },
    { provider: "flash", status: "failed", won: false, durationMs: 30 },
    { provider: "luna", status: "success", won: true, durationMs: 40 },
  ]);
  assert.equal(report.durationsMs.executeToFirstSearch, 0);
  assert.equal(report.durationsMs.firstSearchToResult, 90);
  const apiOnly = timingReport(records.filter(record => !record.stage.startsWith("search-request-")))[0];
  assert.ok(!apiOnly.missing.includes("search-request-record"));
});
