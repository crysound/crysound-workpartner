import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { summarizeFetch } from "./summary.mjs";
import { gzipSync, deflateSync, brotliCompressSync, constants } from "node:zlib";
import { once } from "node:events";
import { isPublicAddress, publicTarget, publicRequest, USER_AGENT, LANGUAGE } from "./network.mjs";
import { companyFetcher, followPublic, loginPage, needsRendering } from "./fetch.mjs";
import { searchWithFallback } from "./search.mjs";
import { patchWebTools } from "./patch.mjs";
import { released, WebError } from "./release-fixture.mjs";

const limits = { maxResponseBytes: 500_000, maxBodyChars: 100_000, timeoutMs: 5000, maxRedirects: 5, userAgent: "unused" };
const html = text => new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
const content = "国内网页正文测试。".repeat(60);
const shell = '<html><head></head><body><main id="app"></main><script src="/app.js"></script></body></html>';
const searchResult = { content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example/item", title: "新闻" }] }] };
const options = { baseURL: "https://model.example/v1", model: "deepseek/deepseek-flash", apiKey: "fixture-key", apiVersion: "2023-06-01", maxTokens: 4096, maxUses: 5 };

async function server(t, handle) {
  const instance = http.createServer(handle);
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return `http://127.0.0.1:${instance.address().port}`;
}

function fixtureRequest(origin, observed = [], maxResponseBytes = limits.maxResponseBytes) {
  return (url, signal) => publicRequest(url, signal, {}, async () => [{ address: "8.8.8.8", family: 4 }], (destination, config, done) => {
    observed.push({ url: destination.href, headers: config.headers });
    config.lookup(destination.hostname, { all: true }, (error, records) => {
      assert.ifError(error);
      assert.deepEqual(records, [{ address: "8.8.8.8", family: 4 }]);
    });
    // Only this fixture maps the checked public destination to its ephemeral loopback server.
    return http.request(new URL(destination.pathname + destination.search, origin), { ...config, lookup: undefined }, done);
  }, maxResponseBytes);
}

test("only public IPs pass, including alternate IPv4 and IPv6 encodings", async () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://[::ffff:7f00:1]/", "file:///etc/passwd", "http://user:pass@example.com/"]) await assert.rejects(publicTarget(url), { code: "WEB_BLOCKED_URL" });
  await assert.rejects(publicTarget("https://mixed.example/", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]), { code: "WEB_BLOCKED_URL" });
});

test("cross-origin redirects recheck the destination and stop after five hops", async () => {
  const visited = [];
  const request = async url => {
    await publicTarget(url, async () => [{ address: "8.8.8.8", family: 4 }]);
    visited.push(url);
    return visited.length === 1 ? new Response(null, { status: 301, headers: { location: "https://www.example.com/page" } }) : html(content);
  };
  const result = await followPublic("http://example.com/", undefined, request);
  assert.equal(result.url, "https://www.example.com/page");
  assert.equal(visited.length, 2);
  for (const target of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/"]) {
    const requests = [];
    await assert.rejects(followPublic("https://example.com/", undefined, async url => {
      await publicTarget(url, async () => [{ address: "8.8.8.8", family: 4 }]);
      requests.push(url);
      return new Response(null, { status: 302, headers: { location: target } });
    }), { code: "WEB_BLOCKED_URL" });
    assert.equal(requests.length, 1, "blocked before opening a private socket");
  }
  let hops = 0;
  await assert.rejects(followPublic("https://example.com/", undefined, async () => {
    hops++; return new Response(null, { status: 302, headers: { location: "/loop" } });
  }), { code: "WEB_REDIRECT_BLOCKED" });
  assert.equal(hops, 6);
});

test("real HTTP transport sends browser headers and uses the checked DNS answer", async t => {
  let seen;
  const origin = await server(t, (req, res) => { seen = req.headers; res.end(content); });
  const response = await fixtureRequest(origin)("http://public.example/", AbortSignal.timeout(5000));
  assert.equal(await response.text(), content);
  assert.equal(seen["user-agent"], USER_AGENT);
  assert.equal(seen["accept-language"], LANGUAGE);
  assert.equal(seen.cookie, undefined);
  assert.equal(seen.authorization, undefined);
  const controller = new AbortController();
  const pending = publicRequest("https://slow-dns.example", controller.signal, {}, () => new Promise(() => {}));
  controller.abort(new Error("cancelled DNS"));
  await assert.rejects(pending, /cancelled DNS/);
});

test("Baidu HTTPS returns a title and body through the real public transport", { skip: !process.env.PARTNER_TEST_LIVE_FETCH, timeout: 45000 }, async () => {
  const { HttpFetchProvider, Config } = await released("dsh-web-fetch-http");
  const config = Config({});
  const result = await companyFetcher(HttpFetchProvider, WebError, config).fetch({ url: "https://www.baidu.com/" });
  assert.equal(result.statusCode, 200);
  assert.match(result.body.content, /百度一下，你就知道/);
  assert.match(result.body.content, /新闻|贴吧|学术/);
  assert.ok(result.body.content.length <= config.maxBodyChars);
});

