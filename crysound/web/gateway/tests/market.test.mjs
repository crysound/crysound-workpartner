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

async function fixture(t, official = {}) {
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
    admins: ["admin"], notify: async (notice) => { notices.push(notice); }, ...official,
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

test("公司官方显示名、作者和标识来自管理员指定的账号与包；普通同事不能自称官方", async (t) => {
  const f = await fixture(t, { officialPublishers: ["alice"], officialPackages: ["@crysound/*"] });
  for (const [packageName, publisher, displayName] of [
    ["@crysound/design", "alice", undefined], ["@crysound/motion", "alice", undefined],
    ["@crysound/colleague", "bob", "同事工具"], ["@crysound/custom", "alice", "兆华示例工具"],
  ]) {
    const body = doc("1.0.0", packageName);
    Object.assign(body.versions["1.0.0"], { ...(displayName ? { displayName } : {}), author: "兆华工作伙伴", official: true, metadata: { labels: ["crysound-official"] } });
    assert.equal((await f.request(`/_zp/npm/${encodeURIComponent(packageName)}`, { method: "PUT", headers: bearer(publisher), body: JSON.stringify(body) })).status, 201);
    assert.equal((await f.request("/_zp/market/admin", { method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin }, body: new URLSearchParams({ name: packageName, version: "1.0.0", action: "approved" }) })).status, 303);
  }
  const parsed = parseMarketIndex(await f.index(), `${publicOrigin}/_zp/market/index.json`);
  for (const [packageName, title] of [["@crysound/design", "兆华设计"], ["@crysound/motion", "兆华动画"], ["@crysound/custom", "兆华示例工具"]]) {
    const entry = parsed.plugins.find((p) => p.name === packageName);
    assert.equal(entry.title, title);
    assert.equal(entry.author, "兆华工作伙伴");
    assert.deepEqual(entry.metadata.labels, ["crysound-official", "crysound-maintainer:alice"]);
    assert.equal(marketInstallTarget(entry.name, entry.versions[0]).spec, `${packageName}@1.0.0`);
  }
  assert.deepEqual(parsed.metadata.labels["crysound-official"].title, { zh: "兆华官方", en: "CRYSOUND official" });
  assert.deepEqual(parsed.metadata.labels["crysound-maintainer:alice"].title, { zh: "维护：测试发布者", en: "Maintained by 测试发布者" });
  const colleague = parsed.plugins.find((p) => p.name === "@crysound/colleague");
  assert.equal(colleague.title, "同事工具");
  assert.equal(colleague.author, "bob");
  assert.deepEqual(colleague.metadata.labels, []);
  // 换成精确包名单后，发布账号本身不足以使其余包成为官方。
  f.options.officialPackages = ["@crysound/design"];
  f.restart();
  assert.deepEqual((await f.index()).plugins.find((p) => p.name === "@crysound/motion").metadata.labels, []);
});

test("官方维护姓名独立于发布账号；分类、包内图片及最新顺序经原生索引解析保留", async (t) => {
  const f = await fixture(t, { officialPublishers: ["alice"], officialPackages: ["@crysound/*"], officialMaintainers: { "@crysound/data": ["admin"] } });
  const preview = "data:image/png;base64,iVBORw0KGgo=";
  for (const [packageName, publisher, fields] of [
    ["@crysound/older", "bob", { keywords: ["文档与报告", 5] }],
    ["@crysound/data", "alice", { keywords: ["销售与市场"], dsh: { bundle: { patch: "./cordis.patch.yml" }, market: { preview } } }],
    ["@crysound/newer", "bob", { labels: ["设计"], dsh: { bundle: { patch: "./cordis.patch.yml" }, market: { preview: "https://private.example.test/picture?token=secret" } } }],
  ]) {
    const body = doc("1.0.0", packageName);
    Object.assign(body.versions["1.0.0"], fields);
    assert.equal((await f.request(`/_zp/npm/${encodeURIComponent(packageName)}`, { method: "PUT", headers: bearer(publisher), body: JSON.stringify(body) })).status, 201);
    assert.equal((await f.request("/_zp/market/admin", { method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin }, body: new URLSearchParams({ name: packageName, version: "1.0.0", action: "approved" }) })).status, 303);
  }
  const state = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  state.packages["@crysound/older"].versions["1.0.0"].publishTimestamp = 100;
  state.packages["@crysound/newer"].versions["1.0.0"].publishTimestamp = 200;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  f.restart();
  const parsed = parseMarketIndex(await f.index(), `${publicOrigin}/_zp/market/index.json`);
  assert.deepEqual(parsed.plugins.map((p) => p.name), ["@crysound/data", "@crysound/newer", "@crysound/older"]);
  const [data, newer, older] = parsed.plugins;
  assert.equal(data.title, "兆华数据");
  assert.equal(data.author, "兆华工作伙伴");
  assert.equal(data.metadata.category, "data");
  assert.equal(data.icon, preview);
  assert.deepEqual(data.metadata.labels, ["crysound-official"]); // Unnamed accounts never leak a slug as a name.
  assert.equal(newer.metadata.category, "design");
  assert.equal(newer.icon, undefined);
  assert.equal(older.metadata.category, "documents");
  assert.deepEqual(older.metadata.keywords, ["文档与报告"]);
  assert.equal(Object.keys(parsed.metadata.categories).length, 7);
  const manifest = f.packages.get("@crysound/data").versions["1.0.0"];
  const maxPreview = "data:image/png;base64," + Buffer.alloc(32 * 1024).toString("base64");
  manifest.dsh.market.preview = maxPreview;
  assert.equal(parseMarketIndex(await f.index(), publicOrigin).plugins[0].icon, maxPreview);
  for (const invalid of ["data:image/png;base64,a", "data:image/png;base64," + Buffer.alloc(32 * 1024 + 1).toString("base64")]) {
    manifest.dsh.market.preview = invalid;
    assert.equal(parseMarketIndex(await f.index(), publicOrigin).plugins[0].icon, undefined);
  }
  f.options.officialMaintainers["@crysound/data"] = ["alice"];
  f.restart();
  assert.deepEqual((await f.index()).plugins[0].metadata.labels, ["crysound-official", "crysound-maintainer:alice"]);
});

