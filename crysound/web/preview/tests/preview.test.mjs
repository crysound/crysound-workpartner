import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { createPreview, relayKey, writeRelayKey } from "../gateway.mjs";
import { createRelay } from "../relay.mjs";
import { previewPort, previewPath } from "../policy.mjs";

const listen = (server, host = "127.0.0.1", port = 0) => new Promise((resolve, reject) => {
  server.once("error", reject); server.listen(port, host, () => resolve(server.address().port));
});

// All servers and upgraded sockets belong to the fixture and close even when an assertion fails.
async function fixture(t) {
  const servers = [], sockets = new Set();
  const own = (server) => {
    servers.push(server);
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    return server;
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const key = "test-only-gateway-key", users = [{ slug: "alice", unionId: "a" }, { slug: "bob", unionId: "b" }];
  let clock = Date.now(), requests = [];
  const editor = own(http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith("/html")) {
      const html = '<!doctype html><html><head data-editor="slides"><SCRIPT>window.editorSawNativeDownloads=window.__baoyuNativeDownloads;</SCRIPT></head><body>中文导出</body></html>';
      const encoding = req.url.split("/")[2];
      const bytes = encoding === "gzip" ? gzipSync(html) : encoding === "deflate" ? deflateSync(html) : encoding === "br" ? brotliCompressSync(html) : Buffer.from(html);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": bytes.length,
        ...(encoding ? { "content-encoding": encoding } : {}), etag: '"original"' });
      return res.end(bytes);
    }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n"); // Keep open: the client must observe data before EOF.
      return;
    }
    if (req.url === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${editor.address().port}/slides/demo/?a=1` }); return res.end(); }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("set-cookie", ["editor=ok; Domain=example.test; Path=/", "__Host-zp-preview=forged; Path=/; Secure"]);
    if (req.url === "/post") { const chunks = []; req.on("data", (chunk) => chunks.push(chunk)); req.on("end", () => res.end(Buffer.concat(chunks))); }
    else res.end(`editor:${req.url}`);
  }));
  editor.on("upgrade", (req, socket, head) => {
    requests.push({ url: req.url, headers: req.headers });
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (data) => socket.write(data));
    if (head.length) socket.write(head);
  });
  const port = await listen(editor);
  const relay = own(createRelay({ key: relayKey(key, "alice"), gatewayAddresses: async () => ["127.0.0.1"] }));
  const relayPort = await listen(relay, "127.0.0.1");
  const preview = createPreview({
    publicHost: "app.example.test", previewHost: "preview.example.test", key,
    users: () => users, relayPort, now: () => clock,
    sessionUser: (req) => {
      const user = users.find((u) => req.headers.cookie?.includes(`account=${u.unionId}`));
      return user ? { user, expires: clock / 1000 + 3600 } : null;
    },
    upstream: async (slug) => ({ ip: slug === "alice" ? "127.0.0.1" : "127.0.0.2" }),
  });
  const gateway = own(http.createServer(async (req, res) => {
    try {
      if (!await preview.handle(req, res, new URL(req.url, "https://app.example.test"))) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  }));
  gateway.on("upgrade", (req, socket, head) => preview.upgrade(req, socket, head).catch(() => socket.destroy()));
  const gatewayPort = await listen(gateway);
  const request = (url, { account = "a", jar = new Map(), method = "GET", body, headers = {}, direct } = {}) => new Promise((resolve, reject) => {
    const at = new URL(url, "https://app.example.test");
    const cookie = at.host === "app.example.test" ? `account=${account}` : jar.get(at.host) || "";
    const req = http.request({ host: direct ? "127.0.0.1" : "127.0.0.1", port: direct || gatewayPort,
      path: at.pathname + at.search, method, headers: { host: at.host, cookie, ...headers } }, (res) => {
      if (res.headers["set-cookie"]) {
        const saved = new Map((jar.get(at.host) || "").split("; ").filter(Boolean).map((part) => part.split(/=(.*)/s).slice(0, 2)));
        for (const item of res.headers["set-cookie"]) { const [name, value] = item.split(";")[0].split(/=(.*)/s); saved.set(name, value); }
        jar.set(at.host, [...saved].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), jar }));
    });
    req.on("error", reject); req.end(body);
  });
  const bootstrap = async (targetPort = port, jar = new Map()) => {
    const open = await request(`/_zp/preview/open?port=${targetPort}&path=${encodeURIComponent("/slides/demo/?x=1#page2")}`, { jar });
    assert.equal(open.status, 302);
    const start = await request(open.headers.location, { jar });
    const auth = await request(start.headers.location, { jar });
    const redeem = await request(auth.headers.location, { jar });
    assert.equal(redeem.status, 302, redeem.text);
    const origin = new URL(auth.headers.location).origin;
    return { jar, open, start, auth, redeem, origin };
  };
  return { preview, key, users, port, relayPort, gatewayPort, request, bootstrap, requests, advance: (ms) => { clock += ms; } };
}

test("web preview enables native downloads before editor startup, including compressed HTML", async (t) => {
  const f = await fixture(t), b = await f.bootstrap();
  for (const path of ["/html", "/html/gzip", "/html/deflate", "/html/br"]) {
    const page = await f.request(b.origin + path, { jar: b.jar });
    assert.equal(page.status, 200);
    const window = {};
    for (const [, script] of page.text.matchAll(/<script>(.*?)<\/script>/gis)) vm.runInNewContext(script, { window });
    assert.equal(window.editorSawNativeDownloads, true, path);
    assert(page.text.includes("中文导出"));
    for (const header of ["content-length", "content-encoding", "etag"]) assert.equal(page.headers[header], undefined);
  }
  const direct = await f.request("/html", { direct: f.relayPort, headers: {
    "x-zp-preview-port": String(f.port), "x-zp-relay-key": relayKey(f.key, "alice"),
  } });
  assert(!direct.text.includes("<script>window.__baoyuNativeDownloads=true;"), "container relay must not change desktop behavior");
});

test("port and path inputs reject the workspace control plane and non-local targets", () => {
  for (const value of [80, 443, 3080, 3090, 3091, 3092, 65536, "04710", "4710@evil", "1e4", "4710.0", "localhost:4710"]) assert.equal(previewPort(value), null, String(value));
  assert.equal(previewPort("4710"), 4710);
  for (const value of ["//evil.test", "/\\evil", "https://evil.test", "/ok\r\nx: y", "/\t/evil.test", "/ok\x1f"]) assert.equal(previewPath(value), null);
  assert.equal(previewPath("/slides/demo/?q=1#p2"), "/slides/demo/?q=1#p2");
});

test("relay credentials are stable, private, distinct and idempotent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-keys-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRelayKey("synthetic", { slug: "alice" }, root, null);
  const file = path.join(root, "alice/.zp-preview-relay-key"), first = fs.statSync(file);
  assert.equal(first.mode & 0o777, 0o600);
  assert.notEqual(relayKey("synthetic", "alice"), relayKey("synthetic", "bob"));
  writeRelayKey("synthetic", { slug: "alice" }, root, null);
  assert.equal(fs.statSync(file).ino, first.ino);
});

test("real HTTP roundtrip preserves root paths, cookies, request bodies and redirects", async (t) => {
  const f = await fixture(t), b = await f.bootstrap();
  const entry = `/_zp/preview/open?port=${f.port}&path=%2Fslides%2Fdemo%2F%3Fx%3D1`;
  const login = await f.request(entry, { account: "" });
  const loginUrl = new URL(login.headers.location);
  assert.equal(login.status, 302);
  assert.equal(loginUrl.origin, "https://app.example.test");
  assert.equal(loginUrl.pathname, "/_zp/login");
  assert.equal(loginUrl.searchParams.get("next"), entry);
  assert.equal(b.redeem.headers.location, b.origin + "/slides/demo/?x=1#page2");
  const page = await f.request(b.redeem.headers.location, { jar: b.jar });
  assert.equal(page.text, "editor:/slides/demo/?x=1");
  assert.equal(f.requests.at(-1).headers.host, `127.0.0.1:${f.port}`);
  assert.equal(f.requests.at(-1).headers["x-zp-relay-key"], undefined);
  assert(!String(f.requests.at(-1).headers.cookie).includes("zp-preview"));
  assert(page.headers["set-cookie"].every((c) => !/Domain=/i.test(c)));
  assert(page.headers["set-cookie"].some((c) => c.startsWith("__Host-zp-preview=") && /HttpOnly; Secure; SameSite=Strict/.test(c)));
  assert(!page.headers["set-cookie"].some((c) => c.includes("forged")));
  const post = await f.request(b.origin + "/post", { jar: b.jar, method: "POST", body: "saved", headers: { origin: b.origin, "content-type": "text/plain" } });
  assert.equal(post.text, "saved");
  assert.equal(post.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(f.requests.at(-1).headers.origin, `http://127.0.0.1:${f.port}`);
  assert.equal(f.requests.at(-1).headers.cookie, "editor=ok");
  const redirect = await f.request(b.origin + "/redirect", { jar: b.jar });
  assert.equal(redirect.headers.location, b.origin + "/slides/demo/?a=1");
});