test("compressed responses decode before text extraction and unsupported encodings fail", async t => {
  const encodings = ["gzip", "deflate", "br", "gzip, br"];
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const origin = await server(t, (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/slow") {
      res.setHeader("content-encoding", "gzip");
      res.on("close", closed);
      res.write(gzipSync(Buffer.from(content)).subarray(0, 10));
      return;
    }
    if (req.url === "/broken") { res.setHeader("content-encoding", "gzip"); res.end("invalid gzip data"); return; }
    const encoding = decodeURIComponent(req.url.slice(1));
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-encoding", encoding);
    const bytes = Buffer.from(content);
    switch (encoding) {
      case "gzip": res.end(gzipSync(bytes)); break;
      case "deflate": res.end(deflateSync(bytes)); break;
      case "br": res.end(brotliCompressSync(bytes)); break;
      case "gzip, br": res.end(brotliCompressSync(gzipSync(bytes))); break;
      default: res.end("unsupported payload");
    }
  });
  const { HttpFetchProvider } = await released("dsh-web-fetch-http");
  const fetcher = companyFetcher(HttpFetchProvider, WebError, limits, { request: fixtureRequest(origin) });
  for (const encoding of encodings) {
    const result = await fetcher.fetch({ url: `https://public.example/${encoding}` });
    assert.equal(result.body.content, content, encoding);
  }
  for (const name of ["unknown", "constructor", "__proto__"]) await assert.rejects(fetcher.fetch({ url: `https://public.example/${name}` }), { code: "WEB_UNSUPPORTED_CONTENT_TYPE" });
  await assert.rejects(fetcher.fetch({ url: "https://public.example/broken" }), { code: "WEB_PROVIDER_ERROR" });
  await assert.rejects(fetcher.fetch({ url: "https://public.example/gzip,gzip,gzip" }), { code: "WEB_UNSUPPORTED_CONTENT_TYPE" });
  const controller = new AbortController();
  const pendingBody = await fixtureRequest(origin)("https://public.example/slow", controller.signal);
  const reading = pendingBody.text();
  controller.abort();
  await assert.rejects(reading);
  await connectionClosed;
  const small = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxResponseBytes: 128 }, { request: fixtureRequest(origin) });
  const truncated = await small.fetch({ url: "https://public.example/gzip" });
  assert.equal(truncated.truncated, true, "the decoded body cap remains active");
  assert.ok(truncated.body.content.length < content.length);
  const wireCap = companyFetcher(HttpFetchProvider, WebError, limits, { request: fixtureRequest(origin, [], 16) });
  await assert.rejects(wireCap.fetch({ url: "https://public.example/gzip" }), { code: "WEB_FETCH_TOO_LARGE" });
});

test("fallback always tries Luna then DeepSeek on HTTP, network, empty-tool and timeout failures", async t => {
  const root = await patchedRelease(t);
  for (const failure of ["http", "network", "missing", "timeout"]) {
    const calls = [], logs = [];
    const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body).model);
      if (calls.length > 1) return Response.json(searchResult);
      if (failure === "http") return new Response("bad gateway", { status: 502 });
      if (failure === "network") throw new TypeError("network down");
      if (failure === "missing") return Response.json({ content: [{ type: "text", text: "   " }] });
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    } });
    // Keep Node alive while the timeout under test fires (AbortSignal timers are unref'ed).
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const result = await searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, recordRequest: entry => logs.push(entry) }, { query: "新闻" }, undefined, 20);
      assert.equal(result.sources[0].title, "新闻");
      assert.deepEqual(calls, ["codex/gpt-6-luna", "deepseek/deepseek-flash"]);
      assert.deepEqual(logs.map(entry => entry.body.model), calls);
    } finally { clearInterval(keepAlive); }
  }
});

test("default search attempts stop at seven seconds before falling back", async t => {
  const root = await patchedRelease(t);
  const budgets = [], calls = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", milliseconds => { budgets.push(milliseconds); return timeout(10); });
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body).model);
    if (calls.length === 2) return Response.json(searchResult);
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await searchWithFallback(DeepSeekSearchProvider, WebError, options, { query: "新闻" });
    assert.equal(result.sources.length, 1);
    assert.deepEqual(calls, ["codex/gpt-6-luna", "deepseek/deepseek-flash"]);
    assert.deepEqual(budgets, [7000, 7000]);
  } finally { clearInterval(keepAlive); }
});

test("search does not retry caller cancellation, missing credentials or a failed request log", async () => {
  let calls = 0;
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { fetch: async () => { calls++; return Response.json(searchResult); } });
  const signal = AbortSignal.abort(new Error("user stopped"));
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, options, { query: "q" }, signal));
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, apiKey: undefined }, { query: "q" }), { code: "WEB_PROVIDER_CREDENTIAL_MISSING" });
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, recordRequest: () => { throw new Error("log unavailable"); } }, { query: "q" }), /log unavailable/);
  assert.equal(calls, 0);
});