test("显示名优先 displayName，其次 title；旧包仍显示包名，非法显示名拒绝发布", async (t) => {
  const f = await fixture(t);
  for (const [version, fields, title] of [
    ["1.0.0", {}, undefined], ["1.1.0", { title: "中文工具" }, "中文工具"],
    ["1.2.0", { title: "备用标题", displayName: "首选标题" }, "首选标题"],
  ]) {
    const body = doc(version);
    Object.assign(body.versions[version], fields);
    assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) })).status, 201);
    await f.review(version);
    const entry = (await f.index()).plugins[0];
    assert.equal(entry.title, title);
    assert.deepEqual(entry.metadata.labels, []);
  }
  for (const field of ["displayName", "title"]) {
    for (const value of ["", " ", 3, {}, "字".repeat(81)]) {
      const body = doc("2.0.0");
      body.versions["2.0.0"][field] = value;
      assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) })).status, 400);
    }
  }
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

test("指定官方维护人可续发但不能覆盖，每版仍需审批；普通包仍由首发者持有", async (t) => {
  const f = await fixture(t, { officialPlugins: { [name]: { displayName: "兆华示例", maintainers: ["bob"] } }, officialPublishers: ["alice"] });
  assert.equal((await f.publish("admin", "1.0.0")).status, 403);
  assert.equal((await f.publish("alice", "1.0.0")).status, 201);
  assert.equal((await f.publish("bob", "1.1.0")).status, 201);
  assert.equal((await f.publish("admin", "1.2.0")).status, 403);
  assert.equal((await f.publish("bob", "1.1.0")).status, 409);
  assert.equal((await f.index()).plugins.length, 0);
  // The actual uploader can inspect its own pending release, including a first release by a maintainer.
  assert.equal((await f.request(`${route}/1.1.0`, { headers: bearer("bob") })).status, 200);
  assert.equal((await f.request(`${route}/1.1.0`, { headers: bearer("admin") })).status, 404);
  assert.equal((await f.review("1.1.0")).status, 303);
  let index = await f.index();
  assert.equal(index.plugins[0].title, "兆华示例");
  assert.deepEqual(index.plugins[0].versions.map((row) => row.version), ["1.1.0"]);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).packages[name].owner, "alice");
  f.options.officialPlugins[name].maintainers = ["admin"];
  f.restart();
  assert.equal((await f.publish("bob", "1.2.0")).status, 403);
  assert.equal((await f.publish("admin", "1.2.0")).status, 201);
  assert.equal((await f.publish("bob", "1.0.0", "@crysound/personal")).status, 201);
  assert.equal((await f.publish("admin", "1.1.0", "@crysound/personal")).status, 403);
});

test("官方中文名和维护姓名来自配置，部署名单优先；无效官方配置启动即拒绝", async (t) => {
  const f = await fixture(t, { officialPlugins: { [name]: { displayName: "兆华配置名", maintainers: ["bob"] } }, officialMaintainers: { [name]: ["alice"] } });
  assert.equal((await f.publish("bob", "1.0.0")).status, 403);
  assert.equal((await f.publish("alice", "1.0.0")).status, 201);
  await f.review("1.0.0");
  const index = await f.index();
  assert.equal(index.plugins[0].title, "兆华配置名");
  assert.equal(index.metadata.labels["crysound-maintainer:alice"].title.zh, "维护：测试发布者");
  for (const officialPlugins of [[], { [name]: { displayName: "普通名", maintainers: [] } }, { [name]: { displayName: "兆华示例", maintainers: [3] } }]) {
    assert.throws(() => createMarket({ ...f.options, officialPlugins }), /官方插件配置/);
  }
});

