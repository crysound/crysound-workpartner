import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareSkills, prepareWrappers, prepareSkillProfile } from "./setup.mjs";
import { createSettingsHandler } from "./settings.mjs";
import { createProject } from "./project.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-feishu-cli-test-"));
  t.after(() => {
    for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (e.isDirectory()) fs.chmodSync(path.join(e.parentPath, e.name), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const execute = (file, args = [], env = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
  child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
});

test("官方技能和参考资料完整、固定、只读；重复准备不覆盖个人 AGENTS.md", (t) => {
  const root = temp(t); fs.writeFileSync(path.join(root, "AGENTS.md"), "personal instructions");
  const skills = prepareSkills(root); const entries = fs.readdirSync(skills);
  for (const name of ["lark-doc", "lark-sheets", "lark-base", "lark-calendar", "lark-im", "lark-mail", "lark-approval", "lark-task", "lark-wiki", "lark-drive", "lark-contact", "lark-meeting", "meegle", "company-feishu"]) assert.ok(entries.includes(name), name);
  assert.ok(fs.existsSync(path.join(skills, "lark-shared", "references", "lark-shared-high-risk-approval.md")));
  assert.equal(fs.statSync(skills).mode & 0o777, 0o555); assert.equal(fs.statSync(path.join(skills, "lark-doc", "SKILL.md")).mode & 0o777, 0o444);
  assert.equal(prepareSkills(root), skills); assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "personal instructions");
  assert.equal(fs.readFileSync(path.join(skills, "company-feishu", "SKILL.md"), "utf8"), fs.readFileSync(new URL("../config/skills/company-feishu/SKILL.md", import.meta.url), "utf8"));
  const patch = path.join(root, "cordis.patch.yml"); fs.writeFileSync(patch, "- id: mine\n  config:\n    keep: true\n");
  prepareSkillProfile(patch); const first = fs.readFileSync(patch, "utf8"); prepareSkillProfile(patch);
  assert.equal(fs.readFileSync(patch, "utf8"), first); assert.match(first, /keep: true/); assert.match(first, /includeDefaultRoots: false/);
});

async function cliFixture(t, kind = "container") {
  const root = temp(t), realBin = path.join(root, "real"), bin = path.join(root, "bin"); fs.mkdirSync(realBin);
  const fake = `#!${process.execPath}\nif(process.argv.includes('--help'))process.exit(0);if(process.argv[2]==='auth'&&process.argv[3]==='status'){console.log(JSON.stringify({authenticated:false,reason:'no local token'}));process.exit(1)}console.log(JSON.stringify({argv:process.argv.slice(2),strict:process.env.LARKSUITE_CLI_STRICT_MODE,as:process.env.LARKSUITE_CLI_DEFAULT_AS,app:process.env.LARKSUITE_CLI_APP_ID,hasUser:!!process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,hasSecret:!!process.env.LARKSUITE_CLI_APP_SECRET,hasBot:!!process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN}));process.exit(10);\n`;
  for (const name of ["lark-cli", "meegle"]) fs.writeFileSync(path.join(realBin, name), fake, { mode: 0o755 });
  const identityFile = path.join(root, "identity"); fs.writeFileSync(identityFile, kind === "container" ? "fake-container-identity" : JSON.stringify({ token: "fake-desktop-identity" }));
  let authorized = true, requests = 0;
  const server = http.createServer((req, res) => { requests++; assert.equal(req.headers.authorization, `Bearer fake-${kind}-identity`); assert.equal(req.method, "POST"); res.writeHead(authorized ? 200 : 409, { "content-type": "application/json" }); res.end(JSON.stringify(authorized ? { user_access_token: "fake-short-token", app_id: "fake-app-id", expires_at: Date.now() / 1000 + 7200 } : { message: "需要授权飞书", authorization_url: "https://partner.example.test/_zp/feishu/connect" })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const configFile = path.join(root, "config.json");
  prepareWrappers({ kind, bin, realBin, execPath: process.execPath, identityFile, tokenUrl: `http://127.0.0.1:${server.address().port}/token`, authorizationUrl: "https://partner.example.test/_zp/feishu/", meegleHost: "project.example.test" }, configFile);
  return { root, realBin, bin, configFile, run: (name, args, env) => execute(path.join(bin, name), args, env), unauthorize: () => { authorized = false; }, requests: () => requests };
}

for (const kind of ["container", "desktop"]) test(`${kind} 包装器领取本人短期令牌，强制 user，保持确认退出码且不自动追加 yes`, async (t) => {
  const f = await cliFixture(t, kind);
  const r = await f.run("lark-cli", ["im", "+send", "--text", "literal $(not-executed) & value"], { LARKSUITE_CLI_STRICT_MODE: "bot", LARKSUITE_CLI_APP_SECRET: "fake-ambient-secret", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "fake-bot" });
  assert.equal(r.code, 10, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.strict, "user"); assert.equal(out.as, "user"); assert.equal(out.hasBot, false); assert.equal(out.hasSecret, false); assert.equal(out.hasUser, true); assert.equal(out.app, "fake-app-id");
  assert.deepEqual(out.argv, ["im", "+send", "--text", "literal $(not-executed) & value"]);
  assert.ok(!r.stdout.includes("fake-short-token")); assert.ok(!r.stderr.includes("fake-short-token"));
  assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
  f.unauthorize(); const denied = await f.run("lark-cli", ["calendar", "+agenda"]); assert.equal(denied.code, 1); assert.match(denied.stderr, /需要授权飞书/); assert.match(denied.stderr, /https:\/\/partner.example.test/);
  assert.equal((await f.run("lark-cli", ["calendar", "--help"])).code, 0);
});

test("缺 CLI 给固定版本安装方法；飞书项目未登录不执行操作", async (t) => {
  const f = await cliFixture(t); const r = await f.run("meegle", ["workitem", "list"]); assert.equal(r.code, 1); assert.match(r.stderr, /需要授权飞书项目/); assert.match(r.stderr, /auth login --device-code/); assert.equal(f.requests(), 0);
  fs.rmSync(path.join(f.realBin, "lark-cli")); const missing = await f.run("lark-cli", ["auth", "status"]); assert.match(missing.stderr, /npm install -g @larksuite\/cli@1.0.99/);
});

test("项目状态只公开连接和 CLI 剩余有效期，不创建授权时间", async () => {
  let result = { authenticated: true, expires_in_minutes: 4350, token: 'never-expose' };
  const project = createProject({ run: async () => result });
  assert.deepEqual(await project.status('me'), { connected: true, expiresInMinutes: 4350 });
  for (const minutes of [1439, 1440, 0]) {
    result = { authenticated: true, expires_in_minutes: minutes };
    assert.deepEqual(await project.status('me'), { connected: true, expiresInMinutes: minutes });
  }
  for (const minutes of [null, undefined, '1440', -1]) {
    result = { authenticated: true, expires_in_minutes: minutes };
    assert.deepEqual(await project.status('me'), { connected: true });
  }
  result = { authenticated: false, reason: 'no local token', expires_in_minutes: 1440 };
  assert.deepEqual(await project.status('me'), { connected: false });
});

test("本机设置拒绝跨站 POST、未知身份和其他路径，页面不含本人凭据", async (t) => {
  const calls = [], project = createProject({ run: async () => ({ authenticated: false, reason: "no local token" }) });
  let handler;
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createSettingsHandler({ basePath: "/random-capability/", origin, identify: (req) => req.headers.host === new URL(origin).host ? "me" : null, status: () => ({ connected: true, enabled: true }), disconnect: () => { calls.push("disconnect"); return { connected: false }; }, project, connectUrl: "https://partner.example.test/_zp/feishu/connect", local: true });
  const page = await fetch(`${origin}/random-capability/`); assert.equal(page.status, 200); assert.match(await page.text(), /本机/); assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${origin}/random-capability/disconnect`, { method: "POST", headers: { origin: "https://evil.test" } })).status, 403); assert.equal(calls.length, 0);
  assert.equal((await fetch(`${origin}/random-capability/disconnect`, { method: "POST", headers: { origin } })).status, 200); assert.equal(calls.length, 1);
  assert.equal((await fetch(`${origin}/wrong/`)).status, 404);
});

test("桌面公司导航实际打开独立本机页，服务器使用已有登录且窗口关闭后停止监听", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { installDesktopSettings } = await import("./desktop.mjs");
  const root = temp(t), identityFile = path.join(root, "session.json");
  fs.writeFileSync(identityFile, JSON.stringify({ token: "fake-desktop-session" }));
  const remote = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fake-desktop-session");
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ enabled: true, connected: true }));
  });
  remote.listen(0, "127.0.0.1"); await once(remote, "listening");
  t.after(async () => { remote.closeAllConnections(); await new Promise((r) => remote.close(r)); });
  const created = new EventEmitter();
  class FakeWindow extends EventEmitter {
    webContents = new EventEmitter();
    constructor(options) { super(); this.options = options; this.webContents.setWindowOpenHandler = () => {}; }
    async loadURL(url) { this.url = url; created.emit("loaded", this); }
    destroy() { this.emit("closed"); }
  }
  const app = new EventEmitter();
  installDesktopSettings({ app, BrowserWindow: FakeWindow, publicOrigin: `http://127.0.0.1:${remote.address().port}`, configFile: path.join(root, "unused-config"), identityFile, execPath: process.execPath });
  const contents = new EventEmitter(); app.emit("web-contents-created", {}, contents);
  const loaded = once(created, "loaded"); let prevented = false;
  contents.emit("will-navigate", { url: "dsh-app://app/_zp/feishu/", preventDefault: () => { prevented = true; } });
  const [window] = await loaded;
  t.after(() => window.destroy());
  assert.ok(prevented); assert.equal(window.options.webPreferences.nodeIntegration, false); assert.equal(window.options.webPreferences.sandbox, true);
  const r = await fetch(window.url + "status"); assert.equal(r.status, 200); assert.equal((await r.json()).connected, true);
  window.destroy(); await assert.rejects(fetch(window.url));
});
