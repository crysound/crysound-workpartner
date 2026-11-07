import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { instrumentTiming, checkTimingRuntime, timingTargets } from "./timing-patch.mjs";
import { toolTiming } from "./timing.mjs";
import { timingReport } from "./timing-report.mjs";
import { searchWithFallback, searchAnswer } from "./search.mjs";

const root = process.env.DSH_TOOL_TIMING_RELEASE_ROOT;
if (!root) throw new Error("Set DSH_TOOL_TIMING_RELEASE_ROOT to pinned release node_modules");
const source = name => readFileSync(join(root, "@deepseek-ai", name, "lib", name === "dsh-tools" ? "pipeline.js" : "index.js"), "utf8");
const stripImports = code => code.replace(/^import .*;\n/gmu, "");
class WebError extends Error {}
class ToolBatchExecutionError extends Error { constructor(cause, partial) { super("batch", { cause }); this.partial = partial; } }
const block = id => ({ type: "tool-call", id, name: "web_search", arguments: '{"query":"SECRET_PROMPT"}' });

// Run the actual published step and scheduler. Only surrounding host services,
// stream assembly and HTTP responses are fixtures; no dependencies are installed.
function runtime(timed, fetch) {
  const code = name => stripImports(timed ? instrumentTiming(`@deepseek-ai/${name}`, source(name)) : source(name));
  const providerCode = code("dsh-web-search-deepseek").split("//#endregion")[0];
  const Provider = runInNewContext(`${providerCode}\nDeepSeekSearchProvider`, { toolTiming, WebError, fetch, searchAnswer });
  const batchCode = code("dsh-tools").split("//#endregion")[0];
  const batch = runInNewContext(`${batchCode}\nexecuteToolBatch`, {
    toolTiming, ToolBatchExecutionError, TOOL_ABORTED_BEFORE_DISPATCH: "ABORTED",
    createToolResultMessage: value => value, assertNever: value => { throw new Error(String(value)); },
  });
  const agentCode = code("dsh-agent-loop");
  const method = agentCode.slice(agentCode.indexOf("\tasync step(decision) {"), agentCode.indexOf("\t/** Resolve request config"));
  class AssistantStreamAttempt {
    content = []; stream = []; finish = { kind: "stop" }; attemptId;
    constructor(session, attempt) { this.attemptId = `${session}:${attempt}`; }
    start() {}
    push(chunk) { this.stream.push(chunk); if (chunk.type === "block-end") this.content.push(chunk.block); if (chunk.type === "finish") this.finish = chunk.reason; }
    blocks() { return this.content; }
    interruptedBlocks() { return this.content; }
    settle(_type, append) { append(); this.ended = true; }
    abandon() { this.ended = true; }
  }
  const step = runInNewContext(`({${method}}).step`, {
    toolTiming, AssistantStreamAttempt, ToolBatchExecutionError, LlmError: WebError,
    createAssistantMessage: value => value, renderPrompt: () => "", renderContextSections: () => [],
    assembleContextFor: () => ({}), joinContextSections: () => "",
  });
  return { Provider, batch, step };
}

function agentHarness(runtime, { session = "fixture", stream, beforeAppend = () => {}, beforePrepare = () => {}, failAppend = false, failRecord = false } = {}) {
  const events = [];
  const agent = {
    id: session, phase: { kind: "running", turn: 1, step: 2, abort: new AbortController() },
    assistantAttemptCounter: 0, assistantStreamRevision: 0, requestSurfaceGeneration: 0,
    session: { id: session, surface: { contentGeneration: 0 }, append(type, data) {
      if (type === "assistant/message") { beforeAppend(); if (failAppend) throw new Error("append failed"); }
      if (type === "web/deepseek-search-llm-request" && failRecord) throw new Error("record failed");
      events.push({ type, data }); return { seq: events.length };
    } },
    prepareRequest: async () => ({ config: {}, preparedCall: { stream } }),
    runtimeContext: { project: () => undefined }, systemPrompt: { project: () => [] }, toolsChanged: () => false,
    buildRequest: () => ({ provider: "fixture", model: "fixture" }), dispatch: { emit() {}, waterfall: async () => undefined },
    inbox: { splice() {} }, loopCtx: {
      systemPrompt: { refreshContext() {} }, agentLoop: { config: { maxParallelToolCalls: { get: () => 2 } } },
      tools: { execute: input => runtime.batch(input, {
        executionMode: () => ({ kind: "parallel" }),
        prepare: async exec => { beforePrepare(); return { kind: "dispatch", exec }; },
        dispatch: async exec => {
          const result = await searchWithFallback(runtime.Provider, WebError, {
            baseURL: "https://fixture.example/v1", apiKey: "SECRET_KEY", apiVersion: "fixture", maxTokens: 10, maxUses: 1,
            recordRequest: value => agent.session.append("web/deepseek-search-llm-request", value),
            recordSearch: (stage, extra) => toolTiming.search(stage, extra),
          }, { query: "SECRET_PROMPT" }, exec.signal);
          return { kind: "post-result", result: { content: [{ type: "text", text: result.content }], isError: false } };
        },
        complete: async (_exec, outcome) => outcome.result,
      }, () => 2) },
    },
  };
  return { agent, events, run: () => runtime.step.call(agent, { assembly: { tools: [] }, messages: [], selection: {} }) };
}

