// HTTP 桩只代替 Verdaccio 存储；鉴权、发布和审批走生产处理器。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createMarket } from "../market.mjs";
import { issueToken, tokenUser, writeContainerToken } from "../market-auth.mjs";
import { tsImport } from "tsx/esm/api";

const { parseMarketIndex, marketInstallTarget } = await tsImport("../../../../packages/util/plugin-market-index/src/index.ts", import.meta.url);

const key = "test-only-hmac-key";
const users = [{ slug: "alice", name: "测试发布者", unionId: "fake-alice" }, { slug: "bob", unionId: "fake-bob" }, { slug: "admin", unionId: "fake-admin" }];
const token = (slug) => issueToken(key, users.find((u) => u.slug === slug));
const bearer = (slug) => ({ authorization: `Bearer ${token(slug)}` });
const publicOrigin = "https://partner.example.test";
const name = "@crysound/demo";
const route = `/_zp/npm/${encodeURIComponent(name)}`;
const doc = (version = "1.0.0", packageName = name) => ({ name: packageName, description: "示例", readme: "<script>never run</script>\n# 测试 README",
  versions: { [version]: { name: packageName, version, description: "中文插件", dsh: { bundle: { patch: "./cordis.patch.yml" } }, dist: { tarball: `http://verdaccio:4873/${packageName}/-/demo-${version}.tgz` } } },
  _attachments: { [`demo-${version}.tgz`]: { content_type: "application/octet-stream", data: Buffer.from("fake-tarball").toString("base64"), length: 12 } },
});
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; };
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-market-test-"));
  const packages = new Map();
  const requests = [];
  const notices = [];
  let publishStatus = 201;
  const registry = http.createServer(async (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization });
    assert.equal(req.headers.authorization, "Basic fake-internal-credential");
    const p = decodeURIComponent(req.url).slice(1);
    if (req.method === "PUT") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const incoming = JSON.parse(Buffer.concat(chunks));
      requests.at(-1).body = incoming;
      if (publishStatus === 201) packages.set(p, { ...incoming,
        versions: { ...packages.get(p)?.versions, ...incoming.versions },
        time: { ...packages.get(p)?.time, [Object.keys(incoming.versions)[0]]: new Date().toISOString() },
      });
      res.writeHead(publishStatus); return res.end('{}');
    }
    if (p.includes("/-/")) return res.end("fake-tarball");
    const d = packages.get(p);
    res.writeHead(d ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(d ?? { error: "not found" }));
  });
  t.after(async () => { await close(registry); fs.rmSync(root, { recursive: true, force: true }); });
  const registryUrl = await listen(registry);
  const stateFile = path.join(root, "market.json");
  const options = { internalOrigin: "http://gateway.test:3090", stateFile, registry: registryUrl, authorization: "Basic fake-internal-credential", publicOrigin,
    authenticate: (req) => tokenUser(req, key, users),
    readUsers: () => users,
    sessionUser: (req) => req.headers.cookie === "test-session=admin" ? users[2] : req.headers.cookie === "test-session=alice" ? users[0] : null,
    admins: ["admin"], notify: async (notice) => { notices.push(notice); },
  };
  let handler = createMarket(options);
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, publicOrigin))) { res.writeHead(404); res.end(); } });
  t.after(async () => { await close(server); });
  const origin = await listen(server);
  const request = async (url, init = {}) => {
    const r = await fetch(origin + url, { redirect: "manual", ...init });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const publish = (slug, version, packageName = name) => request(`/_zp/npm/${encodeURIComponent(packageName)}`, { method: "PUT", headers: { ...bearer(slug), "content-type": "application/json" }, body: JSON.stringify(doc(version, packageName)) });
  const review = (version, action = "approved", headers = {}) => request("/_zp/market/admin", { method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin, ...headers }, body: new URLSearchParams({ name, version, action }) });
  const index = async () => JSON.parse((await request("/_zp/market/index.json", { headers: bearer("alice") })).text);
  return { origin, root, packages, requests, notices, options, request, publish, review, index, stateFile,
    restart: () => { handler = createMarket(options); }, rejectPublish: (status) => { publishStatus = status; } };
}