test("both failed searches produce one structured error after exactly two attempts", async () => {
  let calls = 0;
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { fetch: async () => { calls++; return new Response(null, { status: 503 }); } });
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, options, { query: "q" }), error => error.code === "WEB_PROVIDER_ERROR" && error.cause.errors.length === 2);
  assert.equal(calls, 2);
});

test("released search returns bounded answer text with citations or without source blocks", async t => {
  const root = await patchedRelease(t);
  for (const mode of ["linked", "empty-results", "text-only", "short", "emoji"]) {
    const answer = mode === "short" ? "杭州今天晴。" : mode === "emoji" ? "证".repeat(798) + "😀尾" : "杭州今天晴，最高气温 22℃。" + "证".repeat(900);
    const excerpt = "杭州晴，22℃" + "证".repeat(900);
    const blocks = mode === "text-only" ? [] : [
      { type: "text", text: "Searching now; this is not the answer." },
      { type: "web_search_tool_result", content: mode === "linked" ? searchResult.content[0].content : [] },
    ];
    blocks.push({ type: "text", text: answer, citations: mode === "linked" ? [{ url: "https://news.example/item", cited_text: excerpt }] : [] });
    const api = await released("dsh-web-search-deepseek", { root, fetch: async () => Response.json({ content: blocks }) });
    const result = await searchWithFallback(api.DeepSeekSearchProvider, WebError, options, { query: "杭州天气" });
    if (mode === "short") assert.equal(result.content, answer);
    else if (mode === "emoji") assert.equal(result.content, "证".repeat(798) + "…");
    else {
      assert.equal(result.content.length, 800);
      assert.ok(result.content.endsWith("…"));
      assert.ok(result.content.startsWith("杭州今天晴"));
    }
    assert.equal(result.sources.length, mode === "linked" ? 1 : 0);
    if (mode === "linked") {
      assert.equal(result.sources[0].url, "https://news.example/item");
      assert.equal(result.sources[0].summary, excerpt.slice(0, 799) + "…");
    }
    const tools = await released("dsh-tool-web", { root });
    const registered = [];
    tools.apply({ tools: { register: tool => registered.push(tool) }, systemPrompt: { section() {}, getSectionOrder() { return 0; } }, web: { search: async () => result } }, tools.Config({}));
    const tool = registered.find(tool => tool.name === "web_search");
    const value = await tool.execute({ queries: ["杭州天气"] }, { signal: new AbortController().signal });
    const rendered = tool.output.render({}, value)[0].text;
    assert.ok(rendered.includes(result.content));
    assert.doesNotMatch(rendered, /Searching now|No results found/);
    assert.equal(tool.output.presentationMeta({}, value).answer, result.content);
    if (mode === "linked") assert.match(rendered, /https:\/\/news.example\/item/);
  }
});

test("released search dispatches after credentials and logging without a timer or extra model turn", { timeout: 5000 }, async t => {
  const root = await patchedRelease(t);
  const events = [];
  const api = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => {
    events.push("http:" + JSON.parse(init.body).model);
    return Response.json(searchResult);
  } });
  let provider;
  api.apply({
    web: { registerSearchProvider: value => { provider = value; } },
    get: name => name === "credentials" ? { resolve: async () => { events.push("credential"); return { value: "fixture-key" }; } }
      : name === "agents" ? { currentInitiator: () => ({ session: {
        requestContext: () => ({ provider: "magpie" }),
        append: () => events.push("request-log"),
      } }) } : undefined,
  }, Object.fromEntries(Object.entries({ ...options, apiKey: undefined, apiKeyEnv: "DEEPSEEK_API_KEY" }).map(([key, value]) => [key, { get: () => value }])));
  // No clock advance: an introduced sleep/debounce would prevent dispatch and fail this test.
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  await provider.search({ query: "杭州天气" });
  assert.deepEqual(events, ["credential", "request-log", "http:codex/gpt-6-luna"]);
});

test("login URLs and HTML are explicit failures; static articles need no browser", async () => {
  for (const url of ["https://example.com/signin", "https://example.com/passport/login", "https://example.com/oauth/authorize"]) assert.equal(loginPage(url), true);
  assert.equal(loginPage("https://example.com/news", "<title>请登录</title>"), true);
  assert.equal(loginPage("https://example.com/news", '<input type="password">'), true);
  assert.equal(needsRendering(shell), true);
  assert.equal(needsRendering(`<script>${"ignored".repeat(1000)}</script><style>${"ignored".repeat(1000)}</style><main>短内容</main>`), true);
  assert.equal(needsRendering(`<script>ignored</script><main>${content}</main>`), false);
  assert.equal(needsRendering(`<article>${content}</article><script src="/tracking.js"></script>`), false);
  const { HttpFetchProvider } = await released("dsh-web-fetch-http");
  let browserLoads = 0;
  const fetcher = companyFetcher(HttpFetchProvider, WebError, limits, { request: async () => html(content), loadRuntime: () => { browserLoads++; throw new Error("should not load"); } });
  const result = await fetcher.fetch({ url: "https://example.com/news" });
  assert.equal(result.body.content, content);
  assert.equal(browserLoads, 0);
  const login = companyFetcher(HttpFetchProvider, WebError, limits, { request: async () => html('<input type="password">') });
  await assert.rejects(login.fetch({ url: "https://example.com/news" }), /需要登录，无法抓取/);
  const redirected = companyFetcher(HttpFetchProvider, WebError, limits, { request: async () => new Response(null, { status: 302, headers: { location: "/signin" } }) });
  await assert.rejects(redirected.fetch({ url: "https://example.com/news" }), /需要登录，无法抓取/);
});

