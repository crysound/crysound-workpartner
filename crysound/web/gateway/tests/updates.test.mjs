import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { issueToken, tokenUser } from "../market-auth.mjs";
import { serveMacUpdate } from "../updates.mjs";

async function gateway(t) {
  const directory = await mkdtemp(join(tmpdir(), "company-update-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feed = '{"version":"0.2.3"}\n';
  const zip = Buffer.from([0x50, 0x4b, 0, 255, 42]);
  await writeFile(join(directory, "latest-mac.yml"), feed);
  await writeFile(join(directory, "release-mac-arm64.zip"), zip);
  await mkdir(join(directory, "directory.zip"));
  const key = "test-only-gateway-key";
  const user = { unionId: "test-user", slug: "test-user" };
  const authorization = `Bearer ${issueToken(key, user)}`;
  // Run the actual public dispatch and old-host policy without starting Docker, login or background services.
  const source = await readFile(new URL("../gateway.mjs", import.meta.url), "utf8");
  const policyStart = source.indexOf("const servedOnOldHost =");
  const policyEnd = source.indexOf(";", policyStart) + 1;
  const start = source.indexOf("const server = http.createServer(");
  const end = source.indexOf("\n});", start) + "\n});".length;
  assert.ok(policyStart >= 0 && policyEnd > policyStart && start >= 0 && end > start);
  const server = new Function("dependencies", `
    const { http, PUBLIC_HOST, OLD_HOSTS, redirect, page, preview, userFor, dailyPublic, treg, feishu, feishuSettings, market, serveMacUpdate, desktopUser } = dependencies;
    ${source.slice(policyStart, policyEnd)}
    ${source.slice(start, end)}
    return server;
  `)({
    http, PUBLIC_HOST: "gateway.example.test", OLD_HOSTS: ["old.example.test"],
    redirect: (res, location) => { res.writeHead(302, { location }); res.end(); },
    page: (res, status, title) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(title); },
    preview: { handle: async () => false, isPreviewHost: () => false },
    userFor: () => ({}), dailyPublic: async () => false, treg: async () => false,
    feishu: { handle: async () => false }, feishuSettings: async () => false, market: async () => false,
    serveMacUpdate: (req, res, pathname, authenticate) => serveMacUpdate(req, res, pathname, authenticate, directory),
    desktopUser: req => tokenUser(req, key, [user]),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = (name, { method = "GET", token = authorization, host = "gateway.example.test", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
      path: `/_zp/updates/mac/${name}`, method,
      headers: { host, ...token ? { authorization: token } : {}, ...headers },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { request, authorization, feed, zip, key, user };
}

test("Mac feed and archives require a valid current passport, including on the old host", async t => {
  const { request, feed, zip, key, user } = await gateway(t);
  for (const host of ["gateway.example.test", "old.example.test"]) {
    for (const token of ["", "Bearer invalid", `Bearer ${issueToken("wrong-key", user)}`,
      `Bearer ${issueToken(key, user, 0)}`, `Bearer ${issueToken(key, { unionId: "not-provisioned" })}`]) {
      const response = await request("latest-mac.yml", { token, host });
      assert.equal(response.status, 401);
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    const metadata = await request("latest-mac.yml?noCache=123", { host });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers["cache-control"], "no-cache");
    assert.equal(metadata.bytes.toString(), feed);
    const archive = await request("release-mac-arm64.zip", { host, headers: { range: "bytes=0-1" } });
    assert.equal(archive.status, 200);
    assert.equal(archive.headers["cache-control"], "no-store");
    assert.deepEqual(archive.bytes, zip);
  }
});

test("HEAD returns file headers without bytes; missing, unsafe and write requests cannot read files", async t => {
  const { request, zip, feed } = await gateway(t);
  for (const [name, bytes, cache] of [["latest-mac.yml", Buffer.from(feed), "no-cache"], ["release-mac-arm64.zip", zip, "no-store"]]) {
    const response = await request(name, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers["content-length"]), bytes.length);
    assert.equal(response.headers["cache-control"], cache);
    assert.equal(response.bytes.length, 0);
  }
  assert.equal((await request("latest-mac.yml", { method: "HEAD", token: "" })).status, 401);
  for (const name of ["", "missing.zip", "update.zip.blockmap", "directory.zip", "a..zip", "%2e%2e%2fsecret", "%2Fsecret", "nested/file.zip", "bad%20file.zip", ".zip%00"]) {
    assert.equal((await request(name)).status, 404, name);
  }
  const write = await request("latest-mac.yml", { method: "POST" });
  assert.equal(write.status, 405);
  assert.equal(write.headers.allow, "GET, HEAD");
  assert.equal((await request("latest-mac.yml")).bytes.toString(), feed);
});