test("令牌检查 zpd 签名、期限与开通状态", () => {
  const req = (value) => ({ headers: { authorization: `Bearer ${value}` } });
  assert.equal(tokenUser(req(token("alice")), key, users)?.slug, "alice");
  assert.equal(tokenUser(req(token("alice").replace("zpd.", "zpc.")), key, users), null);
  assert.equal(tokenUser(req(issueToken(key, users[0], 0)), key, users), null);
  assert.equal(tokenUser(req(token("alice")), key, []), null);
  assert.equal(tokenUser(req(token("alice").slice(0, -2) + "xx"), key, users), null);
  for (const value of ["", "zpd.invalid.☃", "zpd.a.a", "Basic fake"]) assert.equal(tokenUser(req(value), key, users), null);
});

test("容器令牌写到本人数据卷，权限 600，重复签发仍能校验", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-token-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeContainerToken(key, users[0], root, null);
  writeContainerToken(key, users[0], root, null);
  const file = path.join(root, "alice/.zp-market-token");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(tokenUser({ headers: { authorization: `Bearer ${fs.readFileSync(file, "utf8").trim()}` } }, key, users)?.slug, "alice");
});

test("市场读写必须用桌面或容器令牌，不接受网页会话代替", async (t) => {
  const f = await fixture(t);
  for (const url of [route, `${route}/-/demo-1.0.0.tgz`, "/_zp/market/index.json"]) {
    assert.equal((await f.request(url)).status, 401);
    assert.equal((await f.request(url, { headers: { cookie: "test-session=admin" } })).status, 401);
  }
  assert.equal((await f.request("/_zp/market/index.json", { headers: bearer("alice") })).status, 200);
  assert.equal(f.requests.length, 0);
});

test("首发者拥有包，其他用户不能发新版本，同版本不能覆盖；重启后保持", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.publish("alice", "1.0.0")).status, 201);
  f.restart();
  assert.equal((await f.publish("bob", "1.0.1")).status, 403);
  assert.equal((await f.publish("alice", "1.0.0")).status, 409);
  assert.equal((await f.publish("alice", "1.0.1")).status, 201);
  const saved = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(saved.packages[name].owner, "alice");
  assert.equal(saved.packages[name].versions["1.0.1"].status, "pending");
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
});

test("并发首发只让一个用户取得所有权", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.publish("alice", "1.0.0"), f.publish("bob", "2.0.0")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403]);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
});

test("非公司 scope、删除、dist-tag、路径绕过与无效发布都不会到后端", async (t) => {
  const f = await fixture(t);
  for (const packageName of ["other", "@other/demo"]) assert.equal((await f.publish("alice", "1.0.0", packageName)).status, 403);
  for (const url of [route, `${route}/-rev/1`, "/_zp/npm/-/package/@crysound%2fdemo/dist-tags/latest"]) {
    assert.equal((await f.request(url, { method: "DELETE", headers: bearer("alice") })).status, 403);
  }
  assert.equal((await f.request(route + "/-rev/1", { method: "PUT", headers: bearer("alice"), body: "{}" })).status, 403);
  assert.equal((await f.request("/_zp/npm/@crysound%252fdemo", { headers: bearer("alice") })).status, 403);
  assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: "broken" })).status, 400);
  assert.equal((await f.publish("alice", "not-semver")).status, 400);
  assert.equal(f.requests.length, 0);
});

