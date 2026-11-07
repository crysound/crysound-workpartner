import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createDsTools } from "../ds-tools.mjs";
import { issueToken, tokenUser } from "../market-auth.mjs";

const signingKey = "fixture-signing-key", paidKey = "fixture-paid-key";
const users = [{ unionId: "alice", slug: "alice" }, { unionId: "bob", slug: "bob" }];
const headers = user => ({ authorization: `Bearer ${issueToken(signingKey, user)}`, "content-type": "application/json" });

async function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-tools-")), stateFile = path.join(root, "ledger.json"), keyFile = path.join(root, "paid.key");
  fs.writeFileSync(keyFile, paidKey, { mode: 0o400 });
  let time = Date.parse("2026-11-07T12:00:00Z"), response = () => Response.json({ title: "公开页", content: "网页证据" });
  const calls = [], options = { stateFile, env: { DS_TOOLS_API_KEY_FILE: keyFile, ...env }, now: () => time,
    authenticate: req => tokenUser(req, signingKey, users),
    request: async (url, init) => { calls.push({ url, init }); return response(url, init); } };
  let handle = createDsTools(options);
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, "http://internal.test"))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { calls, stateFile, options, keyFile, origin,
    setTime: value => { time = value; }, setResponse: value => { response = value; }, restart: () => { handle = createDsTools(options); },
    call: async ({ route = "fetch", user = users[0], body = { url: "https://example.com/report" }, ...init } = {}) => {
      const result = await fetch(`${origin}/_zp/ds-tools/${route}`, { method: "POST", headers: headers(user), body: init.method === "GET" ? undefined : JSON.stringify(body), ...init });
      return { status: result.status, text: await result.text() };
    },
  };
}

test("only signed, unexpired provisioned identities can reach two exact internal POST routes", async t => {
  const f = await fixture(t);
  for (const authorization of ["", "Bearer fake", `Bearer ${issueToken("wrong", users[0])}`, `Bearer ${issueToken(signingKey, users[0], 0)}`, `Bearer ${issueToken(signingKey, { unionId: "stranger" })}`]) {
    assert.equal((await f.call({ headers: { authorization, cookie: "zp_sid=some-web-session" } })).status, 401);
  }
  for (const route of ["models", "fetch?x=1", "fetch/", "%66etch", "fetch/other"]) assert.equal((await f.call({ route })).status, 404);
  assert.equal((await f.call({ method: "GET", body: undefined })).status, 405);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call()).status, 200);
  assert.equal(f.calls[0].url, "https://api.deepseek.com/v1/tools/fetch");
  assert.deepEqual(f.calls[0].init.headers, { "content-type": "application/json", authorization: `Bearer ${paidKey}` });
  assert.equal(f.calls[0].init.redirect, "error");
  assert.equal(JSON.parse(f.calls[0].init.body).url, "https://example.com/report");
});

test("fetch/search validate bounded payloads, strip credentials and never forward other operations", async t => {
  const f = await fixture(t);
  for (const body of [{}, [], null, { url: "file:///etc/passwd" }, { url: "https://key:secret@example.com" }, { url: "https://example.com", key: "override" }, { url: "x".repeat(8193) }]) assert.equal((await f.call({ body })).status, 400);
  for (const body of [{ query: " " }, { query: "x".repeat(129) }, { query: "q", count: 51 }, { query: "q", need_content: "yes" }, { query: "q", endpoint: "/models" }, { query: "q", localization: "spoofed" }]) assert.equal((await f.call({ route: "search", body })).status, 400);
  assert.equal((await f.call({ body: { url: `https://example.com/${"a".repeat(20000)}` } })).status, 400);
  assert.equal(f.calls.length, 0);
  f.setResponse(() => Response.json({ results: [{ title: "标题", url: "https://example.com", snippet: "简述", summary: "摘要", content: "正文", debug_key: paidKey }], debug: paidKey }));
  const result = await f.call({ route: "search", body: { query: "杭州天气", count: 10, need_content: true, ori_question: "杭州今天几度？" }, headers: { ...headers(users[0]), cookie: "private", "x-api-key": "user-key" } });
  assert.equal(result.status, 200); assert.match(result.text, /杭州|摘要/); assert.doesNotMatch(result.text, /fixture-paid-key|debug/);
  assert.equal(f.calls[0].url, "https://api.deepseek.com/v1/tools/search");
});

