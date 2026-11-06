// 兆华工作伙伴网关：网关自己对接飞书登录（飞书内免确认），按飞书 union_id 把每个人带到自己的 dsh 容器。
// 容器停了就启动；dsh 的一次性口令在这里换成登录 cookie，浏览器只和网关打交道。
import { serveCompanyConfig } from "./company-config.mjs";
import { serveMacUpdate } from "./updates.mjs";
import { createPreview, writeRelayKey } from "../preview/gateway.mjs";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { authorizeUrl, identify, provision, readUsers, slugFor, notifyMarketAdmins } from "./onboard.mjs";

import { issueToken, tokenUser, writeContainerToken } from "./market-auth.mjs";
import { createMarket } from "./market.mjs";
import { createFeishu } from "./feishu.mjs";
import { createSettingsHandler } from "../../feishu/settings.mjs";
import { createContainerProject } from "../../feishu/container-project.mjs";

const PORT = 3090;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
// 模型网关地址与钥匙文件前缀（换一套 magpie 时改 .env，容器空闲重建后逐个切过去）。
const MAGPIE = new URL(process.env.MAGPIE_BASE_URL || "http://magpie:3425/v1");
const MAGPIE_KEY_PREFIX = process.env.MAGPIE_KEY_PREFIX || "magpie-";
if (!PUBLIC_HOST || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(PUBLIC_HOST) || new URL(`https://${PUBLIC_HOST}`).host !== PUBLIC_HOST.toLowerCase()) {
  throw new Error("在 .env 配置有效的 PUBLIC_HOST，然后重建网关");
}
// 旧网址：已装的桌面版按旧网址登录和调模型，这几处照常服务；其余访问跳到正式网址。
const OLD_HOSTS = String(process.env.OLD_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
const servedOnOldHost = (url) => url.pathname.startsWith("/_zp/config/") || url.pathname.startsWith("/_zp/llm/v1/")
  || url.pathname.startsWith("/_zp/updates/mac/")
  || ["/_zp/callback", "/_zp/desktop-login", "/_zp/desktop-done"].includes(url.pathname)
  || (url.pathname === "/_zp/login" && String(url.searchParams.get("next") || "").startsWith("/_zp/desktop-login"));
const USERS_FILE = "/etc/partner/users.json";
const COOKIE_FILE = "/state/cookies.json";
const NETWORK = "partner-net";
const PREFIX = "zhaohua-partner-";

const cookies = (() => { try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")); } catch { return {}; } })();
const saveCookies = () => fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies), { mode: 0o600 });
const users = readUsers;

function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path,
      headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 登录凭证：{u: union_id, n: 姓名, e: 到期秒} 的 base64url 加 HMAC 签名，30 天有效。
const SESSION_KEY = (() => {
  const f = "/secure/gateway-session.key";
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
})();
const SESSION_DAYS = 30;
const LOCAL = "127.0.0.1:3080";
const sign = (data) => crypto.createHmac("sha256", SESSION_KEY).update(data).digest("base64url");

function issueSession(who) {
  const data = Buffer.from(JSON.stringify({ u: who.unionId, n: who.name, a: who.avatar || "", e: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 })).toString("base64url");
  return `zp_sid=${data}.${sign(data)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

// 桌面版通行证：同样签名，前缀 zpd.，180 天有效。桌面版用它调模型，网关换成本人的 magpie 钥匙再转发，钥匙不出服务器。
function issueDesktopToken(who) {
  return issueToken(SESSION_KEY, who);
}
function desktopUser(req) {
  return tokenUser(req, SESSION_KEY, users());
}

const marketAdmins = [...new Set((process.env.MARKET_ADMINS || "").split(",").map((s) => s.trim()).filter(Boolean))];
if (!marketAdmins.length || marketAdmins.some((slug) => !users().some((user) => user.slug === slug))) {
  throw new Error("在 .env 配置已开通的市场管理员 slug（首期 Jason），然后重建网关");
}

const preview = createPreview({
  publicHost: PUBLIC_HOST, previewHost: process.env.PREVIEW_HOST || "", key: SESSION_KEY,
  users, upstream,
  sessionUser: (req) => {
    const { user } = userFor(req);
    if (!user) return null;
    const [data] = cookieOf(req, "zp_sid").split(".");
    return { user, expires: JSON.parse(Buffer.from(data, "base64url").toString()).e };
  },
});

// 令牌随数据卷进入容器；旧容器在重建后由入口脚本写入 .npmrc。
for (const user of users()) {
  writeContainerToken(SESSION_KEY, user);
  if (process.env.PREVIEW_HOST) writeRelayKey(SESSION_KEY, user);
}
const market = createMarket({
  stateFile: "/state/market.json", registry: "http://verdaccio:4873",
  authorization: `Basic ${Buffer.from(fs.readFileSync("/secure/market-npm-auth", "utf8").trim()).toString("base64")}`,
  publicOrigin: `https://${PUBLIC_HOST}`,
  authenticate: desktopUser,
  readUsers: users,
  sessionUser: (req) => userFor(req).user,
  admins: marketAdmins,
  officialPublishers: (process.env.MARKET_OFFICIAL_PUBLISHERS || "").split(",").map((s) => s.trim()).filter(Boolean),
  officialMaintainers: JSON.parse(process.env.MARKET_OFFICIAL_MAINTAINERS || "{}"),
  officialPackages: (process.env.MARKET_OFFICIAL_PACKAGES || "").split(",").map((s) => s.trim()).filter(Boolean),
  notify: notifyMarketAdmins,
  internalOrigin: "http://zhaohua-partner-gateway:3090",
});

