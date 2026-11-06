// 飞书网络与配置均注入假值，不读取部署密钥或发送真实消息。
import test from "node:test";
import assert from "node:assert/strict";
import { notifyMarketAdmins } from "../onboard.mjs";

const payload = { name: "@crysound/demo", version: "1.0.0", publisher: "alice", admins: ["admin"] };
const settings = { appId: "fake-app", appSecret: () => "fake-secret", publicHost: "partner.example.test",
  loadUsers: () => [{ slug: "admin", unionId: "fake-admin" }, { slug: "backup", unionId: "fake-backup" }],
};

test("给配置管理员发交互卡片，按钮只打开需登录的审批页", async () => {
  const calls = [];
  await notifyMarketAdmins(payload, { ...settings, request: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return calls.length === 1 ? { tenant_access_token: "fake-tenant" } : { code: 0 };
  } });
  assert.equal(calls[1].path, "/im/v1/messages?receive_id_type=union_id");
  assert.equal(calls[1].body.receive_id, "fake-admin");
  assert.equal(calls[1].body.msg_type, "interactive");
  const card = JSON.parse(calls[1].body.content);
  assert.equal(card.elements[1].actions[0].url, "https://partner.example.test/_zp/market/admin");
  assert.match(card.elements[0].text.content, /@crysound\/demo@1.0.0/);
  assert.doesNotMatch(calls[1].body.content, /fake-tenant|fake-secret/);
});

test("某位管理员不可达仍通知其他人，汇总失败供审批页重发", async () => {
  const recipients = [];
  await assert.rejects(notifyMarketAdmins({ ...payload, admins: ["missing", "admin", "backup"] }, { ...settings, request: async (path, init) => {
    if (path.startsWith("/auth/")) return { tenant_access_token: "fake-tenant" };
    const recipient = JSON.parse(init.body).receive_id;
    recipients.push(recipient);
    return { code: recipient === "fake-admin" ? 999 : 0 };
  } }), /missing, admin/);
  assert.deepEqual(recipients, ["fake-admin", "fake-backup"]);
});


test("数据额度提醒复用管理员渠道，只包含中文处置说明和官方后台链接", async () => {
  const messages = [];
  await notifyMarketAdmins({ quota: true, admins: ["admin"] }, { ...settings, request: async (path, init) => {
    if (path.startsWith("/auth/")) return { tenant_access_token: "fake-tenant" };
    messages.push(JSON.parse(init.body)); return { code: 0 };
  } });
  const card = JSON.parse(messages[0].content);
  assert.equal(card.header.title.content, "兆华数据 · 公司额度提醒");
  assert.match(card.elements[0].text.content, /公司数据额度暂时用完/);
  assert.equal(card.elements[1].actions[0].url, "https://treg.to/app");
  assert.doesNotMatch(messages[0].content, /undefined|fake-tenant|fake-secret/);
});