test("copied links, wrong-browser grants, replays and tampered bindings cannot cross accounts", async (t) => {
  const f = await fixture(t), b = await f.bootstrap();
  assert.equal((await f.request(b.start.headers.location, { account: "b" })).status, 403);
  assert.equal((await f.request(b.auth.headers.location, { jar: new Map() })).status, 403);
  assert.equal((await f.request(b.auth.headers.location, { jar: b.jar })).status, 403);
  assert.equal((await f.request(b.origin + "/slides/demo/")).status, 401);
  const copiedStart = await f.request(b.open.headers.location);
  assert.equal((await f.request(copiedStart.headers.location, { account: "b" })).status, 403);
  const host = new URL(b.origin).host;
  const token = b.jar.get(host).match(/__Host-zp-preview=([^;]+)/)[1];
  const [data, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(data, "base64url"));
  for (const patch of [{ p: f.port === 4710 ? 4711 : 4710 }, { u: "b" }]) {
    const forged = Buffer.from(JSON.stringify({ ...payload, ...patch })).toString("base64url");
    assert.equal((await f.request(b.origin + "/", { headers: { cookie: `__Host-zp-preview=${forged}.${signature}` } })).status, 401);
  }
  assert.equal((await f.request(`https://4710-abc.preview.example.test/`, { headers: { cookie: b.jar.get(host) } })).status, 403);
  assert.equal((await f.request(b.origin + "/", { jar: b.jar, headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.request("/_zp/preview/open?port=3080")).status, 400);
  assert.equal((await f.request("/_zp/preview/open?port=3091")).status, 400);
  assert.equal((await f.request("/_zp/preview/open?port=4710&path=//evil.test")).status, 400);
  const unsafePath = encodeURIComponent("/\t/evil.test");
  assert.equal((await f.request(`/_zp/preview/open?port=${f.port}&path=${unsafePath}`)).status, 400);
  const unsafeStart = new URL(b.open.headers.location);
  unsafeStart.searchParams.set("path", "/\t/evil.test");
  assert.equal((await f.request(unsafeStart.href, { jar: b.jar })).status, 400);
  const unsafeAuth = new URL(b.start.headers.location);
  unsafeAuth.searchParams.set("path", "/\t/evil.test");
  assert.equal((await f.request(unsafeAuth.href, { jar: b.jar })).status, 403);
  // Even a signed grant must contain a valid local path before it can establish a session.
  const freshStart = await f.request(b.open.headers.location, { jar: b.jar });
  const freshAuth = await f.request(freshStart.headers.location, { jar: b.jar });
  const redeem = new URL(freshAuth.headers.location);
  const [grantData] = redeem.searchParams.get("ticket").split(".");
  const grant = JSON.parse(Buffer.from(grantData, "base64url"));
  grant.path = "/\t/evil.test";
  const changed = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const grantSignature = crypto.createHmac("sha256", f.key).update(`grant:${changed}`).digest("hex");
  redeem.searchParams.set("ticket", `${changed}.${grantSignature}`);
  const deniedRedirect = await f.request(redeem.href, { jar: b.jar });
  assert.equal(deniedRedirect.status, 403);
  assert.equal(deniedRedirect.headers.location, undefined);
  assert.equal(deniedRedirect.headers["set-cookie"], undefined);
  f.users.splice(0, 1);
  assert.equal((await f.request(b.origin + "/", { jar: b.jar })).status, 401);
});

test("relay rejects another workspace key and a correct key from a non-gateway address", async (t) => {
  const f = await fixture(t);
  const options = { direct: f.relayPort, headers: { "x-zp-preview-port": String(f.port), "x-zp-relay-key": relayKey(f.key, "bob") } };
  assert.equal((await f.request("https://relay/", options)).status, 403);
  options.headers["x-zp-relay-key"] = relayKey(f.key, "alice");
  assert.equal((await f.request("https://relay/", options)).status, 200);
  const foreign = createRelay({ key: relayKey(f.key, "alice"), gatewayAddresses: async () => ["192.0.2.1"] });
  const p = await listen(foreign);
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const answer = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: p, headers: options.headers }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject);
  });
  assert.equal(answer, 403);
});

