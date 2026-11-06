// 真实 HTTP 处理器 + 假飞书响应，覆盖身份、刷新、撤销和并发；不读取任何部署凭据。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createFeishu } from "../feishu.mjs";
import { issueToken, tokenUser } from "../market-auth.mjs";
import { createSettingsHandler } from "../../../feishu/settings.mjs";
import { createProject } from "../../../feishu/project.mjs";

const user = { unionId: "fake-user", slug: "alice" };
const key = "fake-hmac-key";
const publicOrigin = "https://partner.example.test";
const headers = { authorization: `Bearer ${issueToken(key, user)}` };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zp-feishu-test-"));
  const calls = [];
  let clock = Date.now(), enabled = true, identity = user.unionId, refreshFailure = false, revokeFailure = false, refreshGate;
  const fetcher = async (url, init) => {
    const body = init.body ? init.headers["content-type"].includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "fake-app-token" });
    if (url.endsWith("/scopes")) return Response.json({ code: 0, data: { scopes: [
      { scope_type: "user", scope_name: "calendar:calendar:read", grant_status: 1 },
      { scope_type: "tenant", scope_name: "im:message:send_as_bot", grant_status: 1 },
      { scope_type: "user", scope_name: "mail:user_mailbox.message:send", grant_status: 2 },
    ] } });
    if (url.endsWith("/user_info")) return Response.json({ code: 0, data: { union_id: identity } });
    if (url.endsWith("/revoke")) return revokeFailure ? Response.json({ error: "temporarily_unavailable" }, { status: 503 }) : new Response(null, { status: 200 });
    if (url.endsWith("/token")) {
      if (body.grant_type === "refresh_token") {
        if (refreshGate) await refreshGate;
        if (refreshFailure) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "fake-refreshed-access", refresh_token: "fake-rotated-refresh", expires_in: 7200, refresh_token_expires_in: 86400 });
      }
      return Response.json({ access_token: "fake-initial-access", refresh_token: "fake-initial-refresh", expires_in: 7200, refresh_token_expires_in: 86400 });
    }
    throw new Error("unexpected fake endpoint");
  };
  const options = { stateDir: dir, appId: "fake-app-id", secret: () => "fake-app-secret", publicOrigin, enabled: () => enabled,
    authenticate: (req) => tokenUser(req, key, [user]), sessionUser: (req) => req.headers.cookie?.includes("session=alice") ? user : null,
    readUsers: () => [user], fetcher, now: () => clock };
  let service = createFeishu(options);
  const settings = () => createSettingsHandler({ basePath: "/_zp/feishu/", origin: publicOrigin, identify: options.sessionUser, status: (u) => service.status(u.unionId), disconnect: (u) => service.disconnect(u.unionId), project: {}, connectUrl: `${publicOrigin}/_zp/feishu/connect` });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, publicOrigin);
    if (url.pathname === "/internal/token") return service.token(req, res);
    if (await service.handle(req, res, url)) return;
    if (await settings()(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, init = {}) => { const r = await fetch(base + route, { redirect: "manual", ...init }); return { status: r.status, headers: r.headers, text: await r.text() }; };
  const connect = async () => {
    const r = await request("/_zp/feishu/connect", { headers: { cookie: "session=alice" } });
    assert.equal(r.status, 302, r.text);
    const q = new URL(r.headers.get("location")).searchParams;
    const state = q.get("state");
    return { state, query: q, cookie: `session=alice; zp_feishu=${state}` };
  };
  const callback = (c, state = c.state) => request(`/_zp/callback?state=${state}&code=fake-code`, { headers: { cookie: c.cookie } });
  const token = (h = headers) => request("/internal/token", { method: "POST", headers: h });
  const disconnect = (origin = publicOrigin) => request("/_zp/feishu/disconnect", { method: "POST", headers: { cookie: "session=alice", origin } });
  return { dir, calls, request, connect, callback, token, disconnect,
    advance: (ms) => { clock += ms; }, disable: () => { enabled = false; }, mismatch: () => { identity = "another-account"; },
    rejectRefresh: () => { refreshFailure = true; }, rejectRevoke: () => { revokeFailure = true; }, acceptRevoke: () => { revokeFailure = false; },
    holdRefresh: () => { let release; refreshGate = new Promise((r) => { release = r; }); return release; },
    restart: () => { service = createFeishu(options); }, maintain: () => service.maintain(), service: () => service,
  };
}

test("未授权给中文提示及链接；容器鉴权失败不调用飞书", async (t) => {
  const f = await fixture(t);
  const r = await f.token(); assert.equal(r.status, 409); assert.equal(JSON.parse(r.text).authorization_url, `${publicOrigin}/_zp/feishu/connect`);
  for (const h of [{}, { authorization: "Bearer fake-bad" }, { authorization: `Bearer ${issueToken(key, user, 0)}` }]) assert.equal((await f.token(h)).status, 401);
  assert.equal(f.calls.length, 0);
});

