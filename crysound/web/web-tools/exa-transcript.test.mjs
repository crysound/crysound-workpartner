// Recorded model-facing output and Session replay for the company image adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { patchWebTools } from "./patch.mjs";
import { searchWithFallback } from "./search.mjs";
import { released, WebError } from "./release-fixture.mjs";

const releaseRoot = process.env.DSH_WEB_TOOLS_RELEASE_ROOT;
const sessionRoot = process.env.DSH_SESSION_RELEASE_ROOT ?? releaseRoot;
const require = createRequire(join(sessionRoot, "fixture.cjs"));
const { Session, SessionId } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session")).href);
const options = { baseURL: "https://model.example/v1", apiKey: "fake-key", model: "deepseek/deepseek-flash", apiVersion: "2023-06-01", maxTokens: 100, maxUses: 1 };
const primaryResponse = { content: [
  { type: "web_search_tool_result", content: [
    { type: "web_search_result", url: "https://official.example/release#primary", title: "Original source" },
    { type: "web_search_result", url: "https://other.example/", title: "Other source" },
  ] },
  { type: "text", text: "Primary answer.", citations: [
    { url: "https://official.example/release#primary", cited_text: "Primary excerpt." },
  ] },
] };
const exaRows = [
  { url: "https://undated.example/", title: "Undated", summary: "Undated excerpt." },
  { url: "https://official.example/release#exa", title: "Official release", publishedDate: "2026-10-01", highlights: ["New fixture", "release."] },
];

for (const scenario of ["enriched", "unavailable", "chinese"]) {
  test(`recorded web_search ${scenario} output and card survive persisted Session replay`, async t => {
    const root = await mkdtemp(join(tmpdir(), "partner-exa-transcript-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["dsh-tool-web", "dsh-web-fetch-http", "dsh-web-search-deepseek"]) {
      const target = join(root, "@deepseek-ai", name);
      await mkdir(join(target, "lib"), { recursive: true });
      for (const file of ["package.json", "lib/index.js"]) await cp(join(releaseRoot, "@deepseek-ai", name, file), join(target, file));
    }
    patchWebTools(root);
    const search = await released("dsh-web-search-deepseek", { root, fetch: async () => Response.json(primaryResponse) });
    const tools = await released("dsh-tool-web", { root });
    let exaCalls = 0;
    const auxiliary = {
      env: { CRYSOUND_MARKET_ORIGIN: "https://gateway.example", CRYSOUND_MARKET_TOKEN_FILE: "/fake/identity" },
      readToken: async () => "fake-token",
      fetcher: async () => {
        exaCalls++;
        return scenario === "unavailable" ? new Response("quota", { status: 429 }) : Response.json({ output: { results: exaRows } });
      },
    };
    const registered = [];
    const context = {
      tools: { register: tool => registered.push(tool) },
      systemPrompt: { section() {}, getSectionOrder: () => 0 },
      web: { search: (request, signal) => searchWithFallback(search.DeepSeekSearchProvider, WebError, options, request, signal, 12000, auxiliary) },
    };
    tools.apply(context, tools.Config({ searchMaxResults: 2 }));
    const tool = registered.find(tool => tool.name === "web_search");
    const args = { queries: [scenario === "chinese" ? "杭州天气" : "latest fixture release"] };
    const value = await tool.execute(args, { signal: new AbortController().signal });
    const message = {
      role: "tool", source: { kind: "tool", callId: "search-1" }, toolCallId: "search-1",
      content: tool.output.render(args, value), isError: false, id: "result-1",
    };
    const meta = tool.output.presentationMeta(args, value);
    // VM-owned values cross the same JSON boundary as actual persistence.
    const data = JSON.parse(JSON.stringify({ turn: 1, step: 1, message, meta }));
    const session = Session.create(SessionId(`exa-${scenario}`));
    const argumentsJson = JSON.stringify(args);
    const assistant = session.append("assistant/message", { turn: 1, step: 1, stream: [], message: {
      role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture" }, id: "assistant-1",
      content: [{ type: "tool-call", id: "search-1", name: "web_search", arguments: argumentsJson }],
    } }, { surfaceOp: "append" });
    const call = session.append("tool/call", { turn: 1, step: 1, callId: "search-1", name: "web_search", arguments: argumentsJson });
    const event = session.append("tool/result", data, { surfaceOp: "append", sourceEventSeqs: [assistant.seq] });
    const recorded = { header: { ...session.header, createdAt: 0 }, events: [assistant, call, event].map(entry => ({ ...entry, time: 0 })) };
    const expected = JSON.parse(await readFile(new URL(`./tests/expected/exa-${scenario}.session.json`, import.meta.url), "utf8"));
    assert.deepEqual(recorded, expected, "complete rendered text, source/date metadata and truncation match the recorded oracle");
    const file = join(root, "session.json");
    await writeFile(file, JSON.stringify(recorded));
    const persisted = JSON.parse(await readFile(file, "utf8"));
    const restored = Session.create(SessionId(persisted.header.id), persisted.events, persisted.header);
    const oracle = Session.create(SessionId(expected.header.id), expected.events, expected.header);
    assert.deepEqual(restored.deriveMessages(), oracle.deriveMessages());
    assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
    const liveCard = tool.presentResult(args, { content: message.content, isError: false, meta });
    const replayArgs = JSON.parse(persisted.events.find(entry => entry.type === "tool/call").data.arguments);
    const replayedMessage = restored.deriveMessages().find(entry => entry.role === "tool");
    const replayCard = tool.presentResult(replayArgs, { content: replayedMessage.content, isError: false,
      meta: persisted.events.find(entry => entry.type === "tool/result").data.meta });
    assert.equal(JSON.stringify(replayCard), JSON.stringify(liveCard));
    assert.equal(exaCalls, scenario === "chinese" ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(recorded), /fake-key|fake-token/);
  });
}