test("非法元数据和过大请求返回明确失败，不预留所有权或上传", async (t) => {
  const f = await fixture(t);
  const invalid = [null, {}, { ...doc(), versions: [] }];
  for (const field of ["description", "patch", "engines"]) {
    const d = doc(), manifest = d.versions["1.0.0"];
    if (field === "description") manifest.description = "  ";
    if (field === "patch") manifest.dsh.bundle.patch = "  ";
    if (field === "engines") manifest.engines = { dsh: "not-a-range" };
    invalid.push(d);
  }
  for (const body of invalid) {
    assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) })).status, 400);
  }
  f.options.maxBytes = 100; f.restart();
  const oversized = await f.publish("alice", "1.0.0");
  assert.equal(oversized.status, 413);
  assert.match(oversized.text, /发布内容过大/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test("审批前不进索引；批准后按 SemVer 列出所有已批准版本，拒绝和 pending 不参与", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.publish("alice", "1.9.0")).status, 201);
  assert.deepEqual((await f.index()).plugins, []);
  assert.equal((await f.review("1.9.0")).status, 303);
  await f.publish("alice", "1.10.0"); await f.review("1.10.0");
  await f.publish("alice", "2.0.0"); await f.review("2.0.0", "rejected");
  await f.publish("alice", "3.0.0");
  await f.publish("alice", "1.10.0-beta.1"); await f.review("1.10.0-beta.1");
  const idx = await f.index();
  assert.equal(idx.format, 1); assert.equal(idx.title, "兆华市场");
  assert.equal(idx.plugins.length, 1);
  assert.equal(idx.plugins[0].author, "测试发布者");
  const parsed = parseMarketIndex(idx, `${publicOrigin}/_zp/market/index.json`);
  assert.deepEqual(marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]), { spec: "@crysound/demo@1.10.0" });
  assert.deepEqual(idx.plugins[0].versions[0].source, { type: "npm" });
  assert.deepEqual(idx.plugins[0].versions.map((v) => v.version), ["1.10.0", "1.10.0-beta.1", "1.9.0"]);
  assert.equal((await f.review("2.0.0")).status, 409);
  f.restart(); assert.deepEqual(await f.index(), idx);
  assert.equal(f.notices.length, 5);
});

test("审批页只接受管理员飞书会话，并校验 POST 来源；展示内容转义", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0");
  assert.equal((await f.request("/_zp/market/admin")).status, 302);
  assert.equal((await f.request("/_zp/market/admin", { headers: bearer("admin") })).status, 302);
  assert.equal((await f.request("/_zp/market/admin", { headers: { cookie: "test-session=alice" } })).status, 403);
  const page = await f.request("/_zp/market/admin", { headers: { cookie: "test-session=admin" } });
  assert.equal(page.status, 200);
  assert.match(page.text, /中文插件/); assert.match(page.text, /测试 README/);
  assert.match(page.text, /&lt;script&gt;/); assert.doesNotMatch(page.text, /<script>/);
  assert.equal((await f.review("1.0.0", "approved", { origin: "https://evil.test" })).status, 403);
  assert.deepEqual((await f.index()).plugins, []);
});

test("元数据 tarball 改写到公网网关，tarball 可凭容器令牌下载；内部凭据不外传", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0");
  await f.review("1.0.0");
  const r = await f.request(route, { headers: { ...bearer("bob"), cookie: "must-not-forward=1", "if-none-match": "stale" } });
  assert.equal(r.status, 200);
  const url = JSON.parse(r.text).versions["1.0.0"].dist.tarball;
  assert.equal(url, `${publicOrigin}/_zp/npm/@crysound/demo/-/demo-1.0.0.tgz`);
  const download = await f.request(new URL(url).pathname, { headers: bearer("bob") });
  assert.equal(download.text, "fake-tarball");
  assert.equal(download.status, 200);
  assert.doesNotMatch(r.text, /fake-internal-credential/);
});

test("后端明确拒绝不占包；上传结果未知或 5xx 时保留不可审批记录", async (t) => {
  const f = await fixture(t);
  f.rejectPublish(400);
  assert.equal((await f.publish("alice", "1.0.0")).status, 400);
  f.rejectPublish(201);
  assert.equal((await f.publish("bob", "1.0.0")).status, 201);
  f.rejectPublish(503);
  assert.equal((await f.publish("bob", "2.0.0")).status, 502);
  assert.equal((await f.review("2.0.0")).status, 409);
  assert.equal((await f.publish("bob", "2.0.0")).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).packages[name].versions["2.0.0"].status, "publishing");
  assert.deepEqual((await f.index()).plugins, []);
});