test("fetch byte/character limits and timeout/cancellation stay structured", async t => {
  const { HttpFetchProvider } = await released("dsh-web-fetch-http");
  const bounded = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxBodyChars: 12 }, { request: async () => html(content) });
  const truncated = await bounded.fetch({ url: "https://example.com/news" });
  assert.equal(truncated.body.content.length, 12);
  assert.equal(truncated.truncated, true);
  const tooLarge = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxResponseBytes: 12 }, { request: async () => new Response(content, { headers: { "content-type": "text/html", "content-length": Buffer.byteLength(content) } }) });
  const prefix = await tooLarge.fetch({ url: "https://example.com/news" });
  assert.equal(prefix.body.content, "国内网页");
  assert.equal(prefix.truncated, true);
  const origin = await server(t, (req, res) => { /* Hold the response until the caller's deadline closes the socket. */ });
  const timeout = companyFetcher(HttpFetchProvider, WebError, { ...limits, timeoutMs: 20 }, { request: fixtureRequest(origin) });
  await assert.rejects(timeout.fetch({ url: "https://example.com/news" }), { code: "WEB_FETCH_TIMEOUT" });
  const controller = new AbortController();
  const cancelled = timeout.fetch({ url: "https://example.com/news" }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { code: "WEB_ABORTED" });
});

test("large HTML retains its title and article after a large head, with bounded streamed prefixes", { timeout: 15000 }, async t => {
  const { HttpFetchProvider } = await released("dsh-web-fetch-http");
  const article = `<title>大页面标题</title><main>${content}</main>`;
  const largeHead = `<style>${".unused{}".repeat(40_000)}</style><script>${"/* ignored */".repeat(30_000)}</script>`;
  const hidden = `<textarea style="display: none !important">${"ignored CSS".repeat(20_000)}</textarea>`;
  const visible = '<textarea title="not hidden" aria-hidden="false">visible input text <style>literal CSS</style></textarea>';
  const page = `<html><head><!-- ${largeHead} -->${largeHead}</head><body>${hidden}${article}${visible}</body></html>`;
  const closed = new Map(["/declared", "/chunked", "/compressed"].map(path => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return [path, { promise, resolve }];
  }));
  const origin = await server(t, (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/large-head") return res.end(page);
    res.on("close", () => closed.get(req.url).resolve());
    if (req.url === "/declared") res.setHeader("content-length", 10_000_000);
    if (req.url === "/compressed") res.setHeader("content-encoding", "gzip");
    const text = article + "文".repeat(10_000);
    res.write(req.url === "/compressed" ? gzipSync(text, { finishFlush: constants.Z_SYNC_FLUSH }) : text);
    // The response intentionally remains open: a bounded read must close its socket.
  });
  const fetcher = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxResponseBytes: 2_000_000 }, { request: fixtureRequest(origin) });
  const result = await fetcher.fetch({ url: "https://public.example/large-head" });
  assert.ok(result.body.content.includes("<title>大页面标题</title>"));
  assert.ok(result.body.content.includes(content));
  assert.ok(result.body.content.includes(visible));
  assert.equal(result.body.content.includes("ignored"), false);
  assert.equal(result.truncated, false, "removing scripts and styles does not discard readable text");
  const small = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxResponseBytes: 2048 }, { request: fixtureRequest(origin) });
  for (const path of ["/declared", "/chunked", "/compressed"]) {
    const value = await small.fetch({ url: `https://public.example${path}` });
    assert.equal(value.truncated, true, path);
    assert.ok(value.body.content.includes("大页面标题"), path);
    assert.ok(value.body.content.includes(content), path);
    assert.equal(value.body.content, Buffer.from(article + "文".repeat(10_000)).subarray(0, 2048).toString("utf8"), path);
    await closed.get(path).promise;
  }
  for (const length of [2048, 2049]) {
    const exact = companyFetcher(HttpFetchProvider, WebError, { ...limits, maxResponseBytes: 2048 }, { request: async () => new Response("x".repeat(length), { headers: { "content-type": "text/plain", "content-length": length } }) });
    const value = await exact.fetch({ url: "https://example.com/text" });
    assert.equal(value.body.content.length, 2048);
    assert.equal(value.truncated, length > 2048);
  }
});