test("durable per-person rate limits survive restart; identities and next minute are independent", async t => {
  const f = await fixture(t, { DS_TOOLS_USER_RPM: "1" });
  assert.equal((await f.call()).status, 200); f.restart();
  assert.equal((await f.call()).status, 429);
  assert.equal((await f.call({ user: users[1] })).status, 200);
  f.setTime(Date.parse("2026-11-07T12:01:00Z"));
  assert.equal((await f.call()).status, 200);
  assert.equal(f.calls.length, 3);
});

test("reserve before concurrent dispatch, cap global spend, persist unknown outcomes and reset at Beijing month", async t => {
  const f = await fixture(t, { DS_TOOLS_MONTHLY_USD: "0.0015" });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setResponse(async () => { await gate; throw new Error(`unknown ${paidKey}`); });
  const pending = f.call();
  while (f.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).months["2026-11"].charged, 1);
  f.setResponse(() => Response.json({ title: "标题", content: "内容" }));
  assert.equal((await f.call({ user: users[1] })).status, 200);
  assert.equal((await f.call()).status, 429);
  release(); assert.doesNotMatch((await pending).text, /fixture-paid-key/);
  f.restart(); assert.equal((await f.call()).status, 429);
  f.setTime(Date.parse("2026-11-30T16:00:00Z"));
  assert.equal((await f.call()).status, 200);
  const ledger = JSON.parse(fs.readFileSync(f.stateFile));
  assert.deepEqual(ledger.months["2026-11"], { charged: 2, success: 1 });
  assert.deepEqual(ledger.months["2026-12"], { charged: 1, success: 1 });
  assert.doesNotMatch(fs.readFileSync(f.stateFile, "utf8"), /fixture-paid-key|example.com|zpd\./);
});

test("explicit upstream failures refund reservation, malformed successful replies remain charged and no secrets leak", async t => {
  const f = await fixture(t, { DS_TOOLS_MONTHLY_USD: "0.00075" });
  f.setResponse(() => Response.json({ key: paidKey }, { status: 401, headers: { authorization: paidKey } }));
  const failed = await f.call(); assert.equal(failed.status, 502); assert.doesNotMatch(failed.text, /fixture-paid-key/);
  f.restart();
  f.setResponse(() => Response.json({ debug: paidKey }));
  assert.equal((await f.call()).status, 502); assert.equal((await f.call()).status, 429);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).months["2026-11"], { charged: 1, success: 1 });
});

test("missing credentials, corrupt ledger and excessive configured budget fail closed", async t => {
  const f = await fixture(t);
  fs.unlinkSync(f.keyFile); assert.equal((await f.call()).status, 503); assert.equal(f.calls.length, 0);
  for (const DS_TOOLS_MONTHLY_USD of ["11", "-1", "NaN"]) assert.throws(() => createDsTools({ ...f.options, env: { DS_TOOLS_MONTHLY_USD } }), /limits/);
  fs.writeFileSync(f.stateFile, "broken"); assert.throws(f.restart, /ledger/);
  fs.writeFileSync(f.stateFile, JSON.stringify({ months: { "2026-11": { charged: -1, success: 0 } }, users: {} })); assert.throws(f.restart, /ledger/);
});

test("real HTTP upstream receives only paid credential and disconnect cancels it without refunding unknown spend", async t => {
  const f = await fixture(t);
  let seen, ready, closed;
  const entered = new Promise(resolve => { ready = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    if (seen.body.url.endsWith("/slow")) { res.on("close", closed); ready(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ title: "标题", content: "真实 HTTP 夹具正文" }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  let outgoingSignal;
  f.options.request = (_url, init) => { outgoingSignal = init.signal; return fetch(`http://127.0.0.1:${upstream.address().port}/fake-fetch`, init); };
  f.restart();
  const result = await f.call({ headers: { ...headers(users[0]), cookie: "private", "x-api-key": "do-not-forward" } });
  assert.equal(result.status, 200); assert.match(result.text, /真实 HTTP/);
  assert.equal(seen.headers.authorization, `Bearer ${paidKey}`); assert.equal(seen.headers.cookie, undefined); assert.equal(seen.headers["x-api-key"], undefined);
  const stop = new AbortController(), pending = f.call({ body: { url: "https://example.com/slow" }, signal: stop.signal });
  await entered; stop.abort(); await assert.rejects(pending, { name: "AbortError" });
  await disconnected; assert.equal(outgoingSignal.aborted, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).months["2026-11"], { charged: 2, success: 1 });
});