test("上传连接中断保留 publishing，重启后仍禁止覆盖或审批", async (t) => {
  const f = await fixture(t);
  f.options.fetcher = (url, init) => init.method === "PUT" ? Promise.reject(new Error("fake connection reset")) : fetch(url, init);
  f.restart();
  const result = await f.publish("alice", "1.0.0");
  assert.equal(result.status, 502); assert.match(result.text, /上传结果未知/);
  f.restart();
  assert.equal((await f.publish("bob", "1.1.0")).status, 403);
  assert.equal((await f.publish("alice", "1.0.0")).status, 409);
  assert.equal((await f.review("1.0.0")).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).packages[name].versions["1.0.0"].status, "publishing");
});

test("注册表有包但没有所有权记录时拒绝接管，损坏记录不静默清空", async (t) => {
  const f = await fixture(t);
  f.packages.set(name, doc("0.1.0"));
  assert.equal((await f.publish("alice", "1.0.0")).status, 409);
  fs.writeFileSync(f.stateFile, "broken");
  assert.throws(f.restart);
});

test("内网元数据的 tarball 保持内网地址，匹配容器的 scope 令牌", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0");
  await f.review("1.0.0");
  f.options.internalOrigin = f.origin; f.restart();
  const r = await f.request(route, { headers: bearer("bob") });
  assert.equal(JSON.parse(r.text).versions["1.0.0"].dist.tarball, `${f.origin}/_zp/npm/@crysound/demo/-/demo-1.0.0.tgz`);
});

test("索引读取注册表元数据和兼容范围，缺失版本不列出；后端异常不伪装成空市场", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0");
  await f.review("1.0.0");
  const manifest = f.packages.get(name).versions["1.0.0"];
  Object.assign(manifest, { description: "注册表介绍", keywords: ["工作流"], engines: { dsh: ">=0.2.2" } });
  const idx = await f.index();
  assert.equal(idx.plugins[0].description, "注册表介绍");
  assert.deepEqual(idx.plugins[0].metadata.keywords, ["工作流"]);
  assert.deepEqual(idx.plugins[0].versions[0].engines, { dsh: ">=0.2.2" });
  delete f.packages.get(name).versions["1.0.0"];
  assert.deepEqual((await f.index()).plugins, []);
  f.packages.delete(name);
  assert.equal((await f.request("/_zp/market/index.json", { headers: bearer("alice") })).status, 502);
});

test("飞书通知失败保留待审批版本，管理员可从审批页重发卡片", async (t) => {
  const f = await fixture(t);
  f.options.notify = async () => { throw new Error("fake notification failure"); };
  f.restart();
  assert.equal((await f.publish("alice", "1.0.0")).status, 201);
  assert.equal((await f.review("1.0.0", "notify")).status, 502);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).packages[name].versions["1.0.0"].status, "pending");
  f.options.notify = async (notice) => { f.notices.push(notice); };
  f.restart();
  assert.equal((await f.review("1.0.0", "notify")).status, 303);
  assert.equal(f.notices.length, 1);
  assert.deepEqual((await f.index()).plugins, []);
});

test("未批准的包对其他人返回 404；仅发布者可读取和下载自己的 pending", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0");
  assert.deepEqual(f.requests.find((r) => r.method === "PUT").body["dist-tags"], {});
  for (const method of ["GET", "HEAD"]) {
    for (const url of [route, `${route}/1.0.0`, `${route}/latest`, `${route}/-/demo-1.0.0.tgz`]) {
      assert.equal((await f.request(url, { method, headers: bearer("bob") })).status, 404);
    }
    for (const url of [route, `${route}/1.0.0`, `${route}/-/demo-1.0.0.tgz`]) {
      assert.equal((await f.request(url, { method, headers: bearer("alice") })).status, 200);
    }
  }
  const pending = JSON.parse((await f.request(route, { headers: bearer("alice") })).text);
  assert.deepEqual(Object.keys(pending.versions), ["1.0.0"]);
  assert.deepEqual(Object.keys(pending.time), ["1.0.0"]);
  assert.deepEqual(pending["dist-tags"], {});
  await f.review("1.0.0", "rejected");
  for (const slug of ["alice", "bob"]) {
    for (const url of [route, `${route}/1.0.0`, `${route}/-/demo-1.0.0.tgz`]) {
      assert.equal((await f.request(url, { headers: bearer(slug) })).status, 404);
    }
  }
});

