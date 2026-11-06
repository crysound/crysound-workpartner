import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
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

function fixtureRequest(origin, observed = []) {
  return (url, signal) => publicRequest(url, signal, {}, async () => [{ address: "8.8.8.8", family: 4 }], (destination, config, done) => {
    observed.push({ url: destination.href, headers: config.headers });
    config.lookup(destination.hostname, { all: true }, (error, records) => {
      assert.ifError(error);
      assert.deepEqual(records, [{ address: "8.8.8.8", family: 4 }]);
    });
    // Only this fixture maps the checked public destination to its ephemeral loopback server.
    return http.request(new URL(destination.pathname + destination.search, origin), { ...config, lookup: undefined }, done);
  });
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

test("search follows each session and falls back on HTTP, network, empty-tool and timeout failures", async t => {
  for (const selected of ["codex/gpt-6.1-terra", "deepseek/chat", undefined]) for (const failure of ["http", "network", "missing", "timeout"]) {
    const calls = [], logs = [];
    const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body).model);
      if (calls.length > 1) return Response.json(searchResult);
      if (failure === "http") return new Response("bad gateway", { status: 502 });
      if (failure === "network") throw new TypeError("network down");
      if (failure === "missing") return Response.json({ content: [{ type: "text", text: "No native search" }] });
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    } });
    // Keep Node alive while the timeout under test fires (AbortSignal timers are unref'ed).
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const result = await searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, recordRequest: entry => logs.push(entry) }, selected, { query: "新闻" }, undefined, 20);
      assert.equal(result.sources[0].title, "新闻");
      const gptFirst = selected === undefined || selected.startsWith("codex/");
      assert.deepEqual(calls, gptFirst ? ["codex/gpt-6.1-sol", "deepseek/deepseek-flash"] : ["deepseek/deepseek-flash", "codex/gpt-6.1-sol"]);
      assert.deepEqual(logs.map(entry => entry.body.model), calls);
    } finally { clearInterval(keepAlive); }
  }
});

test("search does not retry caller cancellation, missing credentials or a failed request log", async () => {
  let calls = 0;
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { fetch: async () => { calls++; return Response.json(searchResult); } });
  const signal = AbortSignal.abort(new Error("user stopped"));
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, options, "codex/test", { query: "q" }, signal));
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, apiKey: undefined }, "codex/test", { query: "q" }), { code: "WEB_PROVIDER_CREDENTIAL_MISSING" });
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, { ...options, recordRequest: () => { throw new Error("log unavailable"); } }, "codex/test", { query: "q" }), /log unavailable/);
  assert.equal(calls, 0);
});

test("both failed searches produce one structured error after exactly two attempts", async () => {
  let calls = 0;
  const { DeepSeekSearchProvider } = await released("dsh-web-search-deepseek", { fetch: async () => { calls++; return new Response(null, { status: 503 }); } });
  await assert.rejects(searchWithFallback(DeepSeekSearchProvider, WebError, options, "codex/test", { query: "q" }), error => error.code === "WEB_PROVIDER_ERROR" && error.cause.errors.length === 2);
  assert.equal(calls, 2);
});

test("login URLs and HTML are explicit failures; static articles need no browser", async () => {
  for (const url of ["https://example.com/signin", "https://example.com/passport/login", "https://example.com/oauth/authorize"]) assert.equal(loginPage(url), true);
  assert.equal(loginPage("https://example.com/news", "<title>请登录</title>"), true);
  assert.equal(loginPage("https://example.com/news", '<input type="password">'), true);
  assert.equal(needsRendering(shell), true);
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
  await assert.rejects(tooLarge.fetch({ url: "https://example.com/news" }), { code: "WEB_FETCH_TOO_LARGE" });
  const origin = await server(t, (req, res) => { /* Hold the response until the caller's deadline closes the socket. */ });
  const timeout = companyFetcher(HttpFetchProvider, WebError, { ...limits, timeoutMs: 20 }, { request: fixtureRequest(origin) });
  await assert.rejects(timeout.fetch({ url: "https://example.com/news" }), { code: "WEB_FETCH_TIMEOUT" });
  const controller = new AbortController();
  const cancelled = timeout.fetch({ url: "https://example.com/news" }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { code: "WEB_ABORTED" });
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
  patchWebTools(root);
  const tools = await released("dsh-tool-web", { root });
  const registered = [];
  tools.apply({ tools: { register: tool => registered.push(tool) }, systemPrompt: { section() {}, getSectionOrder() { return 0; } } }, tools.Config({}));
  assert.equal(registered.find(tool => tool.name === "web_search").timeoutMs, 65000, "two 30-second attempts fit in the real tool deadline");
  assert.equal(registered.find(tool => tool.name === "web_fetch").timeoutMs, 30000);
  const file = join(root, "@deepseek-ai/dsh-web-search-deepseek/lib/index.js");
  const before = await readFile(file, "utf8");
  patchWebTools(root);
  assert.equal(await readFile(file, "utf8"), before);
  const api = await released("dsh-web-search-deepseek", { root, fetch: async (_url, init) => Response.json(searchResult) });
  let provider, selected = "codex/gpt-6.1-terra";
  const log = [];
  api.apply({ web: { registerSearchProvider: value => { provider = value; } }, get: name => name === "agents" ? { currentInitiator: () => ({ model: { current: () => ({ model: selected }) }, session: { requestContext: () => ({}), append: (_event, entry) => log.push(entry.body.model) } }) } : undefined }, Object.fromEntries(Object.entries({ ...options, apiKeyEnv: "DEEPSEEK_API_KEY" }).map(([key, value]) => [key, { get: () => value }])));
  await provider.search({ query: "q" });
  selected = "deepseek/chat";
  await provider.search({ query: "q" });
  assert.deepEqual(log, ["codex/gpt-6.1-sol", "deepseek/deepseek-flash"]);
  const fetchApi = await released("dsh-web-fetch-http", { root });
  let fetcher;
  fetchApi.apply({ web: { registerFetchProvider: value => { fetcher = value; } } }, limits);
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
    if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); return res.end(`document.getElementById('app').textContent=${JSON.stringify(content)};fetch('http://127.0.0.1/private').catch(()=>{});`); }
    res.setHeader("content-type", "text/html");
    if (req.url === "/needs-login") return res.end('<html><head></head><body><script>location.href="/signin"</script></body></html>');
    if (req.url === "/private-navigation") return res.end('<html><head></head><body><script>location.href="http://169.254.169.254/latest"</script></body></html>');
    res.end(shell);
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