test("short sessions renew during use and expired grants and sessions fail closed", async (t) => {
  const f = await fixture(t), b = await f.bootstrap();
  f.advance(500000);
  const active = await f.request(b.origin + "/", { jar: b.jar }); assert.equal(active.status, 200);
  f.advance(500000);
  assert.equal((await f.request(b.origin + "/", { jar: b.jar })).status, 200);
  f.advance(601000);
  assert.equal((await f.request(b.origin + "/", { jar: b.jar })).status, 401);
  const renew = await f.request(b.origin + "/", { jar: b.jar, headers: { "sec-fetch-mode": "navigate" } });
  assert.equal(renew.status, 302);
  assert.equal(new URL(renew.headers.location).host, "app.example.test");
  assert.equal((await f.request(renew.headers.location, { account: "b" })).status, 403);
  const jar = new Map();
  const open = await f.request(`/_zp/preview/open?port=${f.port}`, { jar });
  const start = await f.request(open.headers.location, { jar });
  const auth = await f.request(start.headers.location, { jar });
  f.advance(61000);
  assert.equal((await f.request(auth.headers.location, { jar })).status, 403);
});

test("SSE data reaches the client before the upstream finishes", async (t) => {
  const f = await fixture(t), b = await f.bootstrap(), at = new URL(b.origin);
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: f.gatewayPort, path: "/events", headers: { host: at.host, cookie: b.jar.get(at.host) } }, (res) => {
      res.once("data", (data) => { resolve(data.toString()); res.destroy(); });
    });
    req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("SSE did not stream")));
  });
  assert.equal(first, "data: first\n\n");
});

