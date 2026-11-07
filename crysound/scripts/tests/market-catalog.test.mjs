// Run against the actual published 0.2.2-rc.1 client files, without building or installing packages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { patchCompanyMarketRuntime } from "../patch-market-ui.mjs";

const source = process.env.MARKET_RUNTIME_MODULES;
if (!source) throw new Error("MARKET_RUNTIME_MODULES must contain the five published @deepseek-ai browser modules");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-market-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(source, root, { recursive: true });
  const clients = ["ui-plugin-manager", "ui-plugin-market", "ui-entry-customization", "ui-sidebar", "ui-conversation"].map((name) => path.join(root, `@deepseek-ai/dsh-client-${name}/lib/client.js`));
  return { root, clients };
}

test("网页与桌面五模块修补可解析、重复执行字节不变且保留文件权限与独立副本", (t) => {
  const { root, clients } = fixture(t);
  const linked = path.join(root, "unmodified-client.js");
  const original = fs.readFileSync(clients[0], "utf8");
  fs.chmodSync(clients[0], 0o640);
  fs.linkSync(clients[0], linked);
  patchCompanyMarketRuntime(root);
  const first = clients.map((file) => fs.readFileSync(file, "utf8"));
  first.forEach((text) => assert.doesNotThrow(() => new vm.Script(text)));
  patchCompanyMarketRuntime(root);
  assert.deepEqual(clients.map((file) => fs.readFileSync(file, "utf8")), first);
  assert.equal(fs.readFileSync(linked, "utf8"), original);
  assert.equal(fs.statSync(clients[0]).mode & 0o777, 0o640);
});

test("任何模块版本变动导致修补拒绝时，不留下部分修补的运行时", (t) => {
  const { root, clients } = fixture(t);
  fs.writeFileSync(clients[3], fs.readFileSync(clients[3], "utf8").replace("const panels =", "const changedPanels ="));
  const first = clients.map((file) => fs.readFileSync(file, "utf8"));
  assert.throws(() => patchCompanyMarketRuntime(root), /未唯一命中/);
  assert.deepEqual(clients.map((file) => fs.readFileSync(file, "utf8")), first);
});