function logFor(t) {
  const directory = mkdtempSync(join(tmpdir(), "partner-tool-timing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "timing.jsonl");
  toolTiming.open(file);
  return () => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("pinned artifacts match twice without changing bytes; upstream drift is rejected", () => {
  const before = timingTargets.map(target => readFileSync(join(root, target.package, "lib", target.file)));
  checkTimingRuntime(root); checkTimingRuntime(root);
  timingTargets.forEach((target, index) => assert.deepEqual(readFileSync(join(root, target.package, "lib", target.file)), before[index]));
  assert.throws(() => instrumentTiming("@deepseek-ai/dsh-agent-loop", source("dsh-agent-loop").replace("live.push(chunk)", "changed(chunk)")), /exactly once/);
  for (const target of timingTargets) {
    const code = instrumentTiming(target.package, readFileSync(join(root, target.package, "lib", target.file), "utf8"));
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test("actual published step separates stream tail, persistence, scheduling and two search attempts", async t => {
  const readLog = logFor(t);
  let now = 0, attempts = 0;
  t.mock.method(performance, "now", () => now);
  const instance = runtime(true, async () => { now += 20; if (++attempts === 1) return new Response("failure", { status: 502 }); return Response.json({ content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", title: "answer", url: "https://fixture.example/result" }] }] }); });
  const harness = agentHarness(instance, {
    stream: async function* () { yield { type: "block-end", block: block("call") }; now += 3000; yield { type: "finish", reason: { kind: "stop" } }; now += 100; },
    beforeAppend: () => { now += 7; }, beforePrepare: () => { now += 11; },
  });
  await harness.run();
  const records = readLog(), stage = name => records.find(record => record.stage === name).monotonicMs;
  assert.equal(stage("finish") - stage("block-end"), 3000);
  assert.equal(stage("stream-end") - stage("finish"), 100);
  assert.equal(stage("assistant-message-written") - stage("assistant-message-append-start"), 7);
  assert.equal(stage("tool-dispatch-start") - stage("tools-execute-start"), 11);
  assert.equal(stage("tool-result-returned") - stage("search-request-dispatch"), 40);
  assert.deepEqual(records.filter(record => record.stage === "search-request-dispatch").map(record => record.searchAttempt), [1, 2]);
  assert.ok(records.every(record => record.session === "fixture" && record.callId === "call" && record.attempt === "fixture:1"));
  assert.doesNotMatch(JSON.stringify(records), /SECRET|query|arguments|headers|endpoint|answer/);
  assert.equal(harness.events.filter(event => event.type === "web/deepseek-search-llm-request").length, 2);
  const report = timingReport(records)[0];
  assert.equal(report.durationsMs.blockToFinish, 3000);
  assert.equal(report.durationsMs.assistantAppend, 7);
  assert.deepEqual(report.missing, []);
  const incomplete = timingReport(records.filter(record => record.stage !== "search-request-record"))[0];
  assert.equal(incomplete.searchAttempts[0].recordToDispatchMs, null);
  assert.ok(incomplete.missing.includes("search-request-record"));
});

test("overlapping sessions and parallel calls retain their own identities and return times", async t => {
  const readLog = logFor(t);
  const instance = runtime(true, async () => { await new Promise(resolve => setImmediate(resolve)); return Response.json({ content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", title: "answer", url: "https://fixture.example/result" }] }] }); });
  const make = session => agentHarness(instance, { session, stream: async function* () {
    yield { type: "block-end", block: block(`${session}-1`) };
    yield { type: "block-end", block: block(`${session}-2`) };
    yield { type: "finish", reason: { kind: "stop" } };
  } });
  const a = make("a"), b = make("b");
  await Promise.all([a.run(), b.run()]);
  const logs = readLog();
  for (const session of ["a", "b"]) for (const callId of [`${session}-1`, `${session}-2`]) {
    const records = logs.filter(record => record.callId === callId);
    assert.ok(records.every(record => record.session === session));
    assert.equal(records.filter(record => record.stage === "search-request-dispatch").length, 1);
    assert.equal(records.filter(record => record.stage === "tool-result-returned").length, 1);
  }
});

test("failed append, interrupted stream and failed request log never claim later stages", async t => {
  const readLog = logFor(t);
  let dispatched = 0;
  const instance = runtime(true, async () => { dispatched++; return Response.json({ content: [] }); });
  const stream = async function* () { yield { type: "block-end", block: block("call") }; yield { type: "finish", reason: { kind: "stop" } }; };
  await assert.rejects(agentHarness(instance, { session: "append", stream, failAppend: true }).run(), /append failed/);
  await assert.rejects(agentHarness(instance, { session: "stream", stream: async function* () { yield { type: "block-end", block: block("call") }; throw new Error("stream failed"); } }).run(), /stream failed/);
  await assert.rejects(agentHarness(instance, { session: "record", stream, failRecord: true }).run());
  const logs = readLog();
  assert.equal(dispatched, 0);
  assert.ok(!logs.some(record => ["append", "stream"].includes(record.session) && record.stage === "tools-execute-start"));
  assert.ok(!logs.some(record => record.session === "append" && record.stage === "assistant-message-written"));
  assert.ok(!logs.some(record => record.session === "stream" && record.stage === "finish"));
  assert.ok(!logs.some(record => record.stage === "search-request-dispatch"));
  assert.equal(timingReport(logs).find(report => report.session === "append").durationsMs.appendToExecute, null);
});

test("original and enabled published loops retain identical business events and results", async t => {
  const readLog = logFor(t);
  const run = async timed => {
    const instance = runtime(timed, async () => Response.json({ content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", title: "answer", url: "https://fixture.example/result" }] }] }));
    const harness = agentHarness(instance, { stream: async function* () {
      yield { type: "block-end", block: block("call") };
      yield { type: "finish", reason: { kind: "stop" } };
    } });
    return JSON.stringify({ result: await harness.run(), events: harness.events });
  };
  const original = await run(false);
  assert.equal(readLog().length, 0);
  assert.equal(await run(true), original);
  assert.ok(readLog().length > 0);
});

test("disabled preload installs no transformer; enabled loader rejects an incompatible artifact", t => {
  const directory = mkdtempSync(join(tmpdir(), "partner-timing-loader-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pkg = join(directory, "node_modules/@deepseek-ai/dsh-agent-loop");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", version: "0.2.2-rc.1" }));
  writeFileSync(join(pkg, "lib/index.js"), "export const untouched = true;\n");
  const preload = new URL("./timing-hook.mjs", import.meta.url).pathname;
  const run = enabled => spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", `import { untouched } from ${JSON.stringify(join(pkg, "lib/index.js"))}; if (!untouched) process.exit(1);`], {
    encoding: "utf8", env: { ...process.env, CRYSOUND_TOOL_TIMING_LOG: enabled ? join(directory, "log.jsonl") : "" },
  });
  assert.equal(run(false).status, 0);
  const enabled = run(true);
  assert.notEqual(enabled.status, 0);
  assert.match(enabled.stderr, /Tool timing patch did not match exactly once/);
  // The actual published method can also be loaded through the enabled hook;
  // dependencies used by the method are supplied in the behavior fixtures above.
  const original = source("dsh-agent-loop");
  const method = original.slice(original.indexOf("\tasync step(decision) {"), original.indexOf("\t/** Resolve request config"));
  writeFileSync(join(pkg, "lib/index.js"), `export const untouched = typeof ({${method}}).step === "function";\n`);
  const compatible = run(true);
  assert.equal(compatible.status, 0, compatible.stderr);
});