test("patches apply to the pinned artifacts, repeat identically, and reject upstream drift", async t => {
  const root = await mkdtemp(join(tmpdir(), "partner-web-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "@deepseek-ai"));
  for (const name of ["dsh-tool-web", "dsh-web-fetch-http", "dsh-web-search-deepseek"]) {
    const source = join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai", name);
    const target = join(root, "@deepseek-ai", name);
    await mkdir(join(target, "lib"), { recursive: true });
    await cp(join(source, "package.json"), join(target, "package.json"), { dereference: true });
    await cp(join(source, "lib/index.js"), join(target, "lib/index.js"), { dereference: true });
  }
  const file = join(root, "@deepseek-ai/dsh-web-search-deepseek/lib/index.js");
  const predecessor = await readFile(file, "utf8");
  const oldCall = 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), ctx.get("agents")?.currentInitiator()?.model.current()?.model, request, signal)';
  const originalCall = 'search: (request, signal) => provider.search(request, signal)';
  const currentCall = 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), request, signal)';
  const importLine = 'import { searchWithFallback } from "./crysound-search.mjs";\n';
  assert.equal([originalCall, oldCall, currentCall].filter(call => predecessor.includes(call)).length, 1);
  const native = predecessor.replace(importLine, '').replace(oldCall, originalCall).replace(currentCall, originalCall);
  await writeFile(file, native);
  patchWebTools(root);
  const fromNative = await readFile(file, "utf8");
  await writeFile(file, importLine + native.replace(originalCall, oldCall));
  patchWebTools(root);
  assert.equal(await readFile(file, "utf8"), fromNative, "native and previous company artifacts converge");
  const tools = await released("dsh-tool-web", { root });
  const registered = [];
  tools.apply({ tools: { register: tool => registered.push(tool) }, systemPrompt: { section() {}, getSectionOrder() { return 0; } } }, tools.Config({}));
  assert.equal(registered.find(tool => tool.name === "web_search").timeoutMs, 18000, "two seven-second attempts fit in the real tool deadline");
  assert.equal(registered.find(tool => tool.name === "web_fetch").timeoutMs, 45000);
  const toolFile = join(root, "@deepseek-ai/dsh-tool-web/lib/index.js");
  const currentTool = await readFile(toolFile, "utf8");
  await writeFile(toolFile, currentTool.replace('searchTimeoutMs: z.number().default(18_000)', 'searchTimeoutMs: z.number().default(65_000)'));
  patchWebTools(root);
  assert.equal(await readFile(toolFile, "utf8"), currentTool, "previous company deadline migrates to the current deadline");
  const before = await readFile(file, "utf8");
  patchWebTools(root);
  assert.equal(await readFile(file, "utf8"), before);
  const api = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => Response.json(searchResult) });
  let provider, selected = "claude-sonnet-4-5";
  const log = [];
  api.apply({ web: { registerSearchProvider: value => { provider = value; } }, get: name => name === "agents" ? { currentInitiator: () => ({ model: { current: () => ({ model: selected }) }, session: { requestContext: () => ({}), append: (_event, entry) => log.push(entry.body.model) } }) } : undefined }, Object.fromEntries(Object.entries({ ...options, apiKeyEnv: "DEEPSEEK_API_KEY" }).map(([key, value]) => [key, { get: () => value }])));
  await provider.search({ query: "q" });
  selected = "deepseek/chat";
  await provider.search({ query: "q" });
  assert.deepEqual(log, ["codex/gpt-6-luna", "codex/gpt-6-luna"]);
  const fetchApi = await released("dsh-web-fetch-http", { root });
  let fetcher;
  const context = { web: { registerFetchProvider: value => { fetcher = value; } } };
  const defaults = fetchApi.Config(limits);
  assert.equal(defaults.renderConcurrency, 1);
  assert.equal(defaults.renderTimeoutMs, 15000);
  fetchApi.apply(context, defaults);
  for (const invalid of [0, -1, 1.5, NaN, "2", null]) assert.throws(() => fetchApi.apply(context, { ...defaults, renderConcurrency: invalid }), /renderConcurrency/);
  for (const invalid of [0, -1, 1.5, NaN, 2147483648, "15000", null]) assert.throws(() => fetchApi.apply(context, { ...defaults, renderTimeoutMs: invalid }), /renderTimeoutMs/);
  fetchApi.apply(context, fetchApi.Config({ ...limits, renderConcurrency: 2, renderTimeoutMs: 750 }));
  await assert.rejects(fetcher.fetch({ url: "http://127.0.0.1/" }), { code: "WEB_BLOCKED_URL" });
  await writeFile(file, before.replace('search: (request, signal) => searchWithFallback', 'search: (input, signal) => searchWithFallback'));
  assert.throws(() => patchWebTools(root), /did not match/);
});