test("退役插件从索引和引导消失，包、审批记录及其他插件保留", async (t) => {
  const f = await fixture(t, { officialPlugins: { [name]: { displayName: "兆华示例", maintainers: ['alice'] } } });
  await f.publish("alice", "1.0.0");
  await f.review("1.0.0");
  assert.equal((await f.index()).plugins[0].name, name);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  f.options.retiredPackages = [name, 'dsh-slidestudio']; f.restart();
  assert.deepEqual((await f.index()).plugins, []);
  assert.deepEqual(JSON.parse((await f.request('/_zp/market/guides.json', { headers: bearer('alice') })).text).guides, []);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.ok(f.packages.has(name));
  f.options.retiredPackages = ['@crysound/memory']; f.restart();
  assert.equal((await f.index()).plugins[0].name, name);
  for (const retiredPackages of [null, {}, ['../invalid']]) assert.throws(() => createMarket({ ...f.options, retiredPackages }), /退役插件配置/);
});

test("非官方显示名、备用名称及包名不得以兆华开头，拒绝发生在注册表写入前", async (t) => {
  const f = await fixture(t);
  for (const field of ["displayName", "title"]) {
    const body = doc(); body.versions["1.0.0"][field] = " 兆华假冒";
    const r = await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) });
    assert.equal(r.status, 403); assert.match(r.text, /兆华.*仅供官方/);
  }
  const bad = await f.publish("alice", "1.0.0", "@crysound/兆华假冒");
  assert.equal(bad.status, 403); assert.match(bad.text, /兆华.*仅供官方/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.publish("alice", "1.0.0")).status, 201);
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

test("包内引导只读已批准官方版本，首页开关来自公司名单；网页与桌面均需本人身份", async (t) => {
  const f = await fixture(t, { officialPlugins: { [name]: { displayName: "兆华示例", maintainers: ["alice"], home: true } } });
  const guide = { zh: { summary: "整理文件", prompt: "使用示例插件", examples: ["整理报告", "生成清单", "检查格式"] }, en: { summary: "Organize files", prompt: "Use the example plugin", examples: ["Organize a report", "Make a list", "Check formatting"] } };
  const publish = async (version, summary) => {
    const body = doc(version); body.versions[version].dsh.market = { guide: { ...guide, zh: { ...guide.zh, summary } } };
    return f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) });
  };
  const endpoint = "/_zp/market/guides.json";
  assert.equal((await f.request(endpoint)).status, 401);
  assert.equal((await publish("1.0.0", "批准的说明")).status, 201);
  assert.deepEqual(JSON.parse((await f.request(endpoint, { headers: bearer("bob") })).text).guides, []);
  await f.review("1.0.0");
  await publish("2.0.0", "尚未批准的说明");
  for (const headers of [bearer("bob"), { cookie: "test-session=alice" }]) {
    const response = await f.request(endpoint, { headers });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).guides[0].version, "1.0.0");
    assert.equal(JSON.parse(response.text).guides[0].guide.zh.summary, "批准的说明");
    assert.equal(JSON.parse(response.text).guides[0].home, true);
    assert.equal(JSON.parse(response.text).guides[0].title, "兆华示例");
  }
  const malformed = doc("3.0.0"); malformed.versions["3.0.0"].dsh.market = { guide: { zh: guide.zh } };
  assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(malformed) })).status, 400);
  f.options.officialPlugins = {}; f.restart();
  assert.deepEqual(JSON.parse((await f.request(endpoint, { headers: bearer("alice") })).text).guides, []);
});

