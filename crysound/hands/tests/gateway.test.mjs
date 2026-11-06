import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createDeviceRelay, containerLookup, OFFLINE_HINT } from "../../web/gateway/devices.mjs";
import { cloudSource } from "../../web/gateway/device-paths.mjs";
import { mergeDeviceProfile, DEVICE_ROW_ID } from "../../web/device-profile.mjs";
import expected from "./expected/mcp-output.json" with { type: "json" };

// 显式产物模式验证 JSON 已打进包内；默认测试仍只读取源码。
const { createHandsCore, createHandsClient } = await import(process.env.HANDS_TEST_ARTIFACT
  ? pathToFileURL(path.resolve(process.env.HANDS_TEST_ARTIFACT)).href
  : new URL("../../../apps/desktop/src/crysound/hands/index.mjs", import.meta.url).href);

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hands-relay-"));
  const stateRoot = path.join(root, "state");
  const usersRoot = path.join(root, "users");
  const local = path.join(root, "laptop");
  await fs.mkdir(path.join(usersRoot, "alice", "work"), { recursive: true });
  await fs.mkdir(path.join(usersRoot, "bob", "work"), { recursive: true });
  await fs.mkdir(local);
  let mapped = true;
  const relay = await createDeviceRelay({ stateRoot, usersRoot,
    authenticateDesktop: (req) => req.headers.authorization === "Bearer simulated-test-only" ? { slug: "alice" } : null,
    lookupContainer: (ip) => mapped && ip === "127.0.0.1" ? { slug: "alice" } : null, ...options });
  const server = http.createServer(async (req, res) => { if (!await relay.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
  server.on("upgrade", async (req, socket, head) => { if (!await relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.stop())); await relay.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let nextId = 0;
  async function rpc(method, params, headers = {}) {
    const response = await fetch(base + "/_zp/device-mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  async function laptop({ confirm = async () => "allow", id = "test-laptop", onStatus = () => {}, ...extra } = {}) {
    const core = createHandsCore({ confirm, trash: async () => assert.fail("denied deletion reached trash"), open: async () => {} });
    await core.setGrants([{ path: local, readOnly: false }]);
    const online = Promise.withResolvers();
    const client = createHandsClient({ url: base.replace("http:", "ws:") + "/_zp/device", token: "simulated-test-only", device: { id, name: "模拟电脑", os: "linux", appVersion: "test" }, core,
      createSocket: (address, init) => new WebSocket(address, init),
      onStatus: (status) => { onStatus(status); if (status === "online") online.resolve(); }, ...extra });
    clients.push(client); client.start();
    await online.promise;
    return { client, core };
  }
  return { root, stateRoot, usersRoot, local, relay, server, base, rpc, laptop, unmap: () => { mapped = false; } };
}
const call = (f, name, args = {}) => f.rpc("tools/call", { name, arguments: args });
const textResult = (r) => JSON.parse(r.content[0].text);

test("真实客户端经 MCP 搜索、双向分块传输、确认与离线；审计和管理策略始终生效", { timeout: 20_000 }, async (t) => {
  const f = await setup(t);
  const initial = await f.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh-simulation", version: "1" } });
  assert.equal(initial.protocolVersion, "2025-06-18");
  const notification = await fetch(f.base + "/_zp/device-mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notification.status, 202);
  assert.deepEqual(await f.rpc("ping", {}), {});
  const listing = await f.rpc("tools/list", {}); assert.equal(listing.tools.length, 10);
  const offline = await call(f, "list_folders"); assert(offline.isError); assert.equal(offline.content[0].text, OFFLINE_HINT);
  assert.deepEqual(offline, expected.offline);
  const source = path.join(f.local, "三季度报价.txt");
  const data = Buffer.from("三季度采购报价\n".repeat(20000));
  await fs.writeFile(source, data);
  const confirmations = [];
  const { client } = await f.laptop({ confirm: async (request) => { confirmations.push(request); return request.tool === "delete" ? "deny" : "allow"; } });
  assert(f.relay.online("alice"));
  const search = textResult(await call(f, "search", { path: f.local, query: "报价", mode: "both" }));
  assert.equal(search.results[0].path, source);
  const contentSearch = textResult(await call(f, "search", { path: f.local, query: "采购", mode: "text" }));
  assert.equal(contentSearch.results[0].path, source);
  const fetched = await call(f, "fetch_to_cloud", { path: source }); assert(!fetched.isError);
  const cloud = textResult(fetched); assert(cloud.path.startsWith("/data/work/来自本机/"));
  const cloudFile = path.join(f.usersRoot, "alice", cloud.path.slice(6));
  assert.deepEqual(await fs.readFile(cloudFile), data);
  const stat = await fs.stat(cloudFile); assert.equal(stat.uid, 1001); assert.equal(stat.gid, 1001);
  const saved = path.join(f.local, "存回.txt");
  const downloaded = await call(f, "save_to_laptop", { cloud_path: cloud.path, path: saved, summary: "存回报价副本" }); assert(!downloaded.isError);
  assert.deepEqual(await fs.readFile(saved), data);
  const written = await call(f, "write_text", { path: saved, text: "完成汇总", summary: "替换成汇总结论" }); assert(!written.isError);
  assert.equal(await fs.readFile(saved, "utf8"), "完成汇总");
  assert.deepEqual(await call(f, "read_text", { path: saved }), expected.read);
  const deletion = await call(f, "delete", { path: saved, summary: "丢弃汇总" }); assert(deletion.isError); assert.match(deletion.content[0].text, /确认/);
  assert.deepEqual(deletion, expected.denied);
  assert.equal(await fs.readFile(saved, "utf8"), "完成汇总");
  const escape = await call(f, "read_text", { path: path.join(f.root, "elsewhere") }); assert(escape.isError);
  await client.stop();
  assert.equal((await f.rpc("tools/list", {})).tools.length, 10);
  assert.equal((await call(f, "list_folders")).content[0].text, OFFLINE_HINT);
  const registry = JSON.parse(await fs.readFile(path.join(f.stateRoot, "devices/alice.json"), "utf8"));
  assert.equal(registry.name, "模拟电脑"); assert(registry.firstSeen); assert(registry.lastSeen);
  await fs.writeFile(path.join(f.stateRoot, "devices-policy.json"), JSON.stringify({ disabled: true, disabledUsers: [] }));
  const blocked = await call(f, "list_folders"); assert(blocked.isError); assert.match(blocked.content[0].text, /管理员/);
  assert.deepEqual(blocked, expected.disabled);
  await fs.writeFile(path.join(f.stateRoot, "devices-policy.json"), JSON.stringify({ disabled: false, disabledUsers: ["alice"] }));
  assert.match((await call(f, "list_folders")).content[0].text, /管理员/);
  await fs.writeFile(path.join(f.stateRoot, "devices-policy.json"), "malformed");
  assert((await call(f, "list_folders")).isError);
  const auditText = await fs.readFile(path.join(f.stateRoot, "device-audit/alice.jsonl"), "utf8");
  const logs = auditText.trim().split("\n").map(JSON.parse);
  assert(logs.some((e) => e.tool === "fetch_to_cloud" && e.bytes === data.length && e.outcome === "ok"));
  assert(logs.some((e) => e.tool === "write_text" && e.confirmed));
  assert(logs.some((e) => e.tool === "delete" && !e.confirmed && e.outcome === "CONFIRM_DENIED"));
  assert(logs.some((e) => e.outcome === "POLICY_DISABLED"));
  assert(!auditText.includes("完成汇总")); assert(!auditText.includes("三季度采购报价"));
  assert.equal(confirmations.length, 3);
  assert.equal((await fetch(f.base + "/_zp/device-mcp")).status, 405);
  const publicResponse = await fetch(f.base + "/_zp/device-mcp", { method: "POST", headers: { "x-forwarded-for": "172.1.1.2" }, body: "{}" }); assert.equal(publicResponse.status, 403);
  f.unmap();
  assert.equal((await fetch(f.base + "/_zp/device-mcp", { method: "POST", body: "{}" })).status, 403);
});

test("容器地址只匹配 partner-net 的运行用户容器，忽略伪造容器名及其他网络", async () => {
  let containers = [{ State: "running", Names: ["/zhaohua-partner-alice"], NetworkSettings: { Networks: { "partner-net": { IPAddress: "172.20.0.9" } } } }];
  const lookup = containerLookup(async (method, route) => { assert.equal(method, "GET"); assert.equal(route, "/containers/json"); return { status: 200, body: JSON.stringify(containers) }; }, () => [{ slug: "alice" }]);
  assert.equal((await lookup("::ffff:172.20.0.9")).slug, "alice");
  assert.equal(await lookup("127.0.0.1"), null);
  containers[0].Names = ["/untrusted"]; assert.equal(await lookup("172.20.0.9"), null);
  containers[0].Names = ["/zhaohua-partner-alice"]; containers[0].State = "exited"; assert.equal(await lookup("172.20.0.9"), null);
  containers = [{ State: "running", Names: ["/zhaohua-partner-alice"], NetworkSettings: { Networks: { other: { IPAddress: "172.20.0.9" } } } }];
  assert.equal(await lookup("172.20.0.9"), null);
});

test("跨用户云端路径和目录链接均拒绝，不发布未完成文件", { timeout: 10_000 }, async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.usersRoot, "bob/work/private.txt"), "bob-fixture");
  await fs.symlink(path.join(f.usersRoot, "bob"), path.join(f.usersRoot, "alice/escape"));
  for (const filename of ["/data/../bob/work/private.txt", "/data/escape/work/private.txt", "/etc/passwd"]) {
    await assert.rejects(cloudSource(f.usersRoot, "alice", filename));
  }
  await f.laptop();
  const result = await call(f, "save_to_laptop", { cloud_path: "/data/escape/work/private.txt", path: path.join(f.local, "leak.txt"), summary: "越界" });
  assert(result.isError); assert.deepEqual(await fs.readdir(f.local), []);
  const failed = await call(f, "fetch_to_cloud", { path: path.join(f.local, "missing.txt") }); assert(failed.isError);
  assert.deepEqual(await fs.readdir(path.join(f.usersRoot, "alice/work/来自本机")), []);
});

test("超时取消确认后不写入，客户端继续服务后续调用", { timeout: 10_000 }, async (t) => {
  const f = await setup(t, { callTimeoutMs: 60 });
  const prompt = Promise.withResolvers();
  await f.laptop({ confirm: (request) => { prompt.resolve(request); return new Promise((resolve) => request.signal.addEventListener("abort", () => resolve("deny"), { once: true })); } });
  const result = call(f, "write_text", { path: path.join(f.local, "cancel.txt"), text: "cancelled", summary: "取消测试" });
  await prompt.promise;
  const response = await result; assert(response.isError);
  assert.deepEqual(await fs.readdir(f.local), []);
  // 确认的取消通过网络送达；工具忙时返回可重试结果，不能重放写操作。
  let next;
  for (let i = 0; i < 10; i++) { next = await call(f, "list_folders"); if (!next.isError) break; }
  assert(!next.isError);
});

test("web 合并独立于首次开通标记且幂等，保留已有禁用行和默认桌面配置", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hands-profile-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "cordis.patch.yml");
  await fs.writeFile(profile, "# existing user\n- id: custom-model\n  disabled: true\n");
  assert(await mergeDeviceProfile(profile));
  const first = await fs.readFile(profile, "utf8"); assert(first.includes("custom-model")); assert(first.includes("transport: streamable-http"));
  assert.equal(await mergeDeviceProfile(profile), false); assert.equal(await fs.readFile(profile, "utf8"), first);
  await fs.writeFile(profile, `- insert:\n    - id: '${DEVICE_ROW_ID}' # keep user preference\n      disabled: true\n`);
  assert.equal(await mergeDeviceProfile(profile), false);
  await fs.writeFile(profile, "[]\n"); assert(await mergeDeviceProfile(profile)); assert(!(await fs.readFile(profile, "utf8")).includes("[]"));
  const shared = await fs.readFile(new URL("../../config/partner.patch.yml", import.meta.url), "utf8"); assert(!shared.includes(DEVICE_ROW_ID));
});