// Real Chromium exercises JS execution, intercepted subresources and browser cleanup.
// Supply an already installed Playwright; this test never installs or downloads anything.
test("Chromium renders JS through checked requests, blocks private resources and closes on timeout", { skip: !process.env.PARTNER_TEST_PLAYWRIGHT }, async t => {
  const { chromium } = await import(process.env.PARTNER_TEST_PLAYWRIGHT);
  const { HttpFetchProvider } = await released("dsh-web-fetch-http");
  const origin = await server(t, (req, res) => {
    res.setHeader("content-encoding", "gzip");
    const end = body => res.end(gzipSync(Buffer.from(body)));
    if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); return end(`document.getElementById('app').textContent=${JSON.stringify(content)};fetch('http://127.0.0.1/private').catch(()=>{});`); }
    res.setHeader("content-type", "text/html");
    if (req.url === "/needs-login") return end('<html><head></head><body><script>location.href="/signin"</script></body></html>');
    if (req.url === "/private-navigation") return end('<html><head></head><body><script>location.href="http://169.254.169.254/latest"</script></body></html>');
    end(shell);
  });
  const observed = [], browsers = [];
  const runtime = { launchPinnedChromium: async options => {
    const browser = await chromium.launch({ ...options, executablePath: process.env.PARTNER_TEST_CHROMIUM || "/usr/bin/chromium", headless: true });
    browsers.push(browser);
    return browser;
  } };
  const fetcher = companyFetcher(HttpFetchProvider, WebError, limits, { request: fixtureRequest(origin, observed), loadRuntime: async () => runtime });
  const result = await fetcher.fetch({ url: "https://public.example/news" });
  assert.ok(result.body.content.includes(content));
  assert.equal(observed.some(entry => entry.url.includes("127.0.0.1")), false);
  assert.ok(observed.some(entry => entry.url.endsWith("/app.js")));
  assert.ok(browsers.every(browser => !browser.isConnected()));
  await assert.rejects(fetcher.fetch({ url: "https://public.example/needs-login" }), /需要登录，无法抓取/);
  await assert.rejects(fetcher.fetch({ url: "https://public.example/private-navigation" }), { code: "WEB_BLOCKED_URL" });
  assert.ok(browsers.every(browser => !browser.isConnected()));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const serial = companyFetcher(HttpFetchProvider, WebError, limits, { request: fixtureRequest(origin), loadRuntime: () => { enter(); return gate; } });
  const first = serial.fetch({ url: "https://public.example/news" });
  try {
    await entered;
    await assert.rejects(serial.fetch({ url: "https://public.example/news" }), /网页渲染正忙/);
  } finally { release(runtime); await first; }
  assert.ok((await serial.fetch({ url: "https://public.example/news" })).body.content.includes(content), "slot released after completion");
  const timeout = companyFetcher(HttpFetchProvider, WebError, limits, { request: fixtureRequest(origin), loadRuntime: async () => runtime, renderTimeoutMs: 1 });
  await assert.rejects(timeout.fetch({ url: "https://public.example/news" }), { code: "WEB_PROVIDER_ERROR" });
  assert.ok(browsers.every(browser => !browser.isConnected()));
});

