import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { dataCategories, createDataCatalog } from "../treg-catalog.mjs";
import { issueToken, tokenUser } from "../market-auth.mjs";

const key = "test-only-signing-key";
const user = { slug: "zptest", unionId: "test-user" };
const headers = { authorization: `Bearer ${issueToken(key, user)}` };
const row = (slug, category, usd = 0.001) => ({ slug, label: slug, category, price_from: { usd }, private: "must-not-be-exposed" });
const fixture = { platforms: [
  row("web", "SEO/AEO", 0.00000012), row("google", "SEO/AEO", 0.001), row("people", "Enrichment"),
  row("youtube", "Social"), row("meta-ads", "Advertising"), row("amazon", "E-commerce"),
  row("app-store", "Reviews & Apps"), row("github", "Developer"), row("stocks", "Market data"),
  row("research", "Research & public data"), row("hackernews", "Community"),
  row("video-gen", "AI generation"), row("unknown", "Future category"),
] };

async function start(t, options = {}) {
  const handler = createDataCatalog({
    enabled: true, authenticate: (req) => tokenUser(req, key, [user]), sessionUser: () => null,
    fetcher: async () => Response.json(fixture), ...options,
  });
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, "http://fixture.test"))) { res.writeHead(404); res.end(); }
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return (init = {}, path = "/_zp/market/data.json") => fetch(base + path, init);
}

test("七个中文分类按指定顺序，其他合并四类，AI 与未知类不展示", () => {
  const cards = dataCategories(fixture);
  assert.deepEqual(cards.map((card) => card.name), ["SEO 与搜索", "人员与公司", "社交媒体", "广告与达人营销", "电商", "评价与应用商店", "其他"]);
  assert.equal(cards[0].priceFromUsd, 0.00000012);
  assert.deepEqual(cards[6].platforms.map((platform) => platform.slug), ["github", "stocks", "research", "hackernews"]);
  assert.doesNotMatch(JSON.stringify(cards), /video-gen|unknown|must-not-be-exposed/);
  assert.ok(cards.every((card) => card.package === "@crysound/data" && card.examples.length >= 3 && card.examples.length <= 4 && card.prompt));
});

test("未知起步价显示 null，零价格保留，外部价格或平台字段损坏拒绝整份目录", () => {
  assert.equal(dataCategories({ platforms: [row("web", "SEO/AEO", null)] })[0].priceFromUsd, null);
  assert.equal(dataCategories({ platforms: [row("web", "SEO/AEO", 0)] })[0].priceFromUsd, 0);
  for (const platforms of [[], [row("web", "SEO/AEO", -1)], [row("web", "SEO/AEO", "0.01")],
    [row("../admin", "Social")], [row("web", "Social"), row("web", "Social")]]) {
    assert.throws(() => dataCategories({ platforms }));
  }
});

test("启动取一次公共目录，并发请求复用；不转发用户或组织凭据", async (t) => {
  const calls = [];
  const request = await start(t, { fetcher: async (url, init) => {
    calls.push({ url, init });
    return Response.json(fixture);
  } });
  const responses = await Promise.all([request({ headers }), request({ headers }), request({ headers })]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(bodies[0], bodies[2]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://treg.to/catalog/platforms");
  assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(bodies[0].fetchedAt);
  assert.match(responses[0].headers.get("cache-control"), /no-store/);
});

test("只接受已开通人的签名令牌或已验证网页身份，伪造头和他人的未开通令牌无效", async (t) => {
  const request = await start(t);
  for (const auth of [undefined, "Bearer fake", `Bearer ${issueToken(key, { unionId: "other" })}`, `Bearer ${issueToken("wrong-key", user)}`]) {
    const response = await request({ headers: { ...(auth ? { authorization: auth } : {}), "x-treg-meta": "user=zptest", cookie: "zp_sid=unverified" } });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /登录/);
  }
  const sessionRequest = await start(t, { sessionUser: () => user });
  const sessionResponse = await sessionRequest();
  assert.equal(sessionResponse.status, 200);
  await sessionResponse.json();
  const post = await request({ headers, method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  await post.json();
  const other = await request({ headers }, "/_zp/market/other");
  assert.equal(other.status, 404);
  await other.text();
});

test("功能关闭不连接上游，目录失败时返回中文且不泄漏原始错误，也不按请求重试", async (t) => {
  let calls = 0;
  const disabled = await start(t, { enabled: false, fetcher: async () => { calls++; throw new Error("must not run"); } });
  const response = await disabled({ headers });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未开放/);
  assert.equal(calls, 0);
  for (const fetcher of [
    async () => { throw new Error("private balance and billing URL"); },
    async () => new Response("private balance and billing URL", { status: 402 }),
    async () => new Response("invalid JSON"),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    calls = 0;
    const request = await start(t, { fetcher: async (...args) => { calls++; return fetcher(...args); } });
    for (let i = 0; i < 2; i++) {
      const failed = await request({ headers });
      assert.equal(failed.status, 503);
      const body = await failed.text();
      assert.match(body, /暂时无法读取/);
      assert.doesNotMatch(body, /private|billing|JSON/);
    }
    assert.equal(calls, 1);
  }
});