test("审批持久化后通知原发布人，拒绝原因转义且重启可见，重复审批不重复发消息", async (t) => {
  const deliveries = [];
  const f = await fixture(t, { notifyPublisher: async (notice) => {
    const persisted = JSON.parse(fs.readFileSync(f.stateFile, "utf8")).packages[name].versions[notice.version];
    assert.equal(persisted.status, notice.status, "review must be committed before messaging");
    deliveries.push(notice);
    return { status: "sent" };
  } });
  const submit = (version, action, reason = "") => f.request("/_zp/market/admin", {
    method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin },
    body: new URLSearchParams({ name, version, action, reason, publisher: "bob" }),
  });
  for (const [version, action, reason] of [["1.0.0", "approved", ""], ["2.0.0", "rejected", "请补说明 <script>alert(1)</script> <SCRIPT>alert(2)</SCRIPT>"]]) {
    const body = doc(version); body.versions[version].displayName = "示例插件";
    assert.equal((await f.request(route, { method: "PUT", headers: bearer("alice"), body: JSON.stringify(body) })).status, 201);
    assert.equal((await submit(version, action, reason)).status, 303);
    assert.equal((await submit(version, action, reason)).status, 409);
  }
  assert.deepEqual(deliveries.map(({ publisher, status, displayName }) => ({ publisher, status, displayName })), [
    { publisher: "alice", status: "approved", displayName: "示例插件" }, { publisher: "alice", status: "rejected", displayName: "示例插件" },
  ]);
  assert.equal(deliveries[1].reason, "请补说明 <script>alert(1)</script> <SCRIPT>alert(2)</SCRIPT>");
  f.restart();
  const page = await f.request("/_zp/market/admin", { headers: { cookie: "test-session=admin" } });
  assert.match(page.text, /已审批记录/); assert.match(page.text, /已批准上架/); assert.match(page.text, /未通过审批/);
  assert.match(page.text, /请补说明 &lt;script&gt;alert\(1\)&lt;\/script&gt; &lt;SCRIPT&gt;alert\(2\)&lt;\/SCRIPT&gt;/);
  assert.doesNotMatch(page.text, /<script\b/i);
  assert.equal((page.text.match(/发布人机器人通知已发送/g) || []).length, 2);
  const index = await f.index();
  assert.deepEqual(index.plugins[0].versions.map(({ version }) => version), ["1.0.0"]);
});

test("未开通机器人和通知故障不回滚审批；旧记录仍可读，拒绝原因有长度限制", async (t) => {
  for (const outcome of ["unavailable", "failed"]) {
    await t.test(outcome, async (t) => {
      const f = await fixture(t, { notifyPublisher: async () => {
        if (outcome === "failed") throw new Error("offline");
        return { status: "unavailable", message: "尚不能接收公司机器人消息" };
      } });
      await f.publish("alice", "1.0.0");
      const submit = (action, reason) => f.request("/_zp/market/admin", { method: "POST", headers: { cookie: "test-session=admin", origin: publicOrigin }, body: new URLSearchParams({ name, version: "1.0.0", action, reason }) });
      assert.equal((await submit("rejected", "长".repeat(1001))).status, 400);
      assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).packages[name].versions["1.0.0"].status, "pending");
      assert.equal((await submit("approved", "")).status, 303);
      const data = JSON.parse(fs.readFileSync(f.stateFile));
      assert.equal(data.packages[name].versions["1.0.0"].reviewNotification.status, outcome);
      f.restart();
      assert.equal((await f.index()).plugins.length, 1);
      const page = await f.request("/_zp/market/admin", { headers: { cookie: "test-session=admin" } });
      assert.match(page.text, outcome === "failed" ? /暂未确认通知送达/ : /尚不能接收公司机器人消息/);
      delete data.packages[name].versions["1.0.0"].reviewNotification;
      delete data.packages[name].versions["1.0.0"].displayName;
      fs.writeFileSync(f.stateFile, JSON.stringify(data)); f.restart();
      assert.match((await f.request("/_zp/market/admin", { headers: { cookie: "test-session=admin" } })).text, /未确认通知送达/);
    });
  }
});

test("并发批准与拒绝只保存一个决定、发送一条结果通知", async (t) => {
  const deliveries = [];
  const f = await fixture(t, { notifyPublisher: async (notice) => { deliveries.push(notice); return { status: "sent" }; } });
  await f.publish("alice", "1.0.0");
  const results = await Promise.all([f.review("1.0.0", "approved"), f.review("1.0.0", "rejected")]);
  assert.deepEqual(results.map(r => r.status).sort(), [303, 409]);
  assert.equal(deliveries.length, 1);
  const saved = JSON.parse(fs.readFileSync(f.stateFile)).packages[name].versions["1.0.0"];
  assert.equal(saved.status, deliveries[0].status);
});

test("审批保存失败不发消息，通知状态保存失败仍保留决定且不宣称送达", async (t) => {
  const deliveries = [];
  const f = await fixture(t, { notifyPublisher: async (notice) => {
    deliveries.push(notice);
    fs.mkdirSync(f.stateFile + ".tmp");
    return { status: "sent" };
  } });
  await f.publish("alice", "1.0.0");
  fs.mkdirSync(f.stateFile + ".tmp");
  assert.equal((await f.review("1.0.0")).status, 500);
  assert.equal(deliveries.length, 0);
  fs.rmdirSync(f.stateFile + ".tmp");
  assert.equal((await f.review("1.0.0")).status, 303);
  f.restart();
  assert.equal((await f.index()).plugins.length, 1);
  const page = await f.request("/_zp/market/admin", { headers: { cookie: "test-session=admin" } });
  assert.match(page.text, /未确认通知送达/);
  assert.doesNotMatch(page.text, /机器人通知已发送/);
});
