// 用公开构建产物验证公司补丁与桌面完整性记录的先后顺序，不构建或安装任何包。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { patchMarketUi, patchMarketUiFile } from "../patch-market-ui.mjs";

const { runtimeFixture } = await tsImport("../../../apps/desktop/tests/runtime-fixture.ts", import.meta.url);
const { verifyDesktopRuntime } = await tsImport("../../../apps/desktop/src/runtime-tree.ts", import.meta.url);
const clientFile = process.env.MARKET_UI_CLIENT || fileURLToPath(new URL("../../../packages/client/ui-plugin-manager/lib/client.js", import.meta.url));

function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-market-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, "node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js");
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.copyFileSync(clientFile, client);
  return { root, client };
}

test("公司市场修补后再记录桌面文件校验，验证与重复执行均通过", async (t) => {
  const { root, client } = runtime(t);
  patchMarketUiFile(client);
  const patched = fs.readFileSync(client, "utf8");
  runtimeFixture(root);
  await assert.doesNotReject(() => verifyDesktopRuntime(root, "1.0.0"));
  patchMarketUiFile(client);
  assert.equal(fs.readFileSync(client, "utf8"), patched);
  await assert.doesNotReject(() => verifyDesktopRuntime(root, "1.0.0"));
});

test("记录桌面校验后再改客户端会被真实完整性验证拒绝", async (t) => {
  const { root, client } = runtime(t);
  runtimeFixture(root);
  patchMarketUiFile(client);
  await assert.rejects(() => verifyDesktopRuntime(root, "1.0.0"), /integrity verification failed/);
});

test("未知运行时标签结构会明确拒绝修补", () => {
  const text = fs.readFileSync(clientFile, "utf8");
  assert.throws(() => patchMarketUi(text.replace("const tab =", "const unsupportedTab =")));
  assert.throws(() => patchMarketUi(text.replace("label: item.label,", "label: item.newLabel,")));
});
