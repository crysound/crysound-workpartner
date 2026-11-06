// 自助开通：飞书授权确认身份 → 判断是否在试用群 → 建 magpie 钥匙、数据目录和个人容器 → 写进名单。
// 与 bin/partner-user 建出的容器完全一致；名单文件原地改写（它是单文件挂载，不能换 inode）。
import fs from "node:fs";
import crypto from "node:crypto";

import { writeContainerToken } from "./market-auth.mjs";

const APP_ID = process.env.FEISHU_APP_ID;
const CHAT_ID = process.env.PILOT_CHAT_ID;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const IMAGE = process.env.PARTNER_IMAGE;
const USERS_FILE = "/etc/partner/users.json";
const redirectUri = (host) => `https://${host}/_zp/callback`;
// 宿主路径（建容器时 Docker 按宿主路径挂载）与网关内看到的路径
const HOST_USERS = `${process.env.HOST_PARTNER_DATA}/users`;
const HOST_SECURE = process.env.HOST_PARTNER_SECURE;
const HOST_CONFIG = process.env.HOST_PARTNER_CONFIG;
const MAGPIE_BASE_URL = process.env.MAGPIE_BASE_URL;
// MAGPIE_KEYS=pool：magpie 不在本机（经内网连过去）时，新人从 /secure/magpie-pool 领一把预先建好的钥匙，领用记在 assigned.log。
const KEY_POOL = process.env.MAGPIE_KEYS === "pool" ? "/secure/magpie-pool" : null;
const DSH_UID = 1001;

const secret = () => fs.readFileSync("/secure/feishu-app.secret", "utf8").trim();
export const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
const writeUsers = (list) => fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 1));

// 平时登录只要基本身份（飞书内免确认）；开通时多要“查看群成员”，用来确认他在试用群里。
// host 是这次登录所在的网址，飞书回调回到同一个网址（登录状态的 cookie 按网址存）。
export function authorizeUrl(state, onboard, host = PUBLIC_HOST) {
  const q = new URLSearchParams({ client_id: APP_ID, response_type: "code", redirect_uri: redirectUri(host), state, ...(onboard ? { scope: "im:chat.members:read" } : {}) });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${q}`;
}

async function feishu(path, init) {
  const r = await fetch(`https://open.feishu.cn/open-apis${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  return r.json();
}

// 用授权码换这个人的身份；开通时再用他自己的令牌问飞书“他在不在试用群里”。
export async function identify(code, onboard, host = PUBLIC_HOST) {
  const tok = await feishu("/authen/v2/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: APP_ID, client_secret: secret(), code, redirect_uri: redirectUri(host) }),
  });
  if (!tok.access_token) throw new Error(`飞书授权失败：${tok.error_description || tok.msg || tok.code}`);
  const auth = { headers: { authorization: `Bearer ${tok.access_token}` } };
  const info = await feishu("/authen/v1/user_info", auth);
  if (info.code !== 0) throw new Error(`读取飞书身份失败：${info.msg}`);
  const who = { unionId: info.data.union_id, name: info.data.name, avatar: info.data.avatar_middle || info.data.avatar_url || "" };
  if (!onboard) return who;
  const chat = await feishu(`/im/v1/chats/${CHAT_ID}/members/is_in_chat`, auth);
  if (chat.code !== 0) console.log(`查试用群失败 ${who.name}：${chat.code} ${chat.msg}`);
  return { ...who, inPilot: chat.code === 0 && chat.data?.is_in_chat === true };
}

export const slugFor = (unionId) => "u" + crypto.createHash("sha256").update(unionId).digest("hex").slice(0, 8);

