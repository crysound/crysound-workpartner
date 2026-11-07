import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWithFallback } from "./search.mjs";
import { patchWebTools } from "./patch.mjs";
import { released, WebError } from "./release-fixture.mjs";
import { toolTiming } from "./timing.mjs";
import { instrumentTiming } from "./timing-patch.mjs";
import { timingReport } from "./timing-report.mjs";

const primary = { content: "DeepSeek answer", sources: [{ url: "https://official.example/page#deepseek", summary: "old excerpt" }, { url: "https://other.example/" }], truncated: false };
const env = { CRYSOUND_MARKET_ORIGIN: "http://gateway.example", CRYSOUND_MARKET_TOKEN_FILE: "/fake/container-token" };
const options = { baseURL: "https://model.example/v1", apiKey: "fixture", model: "deepseek/deepseek-flash", apiVersion: "2023-06-01", maxTokens: 100, maxUses: 1 };
const rows = [{ url: "https://undated.example/", summary: "undated" },
  { url: "https://official.example/page#exa", title: "Official", publishedDate: "2026-11-07", highlights: ["new", "release"] }];
const services = fetcher => ({ env, readToken: async () => "fake-token\n", fetcher });
class Provider {
  constructor(options) { this.options = options; }
  async search() { this.options().recordRequest?.({}); return primary; }
}
const query = { query: "latest stable Rust release version", maxResults: 2 };
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function clock(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
    return controller.signal;
  });
}

test("English search starts both requests before either completes; dated Exa sources lead, dedupe and cap without changing answer", async () => {
  const calls = [], metrics = [];
  let finishPrimary, finishExa;
  class Slow extends Provider {
    search() { calls.push("primary"); return new Promise(resolve => { finishPrimary = () => resolve(primary); }); }
  }
  const pending = searchWithFallback(Slow, WebError, { ...options, recordExa: (stage, extra) => metrics.push({ stage, ...extra }) }, query, undefined, 12000,
    services(async (url, init) => {
      calls.push("exa");
      assert.equal(url.href, "http://gateway.example/_zp/treg/call/treg.web.search");
      assert.deepEqual(JSON.parse(init.body), { q: query.query, limit: 10 });
      assert.equal(init.headers.authorization, "Bearer fake-token");
      assert.equal(init.headers["X-Treg-Route-Prefer"], "exa");
      assert.equal(init.headers["X-Treg-Route-Waterfall"], "0");
      assert.equal(init.headers["X-Treg-Route-Max-Cost"], "0.01");
      assert.equal(init.redirect, "error");
      return new Promise(resolve => { finishExa = () => resolve(Response.json({ output: { results: rows } })); });
    }));
  await drain();
  assert.deepEqual(calls.sort(), ["exa", "primary"]);
  finishPrimary(); finishExa();
  const result = await pending;
  assert.equal(result.content, primary.content);
  assert.deepEqual(result.sources.map(s => s.url), [rows[1].url, rows[0].url]);
  assert.equal(result.sources[0].summary, "new release");
  assert.equal(result.sources[0].publishedAt, "2026-11-07");
  assert.equal(result.truncated, true);
  const report = timingReport(metrics.map(r => ({ ...r, callId: "search", name: "web_search" })))[0];
  assert.equal(report.exa.calls, 1); assert.equal(report.exa.adopted, true);
  assert.equal(report.exa.attempts[0].status, "ok");
  assert.equal(typeof report.exa.attempts[0].durationMs, "number");
  assert.doesNotMatch(JSON.stringify(metrics), /fake-token|latest stable/);
});

test("Chinese, mixed queries without an ASCII majority and missing container setup never call Exa", async () => {
  let extraCalls = 0;
  const extra = services(async () => { extraCalls++; throw new Error("unexpected"); });
  for (const q of ["杭州今天天气", "Rust 最新稳定版本是什么", "   ", "2026?"]) {
    assert.equal(await searchWithFallback(Provider, WebError, options, { query: q }, undefined, 12000, extra), primary);
  }
  assert.equal(await searchWithFallback(Provider, WebError, options, query, undefined, 12000, { ...extra, env: {} }), primary);
  assert.equal(extraCalls, 0);
});

test("HTTP errors, exhausted budget, malformed/empty responses and bad rows retain the exact primary result", async () => {
  for (const response of [() => new Response("unavailable", { status: 503 }), () => new Response("quota", { status: 429 }),
    () => { throw new Error("offline"); }, () => new Response("{bad"), () => Response.json({}),
    () => Response.json({ output: { results: [] } }),
    () => Response.json({ output: { results: [null, { url: "javascript:bad" }, { url: "https://name:password@example.com" }] } })]) {
    assert.equal(await searchWithFallback(Provider, WebError, options, query, undefined, 12000, services(response)), primary);
  }
  assert.equal(await searchWithFallback(Provider, WebError, options, query, undefined, 12000,
    { ...services(() => { throw new Error("must not dispatch"); }), readToken: async () => { throw new Error("missing identity"); } }), primary);
});

