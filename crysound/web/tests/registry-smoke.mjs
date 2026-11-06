// 真实 npm publish → 网关 → Verdaccio → 审批 → pnpm 11 安装；只使用临时配置与假凭据。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createMarket } from "../gateway/market.mjs";
import { issueToken, tokenUser } from "../gateway/market-auth.mjs";

const tools = process.env.MARKET_TEST_TOOLS;
if (!tools) throw new Error("设置 MARKET_TEST_TOOLS 为隔离安装 verdaccio@6.1.6 和 pnpm@11 的目录");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-registry-smoke-"));
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
  NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
  NPM_CONFIG_CACHE: path.join(root, "cache"), COREPACK_ENABLE_PROJECT_SPEC: "0" };
fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
const registryConfig = fs.readFileSync(new URL("../market/verdaccio.yaml", import.meta.url), "utf8")
  .replace("/verdaccio/storage", path.join(root, "storage")).replace("/verdaccio/conf/htpasswd", path.join(root, "htpasswd"));
fs.writeFileSync(path.join(root, "config.yaml"), registryConfig);
const childScript = path.join(root, "registry.cjs");
fs.writeFileSync(childScript, `
const { createRequire } = require('node:module');
const requireTool = createRequire(${JSON.stringify(path.join(tools, "package.json"))});
const fs = require('node:fs');
const bcrypt = requireTool('bcryptjs');
fs.writeFileSync(${JSON.stringify(path.join(root, "htpasswd"))}, 'zp-gateway:' + bcrypt.hashSync('fake-internal-password', 4) + '\\n');
const { runServer } = requireTool('verdaccio');
runServer(${JSON.stringify(path.join(root, "config.yaml"))}).then(server => {
  server.listen(0, '127.0.0.1', () => process.send(server.address().port));
});
`);
const child = spawn(process.execPath, [childScript], { env, cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let registryLog = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (c) => { registryLog = (registryLog + c).slice(-8000); });
const stopped = once(child, "exit");
let gateway;
async function cli(script, args, cwd, overrides = {}, expectedCode = 0) {
  const proc = spawn(process.execPath, [script, ...args], { cwd, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (c) => { output = (output + c).slice(-12000); });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60000);
  try { const [code] = await once(proc, "exit"); assert.equal(code, expectedCode, output); return output; }
  finally { clearTimeout(timer); }
}
try {
  const readyTimeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Verdaccio 启动超时：${registryLog}`)), 20000);
    child.once("message", () => clearTimeout(timer));
    child.once("exit", () => clearTimeout(timer));
  });
  const port = await Promise.race([once(child, "message").then(([p]) => p), stopped.then(() => { throw new Error(registryLog); }), readyTimeout]);
  const registry = `http://127.0.0.1:${port}`;
  const key = "fake-signing-key", users = [{ slug: "alice", unionId: "fake-alice" }, { slug: "admin", unionId: "fake-admin" }];
  const token = issueToken(key, users[0]);
  let handler;
  gateway = http.createServer(async (req, res) => { await handler(req, res, new URL(req.url, "http://localhost")); });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  handler = createMarket({ stateFile: path.join(root, "market.json"), registry,
    authorization: `Basic ${Buffer.from("zp-gateway:fake-internal-password").toString("base64")}`,
    publicOrigin: origin, authenticate: (req) => tokenUser(req, key, users), readUsers: () => users, admins: ["admin"],
    sessionUser: (req) => req.headers.cookie === "fake-admin-session" ? users[1] : null,
  });
  assert.equal((await fetch(`${registry}/@crysound%2fdemo`)).status, 401);
  assert.equal((await fetch(`${origin}/_zp/npm/lodash`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  const pkg = path.join(root, "package"); fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "cordis.patch.yml"), "[]\n");
  const npm = fileURLToPath(new URL("../lib/node_modules/npm/bin/npm-cli.js", `file://${process.execPath}`));
  const pnpm = path.join(tools, "node_modules/pnpm/bin/pnpm.cjs");
  assert.match(await cli(pnpm, ["--version"], root), /^11\./);
  for (const version of ["1.0.0", "1.1.0"]) {
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@crysound/demo", version, description: "真实注册表冒烟包", type: "module", files: ["cordis.patch.yml"], dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
    fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, `@crysound:registry=${origin}/_zp/npm/\n//127.0.0.1:${gateway.address().port}/_zp/npm/:_authToken=${token}\n`, { mode: 0o600 });
    await cli(npm, ["publish", "--registry", `${origin}/_zp/npm/`, "--ignore-scripts", "--access", "restricted"], pkg);
    const index = await fetch(`${origin}/_zp/market/index.json`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    assert.equal(index.plugins.length, version === "1.0.0" ? 0 : 1);
    const review = await fetch(`${origin}/_zp/market/admin`, { method: "POST", redirect: "manual", headers: { cookie: "fake-admin-session", origin }, body: new URLSearchParams({ name: "@crysound/demo", version, action: "approved" }) });
    assert.equal(review.status, 303, await review.text());
  }
  const profile = path.join(root, "profile"); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "package.json"), '{"private":true}');
  // Profile .npmrc，而不是环境变量或用户配置，必须足以给 pnpm 提供 scope 与字面令牌。
  fs.copyFileSync(env.NPM_CONFIG_USERCONFIG, path.join(profile, ".npmrc"));
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
  const npmrc = path.join(profile, ".npmrc");
  const scopedConfig = fs.readFileSync(npmrc, "utf8");
  fs.writeFileSync(npmrc, `@crysound:registry=${origin}/_zp/npm/\n`);
  const denied = await cli(pnpm, ["view", "@crysound/demo@1.0.0", "--json", "--config.fetch-retries=0"], profile, {}, 1);
  assert.match(denied, /401/);
  fs.writeFileSync(npmrc, scopedConfig);
  await cli(pnpm, ["view", "@crysound/demo@1.0.0", "--json"], profile);
  await cli(pnpm, ["add", "@crysound/demo@1.0.0", "--ignore-scripts", "--store-dir", path.join(root, "store")], profile);
  const installed = JSON.parse(fs.readFileSync(path.join(profile, "node_modules/@crysound/demo/package.json")));
  assert.equal(installed.version, "1.0.0");
  assert.equal(fs.readFileSync(path.join(profile, "node_modules/@crysound/demo/cordis.patch.yml"), "utf8"), "[]\n");
  // 网页版使用 HOME 下的 user config，同样不能依赖 TOKEN 环境变量。
  fs.rmSync(npmrc);
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, scopedConfig);
  await cli(pnpm, ["add", "@crysound/demo@1.1.0", "--ignore-scripts", "--store-dir", path.join(root, "store")], profile);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "node_modules/@crysound/demo/package.json"))).version, "1.1.0");
  console.log("真实 Verdaccio 6.1.6：npm 两次发布、飞书会话审批、pnpm 11 profile .npmrc 鉴权查询和安装成功。");
} finally {
  if (gateway) { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await stopped;
  clearTimeout(killTimer);
  fs.rmSync(root, { recursive: true, force: true });
}