async function rawLaptop(t, f, handler, version = 1) {
  const ws = new WebSocket(f.base.replace("http:", "ws:") + "/_zp/device", { headers: { Authorization: "Bearer simulated-test-only" } });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const ready = Promise.withResolvers();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") ready.resolve();
    handler(message, ws);
  });
  ws.send(JSON.stringify({ type: "hello", version, id: "raw-test", name: "协议测试电脑", os: "linux", appVersion: "test" }));
  if (version === 1) await ready.promise;
  return ws;
}

test("重连只恢复连接，不重放写入；新设备接管后旧设备不会自动抢回", { timeout: 10_000 }, async (t) => {
  const f = await setup(t);
  const sockets = [];
  const reconnected = Promise.withResolvers();
  const superseded = Promise.withResolvers();
  let online = 0;
  let confirmed = 0;
  await f.laptop({ confirm: async () => { confirmed++; return "allow"; }, reconnectMs: 10, maxReconnectMs: 30,
    createSocket: (address, init) => { const ws = new WebSocket(address, init); sockets.push(ws); return ws; },
    onStatus: (status) => { if (status === "online" && ++online === 2) reconnected.resolve(); if (status === "superseded") superseded.resolve(); } });
  assert(!(await call(f, "write_text", { path: path.join(f.local, "once.txt"), text: "once", summary: "仅一次" })).isError);
  sockets[0].close(3001);
  await reconnected.promise;
  assert.equal(confirmed, 1); assert.equal(sockets.length, 2); assert(!(await call(f, "list_folders")).isError);
  await f.laptop({ id: "replacement-device" });
  await superseded.promise;
  const registry = JSON.parse(await fs.readFile(path.join(f.stateRoot, "devices/alice.json"), "utf8"));
  assert.equal(registry.id, "replacement-device");
  assert(!(await call(f, "list_folders")).isError); assert.equal(confirmed, 1);
});