async function patchedRelease(t) {
  const root = await mkdtemp(join(tmpdir(), "partner-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["dsh-tool-web", "dsh-web-fetch-http", "dsh-web-search-deepseek"]) {
    const source = join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai", name);
    const target = join(root, "@deepseek-ai", name);
    await mkdir(join(target, "lib"), { recursive: true });
    for (const file of ["package.json", "lib/index.js"]) await cp(join(source, file), join(target, file), { dereference: true });
  }
  patchWebTools(root);
  return root;
}

async function summaryTool(t, config = {}, request = async () => Response.json({ content: [{ type: "text", text: '收入增长 12%，原句：“2026 年收入 1.2 亿元”。' }] }), { resolveKey = async () => ({ value: "fixture-summary-key" }), record = () => {} } = {}) {
  const root = await patchedRelease(t);
  const api = await released("dsh-tool-web", { root, fetch: request });
  const registered = [];
  const result = { url: "https://public.example/final", statusCode: 200, body: { kind: "html", content: '<h1>年度数据</h1><p>2026 年收入 1.2 亿元，同比增长 12%。</p>' + '<p>无关内容。</p>'.repeat(10000) }, truncated: false };
  const ctx = {
    tools: { register: tool => registered.push(tool) },
    systemPrompt: { section() {}, getSectionOrder() { return 0; } },
    web: { fetch: async (_args, signal) => { signal?.throwIfAborted(); return result; } },
    environment: new Map([["DEEPSEEK_BASE_URL", { value: "https://company.example/v1" }]]),
    get: name => name === "credentials" ? { resolve: resolveKey } : name === "agents" ? { currentInitiator: () => ({ session: { append: record } }) } : undefined,
  };
  api.apply(ctx, api.Config({ fetchMaxOutputChars: 40000, ...config }));
  const tool = registered.find(tool => tool.name === "web_fetch");
  return { tool, result, ctx, api };
}

test("released web_fetch accepts a question, sends bounded Markdown to company model and returns only a cited summary", async t => {
  const calls = [], records = [];
  const { tool, result } = await summaryTool(t, {}, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ content: [{ type: "text", text: '收入增长 12%，原句：“2026 年收入 1.2 亿元”。' }] });
  }, { record: (type, data) => records.push({ type, data }) });
  assert.equal(tool.parameters.prompt.type, "string");
  assert.notEqual(tool.parameters.prompt.required, true);
  assert.equal(tool.timeoutMs, 45000);
  const args = { url: "https://public.example/original", prompt: "收入是多少，同比增长多少？" };
  const value = await tool.execute(args, {});
  const text = tool.output.render(args, value)[0].text;
  assert.match(text, /1\.2 亿元/);
  assert.match(text, /12%/);
  assert.match(text, /https:\/\/public.example\/original/);
  assert.match(text, /https:\/\/public.example\/final/);
  assert.doesNotMatch(text, /无关内容/);
  assert.ok(text.length < 1000);
  assert.equal(result.body.kind, "html", "original result is not mutated");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://company.example/v1/messages");
  assert.equal(calls[0].init.headers.authorization, "Bearer fixture-summary-key");
  assert.equal(calls[0].init.redirect, "error");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "deepseek/deepseek-flash");
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.tools, undefined, "summarization must not perform another search");
  assert.match(body.messages[0].content[0].text, /收入是多少/);
  assert.match(body.messages[0].content[0].text, /年度数据/);
  assert.doesNotMatch(body.messages[0].content[0].text, /<h1>/);
  const extracted = JSON.parse(body.messages[0].content[0].text.split("\n").slice(1).join("\n"));
  assert.ok(extracted.page.length <= 40000);
  assert.match(extracted.page, /Content truncated/);
  assert.equal(tool.output.presentationMeta(args, value).truncated, true);
  assert.deepEqual(records, [{ type: "plugin:crysound/web-summary-request", data: { endpoint: calls[0].url, apiVersion: "2023-06-01", body } }]);
  assert.doesNotMatch(JSON.stringify(records), /fixture-summary-key/);
  assert.equal(tool.output.presentationMeta(args, value).url, result.url);
});

test("missing/blank questions and disabled summaries preserve the original result and do not request credentials or models", async t => {
  for (const [config, prompt] of [[{}, undefined], [{}, "  "], [{ fetchSummary: false }, "收入？"]]) {
    const { tool, result } = await summaryTool(t, config, () => assert.fail("unexpected model request"), { resolveKey: () => assert.fail("unexpected credential request") });
    const value = await tool.execute({ url: result.url, ...(prompt === undefined ? {} : { prompt }) }, {});
    assert.equal(value.body.content, result.body.content);
    assert.equal(value.body.kind, "html");
    if (config.fetchSummary === false) assert.equal(tool.timeoutMs, 30000);
  }
});

test("model/credential/log failures, malformed or empty responses fall back byte-for-byte to bounded page output", async t => {
  for (const failure of ["http", "network", "json", "empty", "schema", "credentials", "log"]) {
    let calls = 0;
    const { tool, result } = await summaryTool(t, {}, async () => {
      calls++;
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "network") throw new Error("offline");
      if (failure === "json") return new Response("bad json");
      return Response.json(failure === "schema" ? { content: "bad content" } : { content: [] });
    }, { resolveKey: async () => { if (failure === "credentials") throw new Error("locked"); return { value: "fake" }; }, record: () => { if (failure === "log") throw new Error("log unavailable"); } });
    const value = await tool.execute({ url: result.url, prompt: "收入？" }, {});
    assert.equal(tool.output.render({}, value)[0].text, tool.output.render({}, result)[0].text, failure);
    assert.equal(calls, ["credentials", "log"].includes(failure) ? 0 : 1);
  }
});