test("WebSocket handshakes and bytes cross both hops, while a foreign origin is refused", async (t) => {
  const f = await fixture(t), b = await f.bootstrap(), at = new URL(b.origin);
  const exchange = (origin, cookie) => new Promise((resolve, reject) => {
    const socket = net.connect(f.gatewayPort, "127.0.0.1", () => socket.write(
      `GET /socket HTTP/1.1\r\nHost: ${at.host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    let got = Buffer.alloc(0), sent = false;
    const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
    socket.on("data", (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (!sent && got.includes(Buffer.from("\r\n\r\n"))) { sent = true; socket.write(frame); }
      if (got.subarray(-frame.length).equals(frame)) { resolve(got); socket.destroy(); }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(got));
    socket.setTimeout(3000, () => socket.destroy(new Error("WebSocket did not respond")));
  });
  const result = await exchange(b.origin, b.jar.get(at.host));
  assert.match(result.toString(), /^HTTP\/1.1 101/); assert(result.length > 8);
  assert.equal((await exchange("https://evil.test", b.jar.get(at.host))).length, 0);
  assert.equal((await exchange(b.origin, "")).length, 0);
});


test("one host-only session selects the current editor port and can switch back", async (t) => {
  const f = await fixture(t);
  const second = http.createServer((_req, res) => res.end("second editor"));
  const port = await listen(second);
  t.after(() => new Promise((resolve) => second.close(resolve)));
  const a = await f.bootstrap();
  assert.equal((await f.request(a.origin + "/", { jar: a.jar })).text, "editor:/");
  const b = await f.bootstrap(port, a.jar);
  assert.equal(a.origin, b.origin);
  assert.equal((await f.request(b.origin + "/", { jar: b.jar })).text, "second editor");
  const again = await f.bootstrap(f.port, a.jar);
  assert.equal((await f.request(again.origin + "/", { jar: again.jar })).text, "editor:/");
});