test("Exa deadline starts with the search, includes a stalled response body, and never adds five seconds after primary", async t => {
  clock(t);
  let finishPrimary;
  class Slow extends Provider { search() { return new Promise(resolve => { finishPrimary = () => resolve(primary); }); } }
  let exaSignal;
  const metrics = [];
  const pending = searchWithFallback(Slow, WebError, { ...options, recordExa: (stage, extra) => metrics.push({ stage, ...extra }) }, query, undefined, 12000,
    services(async (_url, init) => { exaSignal = init.signal; return { ok: true, json: () => new Promise(() => {}) }; }));
  await drain();
  t.mock.timers.tick(4000); finishPrimary(); await drain();
  let settled = false; pending.then(() => { settled = true; });
  await drain(); assert.equal(settled, false);
  t.mock.timers.tick(1000);
  assert.equal(await pending, primary);
  assert.equal(exaSignal.aborted, true);
  assert.equal(metrics.find(r => r.stage === "exa-request-finished").status, "timeout");
});

test("a primary slower than Exa's deadline returns immediately when ready; late credential reads never send a request", async t => {
  clock(t);
  let finishPrimary, finishRead, calls = 0;
  class Slow extends Provider { search() { return new Promise(resolve => { finishPrimary = () => resolve(primary); }); } }
  const pending = searchWithFallback(Slow, WebError, options, query, undefined, 12000,
    { env, readToken: () => new Promise(resolve => { finishRead = resolve; }), fetcher: async () => { calls++; } });
  await drain(); t.mock.timers.tick(6000); finishPrimary();
  assert.equal(await pending, primary);
  finishRead("late-token"); await drain(); assert.equal(calls, 0);
});

test("caller cancellation aborts both searches; terminal primary failure aborts Exa without waiting", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let exaSignal;
    class Failing extends Provider {
      async search(_request, signal) {
        await drain();
        if (cancel) controller.abort(new Error("caller cancelled"));
        signal?.throwIfAborted();
        throw new Error("credentials unavailable");
      }
    }
    await assert.rejects(searchWithFallback(Failing, WebError, options, query, controller.signal, 12000,
      services(async (_url, init) => { exaSignal = init.signal; return new Promise(() => {}); })),
    cancel ? /caller cancelled/ : /credentials unavailable/);
    assert.equal(exaSignal.aborted, true);
  }
});

test("actual patched release registration merges Exa with DeepSeek, preserves fallback, and is idempotent", async t => {
  const root = await mkdtemp(join(tmpdir(), "partner-exa-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "@deepseek-ai"));
  for (const name of ["dsh-tool-web", "dsh-web-fetch-http", "dsh-web-search-deepseek"]) {
    await cp(join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai", name), join(root, "@deepseek-ai", name), { recursive: true });
  }
  patchWebTools(root); patchWebTools(root);
  const tokenFile = join(root, "container-token"); await writeFile(tokenFile, "fixture-identity\n");
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.CRYSOUND_MARKET_TOKEN_FILE = tokenFile;
  process.env.CRYSOUND_MARKET_ORIGIN = "http://fixture-gateway";
  const models = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(url.href, /\/_zp\/treg\/call\/treg.web.search$/);
    assert.equal(init.headers.authorization, "Bearer fixture-identity");
    return Response.json({ output: { results: rows } });
  });
  const file = join(root, "@deepseek-ai/dsh-web-search-deepseek/lib/index.js");
  await writeFile(file, instrumentTiming("@deepseek-ai/dsh-web-search-deepseek", await readFile(file, "utf8")));
  const timingFile = join(root, "timing.jsonl"); toolTiming.open(timingFile);
  const api = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    if (models.length === 1) return new Response("failed", { status: 502 });
    return Response.json({ content: [{ type: "text", text: "Primary fallback answer" }] });
  } });
  let provider;
  api.apply({ web: { registerSearchProvider: value => { provider = value; } }, get: () => undefined },
    Object.fromEntries(Object.entries({ ...api.Config({}), ...options, apiKeyEnv: "DEEPSEEK_API_KEY" }).map(([key, value]) => [key, { get: () => value }])));
  const attempt = toolTiming.attempt("exa", 1, 1, "a");
  attempt.chunk({ type: "block-end", block: { type: "tool-call", id: "search", name: "web_search" } });
  const outcome = await attempt.execute(() => toolTiming.dispatch({ callId: "search" }, async () => ({ result: await provider.search(query) })));
  const result = outcome.result;
  attempt.flush();
  const records = (await readFile(timingFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const report = timingReport(records)[0];
  assert.equal(report.exa.calls, 1); assert.equal(report.exa.adopted, true);
  assert.equal(report.exa.attempts[0].status, "ok");
  assert.equal(records.filter(r => r.stage.startsWith("exa-")).every(r => r.session === "exa" && r.callId === "search"), true);
  assert.equal(result.content, "Primary fallback answer");
  assert.equal(result.sources[0].url, rows[1].url);
  assert.deepEqual(models, ["deepseek/deepseek-flash", "codex/gpt-6-luna"]);
});