test("the default 15-second summary deadline aborts the request and returns raw output; caller cancellation throws", { timeout: 5000 }, async t => {
  const calls = [];
  let entered;
  let dispatched = new Promise(resolve => { entered = resolve; });
  const { tool, result } = await summaryTool(t, {}, async (_url, init) => {
    calls.push(init);
    entered();
    await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = tool.execute({ url: result.url, prompt: "收入？" }, {});
  // Advance only after dispatch; the mock transport is the readiness signal.
  await dispatched;
  t.mock.timers.tick(15000);
  const value = await pending;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(tool.output.render({}, value)[0].text, tool.output.render({}, result)[0].text);
  const stop = new AbortController();
  dispatched = new Promise(resolve => { entered = resolve; });
  const cancelled = tool.execute({ url: result.url, prompt: "收入？" }, { signal: stop.signal });
  await dispatched;
  stop.abort(new Error("本人取消"));
  await assert.rejects(cancelled, /本人取消/);
  assert.equal(calls[1].signal.aborted, true);
});

test("slow credential resolution cannot dispatch after the summary deadline", async t => {
  let ready, finish;
  const started = new Promise(resolve => { ready = resolve; });
  const credentials = new Promise(resolve => { finish = resolve; });
  const { tool, result } = await summaryTool(t, {}, () => assert.fail("late request"), { resolveKey: () => { ready(); return credentials; } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = tool.execute({ url: result.url, prompt: "收入？" }, {});
  await started;
  t.mock.timers.tick(15000);
  assert.equal((await pending).body.content, result.body.content);
  finish({ value: "fake" });
  await new Promise(resolve => setImmediate(resolve));
});

test("summary model, endpoint and token budget follow config; invalid settings reject registration", async t => {
  let sent;
  const { tool, result, api, ctx } = await summaryTool(t, { fetchSummaryModel: "codex/gpt-6.1-sol", fetchSummaryBaseURL: "https://alternate.example/v1/", fetchSummaryMaxTokens: 900 }, async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return Response.json({ content: [{ type: "text", text: "收入 1.2 亿元" }] });
  });
  await tool.execute({ url: result.url, prompt: "收入？" }, {});
  assert.equal(sent.url, "https://alternate.example/v1/messages");
  assert.equal(sent.body.model, "codex/gpt-6.1-sol");
  assert.equal(sent.body.max_tokens, 900);
  for (const config of [{ fetchSummaryModel: "" }, { fetchSummary: "yes" }, { fetchSummaryTimeoutMs: 0 }, { fetchSummaryMaxTokens: 0 }, { fetchSummaryBaseURL: "file:///tmp/test" }]) assert.throws(() => api.apply(ctx, api.Config(config)));
  await assert.rejects(tool.execute({ url: result.url, prompt: 123 }, {}), /prompt/);
});

test("patched tool imports through real release dependencies and auxiliary requests survive a real Session replay", async t => {
  const root = await patchedRelease(t);
  await symlink(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, join(root, "node_modules"), "dir");
  const api = await import(pathToFileURL(join(root, "@deepseek-ai/dsh-tool-web/lib/index.js")).href);
  const searchApi = await import(pathToFileURL(join(root, "@deepseek-ai/dsh-web-search-deepseek/lib/index.js")).href);
  assert.equal(new searchApi.DeepSeekSearchProvider(() => options).available(), true);
  const require = createRequire(join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT, "@deepseek-ai/dsh-web-search-deepseek/lib/index.js"));
  const { Session, SessionId, appendPluginRecord } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session")).href);
  const { credentialRef } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-credentials")).href);
  const session = Session.create(SessionId("summary-fixture"));
  const config = api.Config({ fetchSummaryBaseURL: "https://company.example/v1" });
  let sent;
  const result = { url: "https://public.example/page", statusCode: 200, body: { kind: "text", content: "2026 年收入 1.2 亿元。" }, truncated: false };
  const value = await summarizeFetch({ get: name => name === "agents" ? { currentInitiator: () => ({ session }) } : undefined }, config,
    "收入？", result.url, result, value => ({ text: api.formatFetchOutput(value, 40000), truncated: false }), undefined, {
      credentialRef, appendPluginRecord,
      launchEnvironmentOf: () => new Map([["DEEPSEEK_API_KEY", { value: "fake-key" }]]),
      request: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ content: [{ type: "text", text: "收入 1.2 亿元。" }] }); },
    });
  assert.match(value.body.content, /Question-focused page summary/);
  const restored = Session.create(SessionId("replayed-summary"), JSON.parse(JSON.stringify(session.snapshotEvents())));
  const record = restored.snapshotEvents().find(event => event.type === "plugin:crysound/web-summary-request");
  assert.equal(record.ignorable, true);
  assert.deepEqual(record.data.body, sent);
  assert.doesNotMatch(JSON.stringify(record), /fake-key/);
});

test("summary length follows the configured output budget and retains trailing caveats when they fit", async t => {
  const caveat = "仅适用于完成校准的设备，不含未校准样本。";
  const summary = "证".repeat(6500) + caveat;
  for (const cap of [40000, 4000]) {
    const { tool, result } = await summaryTool(t, { fetchMaxOutputChars: cap, fetchSummaryMaxTokens: 5000 }, async () => Response.json({ content: [{ type: "text", text: summary }] }));
    result.body.content = "已校准设备数据。";
    const args = { url: result.url, prompt: "结果及适用条件？" };
    const value = await tool.execute(args, {});
    const output = tool.output.render(args, value)[0].text;
    assert.ok(output.length <= cap);
    if (cap === 40000) {
      assert.ok(output.includes(caveat), "the evidence caveat must survive within the deployment's output budget");
      assert.equal(tool.output.presentationMeta(args, value).truncated, false);
    } else {
      assert.equal(output.length, cap);
      assert.match(output, /Content truncated/);
      assert.equal(tool.output.presentationMeta(args, value).truncated, true);
    }
  }
});