const feishu = createFeishu({
  stateDir: "/state/feishu", appId: process.env.FEISHU_APP_ID,
  secret: () => fs.readFileSync("/secure/feishu-app.secret", "utf8").trim(),
  publicOrigin: `https://${PUBLIC_HOST}`, enabled: () => process.env.FEISHU_USER_AUTH_ENABLED === "1",
  authenticate: desktopUser, sessionUser: (req) => userFor(req).user, readUsers: users, projectHost: process.env.MEEGLE_HOST || "",
});
const feishuSettings = createSettingsHandler({
  basePath: "/_zp/feishu/", origin: `https://${PUBLIC_HOST}`, identify: (req) => userFor(req).user,
  status: (user) => feishu.status(user.unionId), disconnect: (user) => feishu.disconnect(user.unionId),
  project: createContainerProject(), connectUrl: `https://${PUBLIC_HOST}/_zp/feishu/connect`,
});
// 此端口不映射到宿主机，也不经公网网关路由，容器仍须通过 tokenUser 鉴权。
const feishuInternal = http.createServer(async (req, res) => {
  if (req.url === "/token") return feishu.token(req, res);
  res.writeHead(404); res.end();
});
feishuInternal.listen(3091, "0.0.0.0");
let maintaining = false;
const maintainFeishu = async () => {
  if (maintaining) return;
  maintaining = true;
  try { await feishu.maintain(); } catch (error) { console.warn("飞书授权维护未完成，将在下次重试"); }
  finally { maintaining = false; }
};
const feishuTimer = setInterval(maintainFeishu, 60000);
feishuTimer.unref();
void maintainFeishu();

// 桌面版的模型请求：核对通行证，换成本人的 magpie 钥匙，原样流式转给 magpie。
function proxyModel(req, res, user, path) {
  let key;
  try { key = fs.readFileSync(`/secure/${MAGPIE_KEY_PREFIX}${user.slug}.key`, "utf8").trim(); } catch { res.writeHead(403); return res.end(); }
  const headers = { ...req.headers, host: MAGPIE.host, authorization: `Bearer ${key}` };
  delete headers.cookie;
  delete headers["x-api-key"]; // Anthropic 格式的请求（网页搜索）同时带这一项，留着会让 magpie 拿通行证当钥匙。
  const up = http.request({ host: MAGPIE.hostname, port: MAGPIE.port || 80, path, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { console.log("模型转发出错", user.slug, e.message); if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}

function sessionOf(req) {
  const [data, mac] = String(cookieOf(req, "zp_sid") || "").split(".");
  if (!data || !mac || mac.length !== 43 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(data)))) return null;
  const s = JSON.parse(Buffer.from(data, "base64url").toString());
  return s.e > Date.now() / 1000 ? { unionId: s.u, name: s.n, avatar: s.a || "" } : null;
}

function userFor(req) {
  const who = sessionOf(req);
  return { who, user: who && users().find((x) => x.unionId === who.unionId) };
}

// 返回容器在 partner-net 上的地址；没在运行就启动并等 dsh 起来。
async function upstream(slug) {
  const name = PREFIX + slug;
  let r = await docker("GET", `/containers/${name}/json`);
  if (r.status === 404) return { missing: true };
  let info = JSON.parse(r.body);
  if (!info.State.Running) {
    await docker("POST", `/containers/${name}/start`);
    delete cookies[slug];
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await tokenFromLogs(name)) break;
    }
    info = JSON.parse((await docker("GET", `/containers/${name}/json`)).body);
  }
  const ip = info.NetworkSettings.Networks[NETWORK]?.IPAddress;
  return { name, ip };
}