test("无认证升级被拒绝，错误协议版本和失联心跳关闭连接", { timeout: 10_000 }, async (t) => {
  const f = await setup(t, { heartbeatMs: 30 });
  const unauthorized = new WebSocket(f.base.replace("http:", "ws:") + "/_zp/device");
  await new Promise((resolve) => unauthorized.addEventListener("error", resolve, { once: true }));
  assert(!f.relay.online("alice"));
  const invalid = await rawLaptop(t, f, () => {}, 999);
  const invalidClose = await new Promise((resolve) => invalid.addEventListener("close", resolve, { once: true }));
  assert.equal(invalidClose.code, 1002); assert(!f.relay.online("alice"));
  const silent = await rawLaptop(t, f, () => {});
  const closed = await new Promise((resolve) => silent.addEventListener("close", resolve, { once: true }));
  assert.equal(closed.code, 1001); assert(!f.relay.online("alice"));
});

test("超限传输、错误序号和校验错误均不发布云端文件", { timeout: 10_000 }, async (t) => {
  const { encodeChunk, FILE_LIMIT } = await import("../wire.mjs");
  for (const failure of ["size", "sequence", "checksum"]) {
    await t.test(failure, async (t) => {
      const f = await setup(t);
      let id;
      await rawLaptop(t, f, (message, ws) => {
        if (message.type === "call") {
          id = message.id;
          ws.send(JSON.stringify({ type: "transfer", id, size: failure === "size" ? FILE_LIMIT + 1 : 1 }));
        } else if (message.type === "ready") {
          if (failure === "sequence") ws.send(encodeChunk(id, 1, Buffer.from("x")));
          else ws.send(encodeChunk(id, 0, Buffer.from("x")));
        } else if (message.type === "ack") ws.send(JSON.stringify({ type: "transfer_end", id, sha256: "bad-checksum" }));
      });
      const result = await call(f, "fetch_to_cloud", { path: "/simulated/file.txt" });
      assert(result.isError);
      assert.deepEqual(await fs.readdir(path.join(f.usersRoot, "alice/work/来自本机")), []);
      const audit = JSON.parse((await fs.readFile(path.join(f.stateRoot, "device-audit/alice.jsonl"), "utf8")).trim());
      assert.equal(audit.outcome, failure === "size" ? "SIZE_LIMIT" : "PROTOCOL");
    });
  }
});

test("显式 MCP 取消通知终止待确认调用，后续请求仍能使用本机工具", { timeout: 10_000 }, async (t) => {
  const f = await setup(t);
  const prompt = Promise.withResolvers();
  await f.laptop({ confirm: (request) => { prompt.resolve(); return new Promise((resolve) => request.signal.addEventListener("abort", () => resolve("deny"), { once: true })); } });
  const response = fetch(f.base + "/_zp/device-mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "cancel-me", method: "tools/call", params: { name: "write_text", arguments: { path: path.join(f.local, "cancel.txt"), text: "none", summary: "取消" } } }) });
  await prompt.promise;
  const cancel = await fetch(f.base + "/_zp/device-mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me" } }) });
  assert.equal(cancel.status, 202);
  assert((await (await response).json()).result.isError);
  assert.deepEqual(await fs.readdir(f.local), []);
  assert(!(await call(f, "list_folders")).isError);
});
