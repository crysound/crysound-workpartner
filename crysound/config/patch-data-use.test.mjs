import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchDataUse, patchDataUseFile, useData } from "./patch-data-use.mjs";

function fixture({ enabled = true, rowEnabled = true, error } = {}) {
  const calls = [];
  const ctx = { remote: { pluginManager: {
    listBundles: async () => [{ name: "@crysound/data", enabled, error, rows: [{ entryId: "skill" }] }],
    listPlugins: async () => [{ entryId: "skill", enabled: rowEnabled }],
  } }, uiWorkspace: { startSession: (...args) => calls.push(args) } };
  return { ctx, calls };
}

test("启用的数据插件只打开分类引导草稿、保留旧草稿，不发送消息", async () => {
  const { ctx, calls } = fixture();
  await useData(ctx, () => assert.fail("settings must not open"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], undefined);
  assert.equal(calls[0][1].whenDraftExists, "append");
  assert.match(calls[0][1].prompt, /七类.*示例提问/);
  assert.match(calls[0][1].prompt, /不要发起付费/);
});

test("未启用、行停用、加载失败或断线时只进入设置", async () => {
  for (const options of [{ enabled: false }, { rowEnabled: false }, { error: "load failed" }, { offline: true }]) {
    const { ctx, calls } = fixture(options);
    if (options.offline) ctx.remote.pluginManager.listBundles = async () => { throw new Error("offline"); };
    let opened = 0;
    await useData(ctx, () => { opened++; });
    assert.equal(opened, 1);
    assert.equal(calls.length, 0);
  }
});

test("真实发布的卡片补丁幂等，入口变化拒绝，副本不修改硬链接来源", { skip: !process.env.DATA_MARKET_CLIENT }, () => {
  const original = fs.readFileSync(process.env.DATA_MARKET_CLIENT, "utf8");
  const next = patchDataUse(original);
  assert.equal(patchDataUse(next), next);
  assert.throws(() => patchDataUse(original.replace('const { t, install, openPackage } = props;', 'changed')));
  assert.doesNotMatch(next, /zp-data|data\.json/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-use-"));
  try {
    const source = path.join(dir, "source.js"), target = path.join(dir, "client.js");
    fs.writeFileSync(source, original, { mode: 0o640 }); fs.chmodSync(source, 0o640); fs.linkSync(source, target);
    patchDataUseFile(target); patchDataUseFile(target);
    assert.equal(fs.readFileSync(source, "utf8"), original);
    assert.equal(fs.readFileSync(target, "utf8"), next);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