async function tokenFromLogs(name) {
  const r = await docker("GET", `/containers/${name}/logs?stdout=1&stderr=1&tail=200`);
  const m = r.body.toString("latin1").match(/token=([A-Za-z0-9_-]+)/g);
  return m ? m[m.length - 1].slice(6) : null;
}

// 用容器日志里的一次性口令向 dsh 换登录 cookie，按人缓存（cookie 30 天有效，容器重启后仍有效）。
async function sessionCookie(slug, up, force = false) {
  if (cookies[slug] && !force) return cookies[slug];
  const token = await tokenFromLogs(up.name);
  if (!token) return null;
  // dsh 按访问地址各发一份凭证：公司网址用于网页，本机地址用于 SlideStudio 的 /slides 接口。
  const exchange = (host) => new Promise((resolve, reject) => {
    const req = http.request({ host: up.ip, port: 3080, path: `/?token=${token}`, method: "GET",
      headers: { host } }, (res) => { res.resume(); resolve(res.headers["set-cookie"] || []); });
    req.on("error", reject);
    req.end();
  });
  const setCookie = [...await exchange(PUBLIC_HOST), ...await exchange(LOCAL)];
  const value = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!value) return null;
  cookies[slug] = value;
  saveCookies();
  return value;
}

function page(res, status, title, text, refresh) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>兆华工作伙伴</title><body style="font-family:-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif;display:grid;place-items:center;height:90vh;color:#170057"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#555">${text}</p></div></body>`);
}

// SlideStudio 的 /slides 接口只认本机来源（为桌面单机设计）；网关已确认身份，这组请求按本机地址转发。
const forwardHeaders = (req, cookie) => req.url.startsWith("/slides")
  ? { ...req.headers, host: LOCAL, ...(req.headers.origin ? { origin: `http://${LOCAL}` } : {}), cookie }
  : { ...req.headers, host: PUBLIC_HOST, cookie };

async function resolve(req) {
  const { who, user } = userFor(req);
  if (!user) return { deny: who };
  const up = await upstream(user.slug);
  if (up.missing) return { missing: user };
  const cookie = await sessionCookie(user.slug, up);
  return { user, up, cookie };
}

function proxy(req, res, r, body, retried) {
  const up = http.request({ host: r.up.ip, port: 3080, path: req.url, method: req.method,
    headers: forwardHeaders(req, r.cookie) }, async (ur) => {
    if (ur.statusCode === 401 && !retried) {
      ur.resume();
      r.cookie = await sessionCookie(r.user.slug, r.up, true);
      return proxy(req, res, r, body, true);
    }
    const headers = { ...ur.headers };
    delete headers["set-cookie"];
    res.writeHead(ur.statusCode, headers);
    ur.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) page(res, 200, "正在准备你的工作伙伴", "马上就好，页面会自动刷新。", true); });
  up.end(body);
}