async function dockerExec(docker, container, cmd) {
  const created = JSON.parse((await docker("POST", `/containers/${container}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd })).body);
  const out = (await docker("POST", `/exec/${created.Id}/start`, { Detach: false, Tty: false })).body;
  let text = "";
  for (let i = 0; i + 8 <= out.length;) { const n = out.readUInt32BE(i + 4); text += out.subarray(i + 8, i + 8 + n).toString(); i += 8 + n; }
  return text;
}

async function magpieKey(docker, slug) {
  const file = `/secure/magpie-${slug}.key`;
  if (fs.existsSync(file)) return;
  if (KEY_POOL) {
    const spare = fs.readdirSync(KEY_POOL).filter((f) => f.endsWith(".key")).sort()[0];
    if (!spare) throw new Error("预建的 magpie 钥匙用完了");
    fs.renameSync(`${KEY_POOL}/${spare}`, file);
    fs.chownSync(file, DSH_UID, DSH_UID);
    fs.appendFileSync(`${KEY_POOL}/assigned.log`, `${spare} ${slug} ${new Date().toISOString()}\n`);
    return;
  }
  const name = `zhaohua-partner-${slug}`;
  const key = (await dockerExec(docker, "magpie", ["/magpie", "gateway-key", "add", name])).match(/sk-magpie-key-[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error("magpie 没有返回钥匙");
  fs.writeFileSync(file, key, { mode: 0o400 });
  fs.chownSync(file, DSH_UID, DSH_UID);
  const line = (await dockerExec(docker, "magpie", ["/magpie", "gateway-key", "list"])).split("\n").find((l) => l.includes(` ${name} `));
  if (line) await dockerExec(docker, "magpie", ["/magpie", "gateway-key", "models", line.trim().split(/\s+/)[0], "codex/*", "deepseek/*"]);
}

async function container(docker, slug) {
  if (!HOST_CONFIG || !MAGPIE_BASE_URL) throw new Error("请设置 HOST_PARTNER_CONFIG 和 MAGPIE_BASE_URL");
  const name = `zhaohua-partner-${slug}`;
  if ((await docker("GET", `/containers/${name}/json`)).status === 200) return docker("POST", `/containers/${name}/start`);
  fs.mkdirSync(`/users/${slug}`, { recursive: true });
  fs.chownSync(`/users/${slug}`, DSH_UID, DSH_UID);
  const r = await docker("POST", `/containers/create?name=${name}`, {
    Image: IMAGE, User: `${DSH_UID}:${DSH_UID}`, Env: [`PUBLIC_HOST=${PUBLIC_HOST}`, `MAGPIE_BASE_URL=${MAGPIE_BASE_URL}`], Labels: { "zhaohua-partner.user": slug },
    HostConfig: {
      Binds: [`${HOST_USERS}/${slug}:/data`, `${HOST_SECURE}/magpie-${slug}.key:/etc/partner/magpie.key:ro`],
      Mounts: [{ Type: "bind", Source: HOST_CONFIG, Target: "/opt/partner-config", ReadOnly: true }],
      NetworkMode: "partner-net", RestartPolicy: { Name: "unless-stopped" },
      Memory: 2 * 1024 ** 3, NanoCpus: 2e9, PidsLimit: 512,
    },
  });
  if (r.status !== 201) throw new Error(`建容器失败：${r.body}`);
  await docker("POST", `/containers/${name}/start`);
}

const running = new Map();

// 开通一个人；同一人重复触发只跑一次。返回名单里的那一行。
export function provision(docker, { unionId, name }) {
  const slug = slugFor(unionId);
  if (!running.has(slug)) {
    running.set(slug, (async () => {
      await magpieKey(docker, slug);
      writeContainerToken(fs.readFileSync("/secure/gateway-session.key", "utf8").trim(), { slug, unionId });
      await container(docker, slug);
      const list = readUsers().filter((x) => x.slug !== slug);
      const row = { slug, name, unionId, since: new Date().toISOString() };
      list.push(row);
      writeUsers(list);
      console.log(`自助开通 ${name}（${slug}）`);
      return row;
    })().finally(() => running.delete(slug)));
  }
  return running.get(slug);
}

// 卡片只打开网关审批页；审批必须重新验证管理员飞书会话和 POST 来源。
/** 给配置的管理员发送审批卡片；部分投递失败仍尝试其余收件人，最后报告失败。
 * @param notice 包名、版本、发布者和管理员 slug 列表。
 * @param dependencies 飞书请求、配置和用户读取器；测试注入假值。
 * @returns 全部卡片投递成功时完成；拒绝表示可以从审批页重发。
 */
export async function notifyMarketAdmins({ name, version, publisher, admins }, {
  request = feishu, loadUsers = readUsers, appSecret = secret, appId = APP_ID, publicHost = PUBLIC_HOST,
} = {}) {
  if (!admins.length) throw new Error("没有配置市场管理员");
  const tok = await request("/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret() }),
  });
  if (!tok.tenant_access_token) throw new Error("无法取得飞书应用令牌");
  const list = loadUsers();
  const failed = [];
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "兆华市场 · 插件待审批" }, template: "blue" },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: `${name}@${version}\n发布者：${publisher}` } },
      { tag: "action", actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "查看并审批" }, url: `https://${publicHost}/_zp/market/admin` }] },
    ],
  };
  for (const slug of admins) {
    const user = list.find((u) => u.slug === slug);
    if (!user) { failed.push(slug); continue; }
    try {
      const r = await request("/im/v1/messages?receive_id_type=union_id", {
        method: "POST", headers: { authorization: `Bearer ${tok.tenant_access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ receive_id: user.unionId, msg_type: "interactive", content: JSON.stringify(card) }),
      });
      if (r.code !== 0) throw new Error("飞书未接受卡片");
    } catch (error) { failed.push(slug); }
  }
  if (failed.length) throw new Error(`市场审批卡片未送达：${failed.join(", ")}；请从审批页重发`);
}