test("packument、版本与 tarball 共用审批权限；latest 按 SemVer 选择已批准版本", async (t) => {
  const f = await fixture(t);
  for (const version of ["1.10.0", "1.9.0", "1.10.0-beta.1", "2.0.0", "3.0.0"]) {
    await f.publish("alice", version);
    if (version !== "3.0.0") await f.review(version, version === "2.0.0" ? "rejected" : "approved");
  }
  const upstream = f.packages.get(name);
  upstream["dist-tags"] = { latest: "3.0.0", next: "3.0.0", rejected: "2.0.0", stable: "1.9.0" };
  upstream.versions["4.0.0"] = doc("4.0.0").versions["4.0.0"];
  upstream.time["4.0.0"] = new Date().toISOString();
  f.rejectPublish(503);
  assert.equal((await f.publish("alice", "5.0.0")).status, 502);
  upstream.versions["5.0.0"] = doc("5.0.0").versions["5.0.0"];
  upstream.time["5.0.0"] = new Date().toISOString();
  for (const slug of ["alice", "bob"]) {
    const response = await f.request(route, { headers: bearer(slug) });
    assert.equal(response.status, 200);
    const metadata = JSON.parse(response.text);
    const expected = ["1.10.0", "1.9.0", "1.10.0-beta.1", ...(slug === "alice" ? ["3.0.0"] : [])];
    assert.deepEqual(Object.keys(metadata.versions), expected);
    assert.deepEqual(Object.keys(metadata.time), expected);
    assert.deepEqual(metadata["dist-tags"], { stable: "1.9.0", latest: "1.10.0" });
    for (const selector of ["latest", "1.10.0", "stable"]) {
      const manifest = await f.request(`${route}/${selector}`, { headers: bearer(slug) });
      assert.equal(manifest.status, 200);
      assert.equal(JSON.parse(manifest.text).version, selector === "stable" ? "1.9.0" : "1.10.0");
    }
    for (const method of ["GET", "HEAD"]) {
      for (const selector of ["2.0.0", "4.0.0", "5.0.0", "next", "rejected"]) {
        assert.equal((await f.request(`${route}/${selector}`, { method, headers: bearer(slug) })).status, 404);
      }
      for (const version of ["2.0.0", "4.0.0", "5.0.0"]) {
        assert.equal((await f.request(`${route}/-/demo-${version}.tgz`, { method, headers: bearer(slug) })).status, 404);
      }
      assert.equal((await f.request(`${route}/3.0.0`, { method, headers: bearer(slug) })).status, slug === "alice" ? 200 : 404);
      assert.equal((await f.request(`${route}/-/demo-3.0.0.tgz`, { method, headers: bearer(slug) })).status, slug === "alice" ? 200 : 404);
    }
  }
  await f.review("3.0.0");
  const approved = JSON.parse((await f.request(route, { headers: bearer("bob") })).text);
  assert.equal(approved["dist-tags"].latest, "3.0.0");
});

test("索引作者没有姓名时使用 slug", async (t) => {
  const f = await fixture(t);
  await f.publish("bob", "1.0.0");
  await f.review("1.0.0");
  assert.equal((await f.index()).plugins[0].author, "bob");
});


test("兆华数据经同一审批进入普通市场索引，分类为数据，不发布独立数据目录", async (t) => {
  const f = await fixture(t);
  await f.publish("alice", "1.0.0", "@crysound/data");
  assert.equal((await f.index()).plugins.length, 0);
  assert.equal((await f.request("/_zp/market/admin", {
    method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin },
    body: new URLSearchParams({ name: "@crysound/data", version: "1.0.0", action: "approved" }),
  })).status, 303);
  const index = await f.index();
  assert.equal(index.plugins.length, 1);
  assert.equal(index.plugins[0].metadata.category, "data");
  assert.deepEqual(index.metadata.categories.data.title, { zh: "数据", en: "Data" });
  assert.equal(parseMarketIndex(index, `${publicOrigin}/_zp/market/index.json`).plugins[0].name, "@crysound/data");
  assert.equal((await f.request("/_zp/market/data.json", { headers: bearer("alice") })).status, 404);
});