// 网关以本人身份直接调 dsh 接口（新人第一次进来前，先建好默认工作区，否则输入框不可用）。
function rpc(r, method, args, retried) {
  const body = JSON.stringify({ type: "client-request", rpcId: `zp-${Date.now()}`, method, payload: { args } });
  return new Promise((resolve, reject) => {
    const q = http.request({ host: r.up.ip, port: 3080, path: `/api/${method}`, method: "POST",
      headers: { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}`, cookie: r.cookie, "content-type": "application/json" } }, async (res) => {
      if (res.statusCode === 401 && !retried) {
        res.resume();
        r.cookie = await sessionCookie(r.user.slug, r.up, true);
        return resolve(rpc(r, method, args, true));
      }
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString(); if (!/"ok":true/.test(t)) console.log(`调用 ${method} 失败：${t.slice(0, 200)}`); resolve(t); });
    });
    q.on("error", reject); q.end(body);
  });
}

const MARK = '<svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true"><defs><clipPath id="l"><circle cx="24" cy="32" r="13.6"/></clipPath></defs><rect width="64" height="64" rx="15" fill="#170057"/><circle cx="40" cy="32" r="13.6" fill="#2fb4c4" clip-path="url(#l)"/><circle cx="24" cy="32" r="13.6" fill="none" stroke="#fff" stroke-width="4"/><circle cx="40" cy="32" r="13.6" fill="none" stroke="#fff" stroke-width="4"/></svg>';

function welcome(res, { title, lines, action, note }) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>兆华工作伙伴</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5fb;color:#1d1a2e;font:16px/1.7 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{width:min(440px,calc(100vw - 48px));padding:40px 32px 32px;background:#fff;border-radius:20px;box-shadow:0 1px 0 #e7e4f2,0 18px 48px -24px rgba(23,0,87,.28)}
h1{margin:20px 0 6px;font-size:24px;font-weight:650;color:#170057}
ul{margin:16px 0 0;padding:0;list-style:none}
li{padding:10px 0;border-top:1px solid #efedf6}
li:first-child{border-top:0}
a.go{display:block;margin-top:28px;padding:13px 0;border-radius:12px;background:#170057;color:#fff;text-align:center;text-decoration:none;font-weight:600}
a.go:focus-visible{outline:3px solid #2fb4c4;outline-offset:2px}
p.note{margin:14px 0 0;color:#6b6684;font-size:14px;text-align:center}
</style><main>${MARK}<h1>${title}</h1><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>${action ? `<a class="go" href="${action.href}">${action.text}</a>` : ""}${note ? `<p class="note">${note}</p>` : ""}</main></html>`);
}

function cookieOf(req, name) {
  return String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
}

const redirect = (res, location, cookie) => { res.writeHead(302, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
const PREPARING = ["正在准备你的工作伙伴", "第一次开通大约需要半分钟，页面会自动进入。"];

// 登录与开通：/_zp/login 去飞书授权（?onboard=1 时多要查群权限）→ /_zp/callback 发登录凭证，开通时检查试用群并建空间。
async function login(req, res, url, host) {
  if (url.pathname === "/_zp/login") {
    const state = crypto.randomBytes(16).toString("hex");
    const onboard = url.searchParams.get("onboard") === "1";
    const next = onboard ? "/_zp/preparing" : (url.searchParams.get("next") || "/").replace(/^(?!\/(?!\/)).*/, "/");
    return redirect(res, authorizeUrl(state, onboard, host), `zp_state=${state}|${onboard ? 1 : 0}|${encodeURIComponent(next)}; Path=/_zp; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  }
  // /_zp/callback
  const [state, onboard, next] = String(cookieOf(req, "zp_state") || "").split("|");
  if (!url.searchParams.get("code") || url.searchParams.get("state") !== state) {
    return welcome(res, { title: "飞书登录没有完成", lines: ["授权已过期或被取消。"], action: { href: "/_zp/login", text: "重新登录" } });
  }
  let who;
  try {
    who = await identify(url.searchParams.get("code"), onboard === "1", host);
  } catch (e) {
    console.log("登录回调出错", e.message);
    // 已登录的人（多半是刷新了回调页）直接进去；其他人重新走一遍飞书登录，授权码只能用一次。
    if (userFor(req).who) return redirect(res, decodeURIComponent(next || "/"));
    return welcome(res, { title: "飞书登录没有完成", lines: ["请再登录一次。"], action: { href: onboard === "1" ? "/_zp/login?onboard=1" : "/_zp/login", text: "重新登录" } });
  }
  const session = issueSession(who);
  if (onboard === "1" && !users().some((x) => x.unionId === who.unionId)) {
    if (!who.inPilot) {
      console.log(`不在试用群 ${who.name}`);
      return redirect(res, "/_zp/pilot", session);
    }
    delete cookies[slugFor(who.unionId)]; // 同一人删掉重开时，旧空间的登录凭证不能沿用
    provision(docker, who).catch((e) => console.log("开通失败", who.name, e.message));
  }
  return redirect(res, decodeURIComponent(next || "/"), session);
}

// 客户端下载：/downloads 里的安装包（由发布流程放入），文件名带平台，如 兆华工作伙伴-1.0.0-mac-arm64.dmg。
const DOWNLOADS = "/downloads";
const PLATFORMS = [["mac-arm64", "Mac（Apple 芯片）"], ["win-x64", "Windows"]];
function download(res, file) {
  // 安装包可以放在 R2：下载目录里放“<文件名>.url”，内容是 R2 公开地址，下载时跳过去；没有就从本机目录发。
  const entries = (() => { try { return fs.readdirSync(DOWNLOADS).filter((f) => !f.startsWith(".")); } catch { return []; } })();
  const files = [...new Set(entries.map((f) => f.replace(/\.url$/, "")))];
  if (file) {
    if (!files.includes(file)) { res.writeHead(404); return res.end(); }
    if (entries.includes(`${file}.url`)) return redirect(res, fs.readFileSync(`${DOWNLOADS}/${file}.url`, "utf8").trim());
    const st = fs.statSync(`${DOWNLOADS}/${file}`);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
    return fs.createReadStream(`${DOWNLOADS}/${file}`).pipe(res);
  }
  const rows = PLATFORMS.map(([key, label]) => {
    const f = files.filter((x) => x.includes(key)).sort().pop();
    return f ? `<a class="dl" href="/_zp/download/${encodeURIComponent(f)}">下载 ${label} 版</a>` : `<span class="dl off">${label} 版即将推出</span>`;
  }).join("");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>下载客户端 · 兆华工作伙伴</title><style>body{font-family:-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;display:grid;place-items:center;min-height:90vh;color:#170057;margin:0}main{max-width:420px;padding:24px}h2{font-weight:600}p{color:#555;line-height:1.6}.dl{display:block;margin:10px 0;padding:12px 16px;border-radius:10px;background:#170057;color:#fff;text-decoration:none;text-align:center}.dl.off{background:#eee;color:#888}</style><main><h2>下载兆华工作伙伴客户端</h2><p>客户端直接处理电脑上的文件。第一次打开时用飞书登录，用的是同一个账号。Mac 版只支持 Apple 芯片（M 系列），不支持 Intel 芯片的 Mac。</p>${rows}</main>`);
}

function welcomeNew(res, who) {
  return welcome(res, {
    title: "兆华工作伙伴",
    lines: [
      `${who.name}，这是你的专属 AI 工作伙伴：写文档、做表格、查资料、分析文件，都可以交给它。`,
      "每人一个独立空间，同事之间看不到彼此的对话和文件。",
      "开通后第一步，把它连到你的飞书，以后在飞书里直接找它。",
    ],
    action: { href: "/_zp/login?onboard=1", text: "开通我的工作伙伴" },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${PUBLIC_HOST}`);
    const host = String(req.headers.host || "").toLowerCase();
    if (await preview.handle(req, res, url)) return;
    // A preview is untrusted code, even when it is a sibling on the same registrable domain.
    if (req.headers.origin && preview.isPreviewHost(new URL(req.headers.origin).host)) {
      res.writeHead(403); return res.end();
    }
    const oldHost = OLD_HOSTS.includes(host);
    if (host !== PUBLIC_HOST && host !== `${PUBLIC_HOST}:443` && !oldHost && host !== "zhaohua-partner-gateway:3090") {
      res.writeHead(403); return res.end();
    }
    if (oldHost && !servedOnOldHost(url)) return redirect(res, `https://${PUBLIC_HOST}${req.url}`);
    if (url.pathname === "/_zp/feishu") return redirect(res, "/_zp/feishu/");
    if (await feishu.handle(req, res, url)) return;
    if (url.pathname.startsWith("/_zp/feishu/") && !userFor(req).user) return redirect(res, "/_zp/login?next=%2F_zp%2Ffeishu%2F");
    if (await feishuSettings(req, res, url)) return;
    if (await market(req, res, url)) return;
    if (url.pathname === "/_zp/login" || url.pathname === "/_zp/callback") return await login(req, res, url, oldHost ? host : PUBLIC_HOST);
    if (url.pathname.startsWith("/_zp/config/")) return await serveCompanyConfig(req, res, url.pathname, desktopUser);
    if (url.pathname.startsWith("/_zp/updates/mac/")) return await serveMacUpdate(req, res, url.pathname, desktopUser);
    if (url.pathname.startsWith("/_zp/llm/v1/")) {
      const user = desktopUser(req);
      if (!user) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":{"message":"桌面版登录已失效，请重新登录"}}'); }
      return proxyModel(req, res, user, url.pathname.slice("/_zp/llm".length) + url.search);
    }
    // 网页左下角用：本人的飞书姓名和头像，以及客户端下载（只给已开通的同事）。
    if (url.pathname === "/_zp/me" || url.pathname.startsWith("/_zp/download")) {
      const { who, user } = userFor(req);
      if (!user) {
        if (url.pathname === "/_zp/me") { res.writeHead(401); return res.end(); }
        // 从聊天里点开的下载链接常在没登录的浏览器里打开：先飞书登录，再回到下载。
        return redirect(res, `/_zp/login?next=${encodeURIComponent(url.pathname)}`);
      }
      if (url.pathname === "/_zp/me") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify({ name: who.name, avatar: who.avatar })); }
      return download(res, decodeURIComponent(url.pathname.slice("/_zp/download".length).replace(/^\//, "")));
    }
    if (url.pathname === "/_zp/desktop-done") return page(res, 200, "已登录", "可以关闭这个窗口。");
    if (url.pathname === "/_zp/desktop-login") {
      const { who, user } = userFor(req);
      if (!who) return redirect(res, "/_zp/login?next=%2F_zp%2Fdesktop-login");
      if (!user) return redirect(res, "/_zp/login?onboard=1", "zp_desktop=1; Path=/_zp; HttpOnly; Secure; SameSite=Lax; Max-Age=3600");
      return redirect(res, `/_zp/desktop-done#token=${issueDesktopToken(who)}&name=${encodeURIComponent(who.name)}&avatar=${encodeURIComponent(who.avatar || "")}`, "zp_desktop=; Path=/_zp; Max-Age=0");
    }
    const r = await resolve(req);
    if (r.deny !== undefined) {
      if (!r.deny) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/")) return redirect(res, `/_zp/login?next=${encodeURIComponent(req.url)}`);
        res.writeHead(401); return res.end();
      }
      if (url.pathname === "/_zp/preparing") return page(res, 200, ...PREPARING, true);
      if (url.pathname === "/_zp/pilot") return welcome(res, { title: "目前在小范围试用", lines: [`${r.deny.name}，兆华工作伙伴现在只对飞书群“AI工作台”的同事开放。`, "加入这个群以后，重新打开就能开通。"], action: { href: "/_zp/login?onboard=1", text: "我已入群，重新开通" } });
      return welcomeNew(res, r.deny);
    }
    if (url.pathname === "/_zp/preparing") {
      if (!r.cookie) return page(res, 200, ...PREPARING, true);
      await rpc(r, "workspace/create", { request: { path: "/data/work" } });
      return redirect(res, cookieOf(req, "zp_desktop") === "1" ? "/_zp/desktop-login" : "/?zp-welcome=1");
    }
    if (url.pathname.startsWith("/_zp/")) return redirect(res, "/");
    if (r.missing) return page(res, 503, "工作空间还没建好", "请联系管理员。");
    if (!r.cookie) return page(res, 200, "正在准备你的工作空间", "通常不超过半分钟，页面会自动刷新。", true);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => proxy(req, res, r, Buffer.concat(chunks)));
  } catch (e) {
    console.log("出错", e.message);
    if (!res.headersSent) page(res, 200, "正在准备你的工作伙伴", "马上就好，页面会自动刷新。", true);
  }
});

server.on("upgrade", async (req, socket, head) => {
  try {
    if (preview.isPreviewHost(String(req.headers.host || "").toLowerCase())) return await preview.upgrade(req, socket, head);
    if (req.headers.origin && preview.isPreviewHost(new URL(req.headers.origin).host)) return socket.destroy();
    const r = await resolve(req);
    if (!r.cookie) return socket.destroy();
    const up = net.connect(3080, r.up.ip, () => {
      const h = forwardHeaders(req, r.cookie);
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`兆华工作伙伴网关 :${PORT}`));