test("回调绑定会话、一次性 state、账号；只请求已开通的用户权限与 offline_access", async (t) => {
  const f = await fixture(t), c = await f.connect();
  assert.equal(c.query.get("scope"), "calendar:calendar:read offline_access");
  assert.equal((await f.callback(c)).status, 302);
  assert.equal((await f.callback(c)).status, 400);
  const r = await f.token(); assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).user_access_token, "fake-initial-access");
  assert.ok(!r.text.includes("refresh")); assert.ok(!r.text.includes("secret"));
  const file = fs.readdirSync(f.dir)[0]; assert.equal(fs.statSync(path.join(f.dir, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
  f.restart(); assert.equal((await f.token()).status, 200);
});

test("错误 state、缺少 cookie、过期 state 均不能交换授权码", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  assert.equal((await f.request(`/_zp/callback?state=${c.state}&code=fake`, { headers: { cookie: "session=alice" } })).status, 400);
  const d = await f.connect(); f.advance(600001); assert.equal((await f.callback(d)).status, 400);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/token")).length, 0);
});

test("账号不匹配拒绝保存可用授权，并撤销新取得的授权", async (t) => {
  const f = await fixture(t), c = await f.connect(); f.mismatch();
  assert.equal((await f.callback(c)).status, 403); assert.equal((await f.token()).status, 409);
  assert.ok(f.calls.some((c) => c.url.endsWith("/revoke")));
});

test("到期前并发领取只刷新一次，并保存轮换后的 refresh_token", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect()); f.advance(116 * 60000);
  const results = await Promise.all([f.token(), f.token(), f.token()]);
  assert.ok(results.every((r) => r.status === 200 && JSON.parse(r.text).user_access_token === "fake-refreshed-access"));
  assert.equal(f.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 1);
  f.advance(116 * 60000); await f.token();
  assert.equal(f.calls.filter((c) => c.body?.grant_type === "refresh_token").at(-1).body.refresh_token, "fake-rotated-refresh");
});

test("后台到期前刷新；失败不返回旧令牌，状态可明确显示重连", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect()); f.advance(116 * 60000); await f.maintain();
  assert.equal((await f.token()).status, 200); f.advance(116 * 60000); f.rejectRefresh();
  const r = await f.token(); assert.equal(r.status, 502); assert.ok(!r.text.includes("fake-refreshed-access"));
  assert.equal(f.service().status(user.unionId).connected, false); assert.equal((await f.token()).status, 409);
});

test("断开必须同源；删除长期凭证且并发刷新不能恢复已断开的授权", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect());
  assert.equal((await f.disconnect("https://other.test")).status, 403);
  f.advance(116 * 60000);
  const release = f.holdRefresh(), refreshing = f.token();
  // 等到真正的刷新边界，再发断开，验证实际请求串行，而不是依赖任意 sleep。
  while (!f.calls.some((c) => c.body?.grant_type === "refresh_token")) await new Promise((r) => setImmediate(r));
  const disconnecting = f.disconnect(); release();
  assert.equal((await refreshing).status, 200); assert.equal((await disconnecting).status, 200);
  assert.equal((await f.token()).status, 409); assert.equal(fs.readdirSync(f.dir).length, 0);
  assert.equal((await f.disconnect()).status, 200);
});

test("撤销暂时失败立即停止发令牌，重启后维护继续撤销", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect()); f.rejectRevoke();
  assert.equal((await f.disconnect()).status, 502); assert.equal((await f.token()).status, 409);
  assert.equal(f.service().status(user.unionId).revoking, true);
  f.restart(); f.acceptRevoke(); await f.maintain(); assert.equal(fs.readdirSync(f.dir).length, 0);
});

test("总开关禁止新连接、领取和自动刷新，仍允许撤销已有授权", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect()); f.disable(); f.advance(116 * 60000);
  assert.equal((await f.token()).status, 403); assert.equal((await f.request("/_zp/feishu/connect", { headers: { cookie: "session=alice" } })).status, 403);
  await f.maintain(); assert.equal(f.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 0);
  assert.equal((await f.disconnect()).status, 200);
});

test("桌面版仅凭已签名本人令牌领取；不需要浏览器 cookie", async (t) => {
  const f = await fixture(t); await f.callback(await f.connect());
  assert.equal((await f.request("/_zp/feishu/desktop-token", { method: "POST", headers })).status, 200);
  assert.equal((await f.request("/_zp/feishu/desktop-status", { method: "POST", headers })).status, 200);
  assert.equal((await f.request("/_zp/feishu/desktop-disconnect", { method: "POST", headers: {} })).status, 401);
});

test("飞书项目登录按本人隔离，非阻塞检查，断开取消未完成设备授权", async () => {
  const calls = [];
  const p = createProject({ run: async (id, args) => { calls.push({ id, args }); if (args.includes("init")) return { verification_uri_complete: "https://project.example.test/device", device_code: "fake-device", client_id: "fake-client", user_code: "TEST", expires_in: 600, interval: 5 }; if (args.includes("poll")) return { status: "ok" }; if (args[1] === "status") return { authenticated: false, reason: "no local token" }; return {}; } });
  await p.connect({ ...user }); assert.equal((await p.poll({ ...user })).state, "connected");
  await p.connect(user); await p.disconnect({ ...user }); assert.equal((await p.poll(user)).state, "expired");
  assert.equal(calls.filter((c) => c.args.includes("poll")).length, 1);
  assert.deepEqual(await p.status(user), { connected: false });
});
