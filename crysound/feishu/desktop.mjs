// 原生设置通过应用协议调用主进程；旧链接仍使用随机回环地址，网关身份不发给页面。
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProject } from "./project.mjs";
import { createSettingsHandler } from "./settings.mjs";

/** Register the company navigation hook without changing the upstream desktop shell.
 * @param options Electron app/BrowserWindow, public origin and paths to existing session/wrapper configuration.
 * @returns Native protocol request handler; legacy navigation remains supported.
 */
export function installDesktopSettings({ app, BrowserWindow, publicOrigin, configFile, identityFile, execPath }) {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, address) => {
      const url = new URL(address || event.url);
      if (url.protocol !== "dsh-app:" || url.hostname !== "app" || url.pathname !== "/_zp/feishu/") return;
      event.preventDefault();
      void open().catch((error) => { console.warn("无法打开飞书授权设置，请重启工作伙伴后重试"); });
    });
  });
  const call = async (route) => {
    const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")).token;
    const r = await fetch(`${publicOrigin}/_zp/feishu/desktop-${route}`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${identity}` }, signal: AbortSignal.timeout(20000) });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.message || "无法核实飞书授权，请重新登录"), { status: r.status });
    return data;
  };
  const project = createProject({ run: (_user, args) => new Promise((resolve, reject) => {
    const child = spawn(execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "meegle", configFile, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); }, 25000);
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; if (text.length > 1024 * 1024) child.kill(); });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("尚未安装飞书项目命令，请在对话中查看安装方法")); });
    child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(text)); } catch (error) { reject(new Error("无法核实飞书项目授权，请在对话中检查安装与登录")); } });
  }) });
  function authorize(address) {
    const login = new BrowserWindow({ width: 540, height: 780, title: "飞书授权", autoHideMenuBar: true,
      webPreferences: { partition: "persist:crysound-login", nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const completed = (_event, address) => {
      const next = new URL(address);
      if (next.origin === publicOrigin && next.pathname === "/_zp/feishu/done") login.close();
    };
    login.webContents.on("did-navigate", completed);
    login.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void login.loadURL(address).catch(() => login.destroy());
  }
  const native = createSettingsHandler({ basePath: "/_zp/feishu/", origin: "dsh-app://app", identify: () => "local",
    status: () => call("status"), disconnect: () => call("disconnect"), project,
    connectUrl: `${publicOrigin}/_zp/feishu/connect`, local: true });
  async function request(input) {
    const url = new URL(input.url);
    if (url.protocol !== "dsh-app:" || url.hostname !== "app" || !url.pathname.startsWith("/_zp/feishu/")) return null;
    if (["/_zp/feishu/authorize", "/_zp/feishu/project/authorize"].includes(url.pathname)) {
      if (input.method !== "POST" || input.headers.get("origin") !== "dsh-app://app") return Response.json({ message: "请从飞书授权设置操作" }, { status: 403 });
      try {
        const target = url.pathname.includes("project/") ? (await project.connect("local")).authorization_url : `${publicOrigin}/_zp/feishu/connect?return=settings&display=popup`;
        authorize(target);
        return Response.json({ opened: true });
      } catch (error) { return Response.json({ message: error.message }, { status: 503 }); }
    }
    let response;
    await native({ method: input.method, headers: Object.fromEntries(input.headers) }, {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { response = new Response(body, { status: this.status, headers: this.headers }); },
    }, url);
    return response ?? new Response(null, { status: 404 });
  }
  async function open() {
    const basePath = `/${crypto.randomBytes(24).toString("hex")}/`;
    let handler;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (!handler || !await handler(req, res, url)) { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createSettingsHandler({ basePath, origin, identify: (req) => req.headers.host === new URL(origin).host ? "local" : null,
      status: () => call("status"), disconnect: () => call("disconnect"), project,
      connectUrl: `${publicOrigin}/_zp/feishu/connect`, local: true });
    const window = new BrowserWindow({ width: 760, height: 850, title: "飞书授权", autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:crysound-login" } });
    const stop = () => { server.closeAllConnections(); server.close(); };
    window.on("closed", stop);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (new URL(url).protocol !== "https:") return { action: "deny" };
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:crysound-login" } } };
    });
    // 飞书连接在已有登录会话的独立窗口完成，保留本机设置页以便刷新状态。
    const navigate = (event, address) => {
      const next = new URL(address || event.url);
      if (next.origin === publicOrigin) {
        event.preventDefault();
        authorize(address);
      } else if (next.origin !== origin) event.preventDefault();
    };
    window.webContents.on("will-navigate", navigate);
    window.webContents.on("will-redirect", navigate);
    try { await window.loadURL(`${origin}${basePath}`); }
    catch (error) { window.destroy(); throw error; }
  }
  return request;
}
