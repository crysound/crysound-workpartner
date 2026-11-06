import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHandsCore, sensitivePath } from "../../../apps/desktop/src/crysound/hands/core.mjs";
import { TEXT_LIMIT, FILE_LIMIT, validateCall } from "../wire.mjs";
import tools from "../tools.json" with { type: "json" };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hands-core-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "grant");
  const outside = path.join(root, "outside");
  await fs.mkdir(folder); await fs.mkdir(outside);
  const core = createHandsCore(options);
  return { root, folder, outside, core, file: (name) => path.join(folder, name) };
}
const denied = (code) => (error) => error.code === code;
const write = (filename, text = "新文本") => ({ path: filename, text, summary: "替换文本内容" });

test("授权默认空，读写都不越界，只读授权不能被重叠可写授权扩大", async (t) => {
  const f = await fixture(t, { confirm: async () => "allow" });
  await fs.writeFile(f.file("a.txt"), "hello");
  assert.deepEqual((await f.core.execute("list_folders", {})).value, []);
  await assert.rejects(f.core.execute("read_text", { path: f.file("a.txt") }), denied("DENIED"));
  await f.core.setGrants([{ path: f.folder, readOnly: true }, { path: f.folder, readOnly: false }]);
  assert.equal((await f.core.execute("read_text", { path: f.file("a.txt") })).value, "hello");
  await assert.rejects(f.core.execute("write_text", write(f.file("a.txt"))), denied("READ_ONLY"));
  await assert.rejects(f.core.execute("read_text", { path: path.join(f.outside, "x") }), denied("DENIED"));
  await f.core.setGrants([]);
  await assert.rejects(f.core.execute("read_text", { path: f.file("a.txt") }), denied("DENIED"));
});

test("跳过范围外链接、范围内链接、硬链接及嵌套敏感目录", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, "outside.txt"), "dummy");
  await fs.writeFile(f.file("normal.txt"), "normal");
  await fs.symlink(f.outside, f.file("escape"));
  await fs.symlink(f.file("normal.txt"), f.file("internal.txt"));
  await fs.link(path.join(f.outside, "outside.txt"), f.file("hard.txt"));
  for (const directory of [".ssh", "nested/.gnupg", ".config/google-chrome", "Library/Keychains", "Library/Application Support/Firefox", "AppData/Local/Microsoft/Credentials"]) {
    await fs.mkdir(f.file(directory), { recursive: true });
    await fs.writeFile(f.file(`${directory}/dummy.txt`), "synthetic-fixture");
  }
  await f.core.setGrants([{ path: f.folder, readOnly: false }]);
  for (const filename of ["escape/outside.txt", "internal.txt", "hard.txt", ".ssh/dummy.txt", "Library/Keychains/dummy.txt"]) {
    await assert.rejects(f.core.execute("read_text", { path: f.file(filename) }), denied("DENIED"));
  }
  const result = (await f.core.execute("search", { path: f.folder, query: "synthetic-fixture", mode: "text" })).value;
  assert.deepEqual(result.results, []);
  const listing = (await f.core.execute("list_dir", { path: f.folder })).value.entries.map((e) => e.name);
  assert(!listing.includes(".ssh")); assert(!listing.includes("escape")); assert(!listing.includes("hard.txt"));
  for (const filename of ["C:\\Users\\x\\.ssh\\dummy", "C:\\Users\\x\\AppData\\Roaming\\Mozilla\\Firefox\\x", "/home/x/.codex-test/auth.json", "/home/x/.config/gh/hosts.yml", "/home/x/.aws/config", "/home/x/.env.local"]) assert(sensitivePath(filename));
});

test("确认允许、拒绝、超时及回调异常都保留可解释的结果", async (t) => {
  for (const decision of ["allow", "deny", "timeout", "throw"]) {
    await t.test(decision, async (t) => {
      let request;
      const f = await fixture(t, { confirmTimeoutMs: 15, confirm: async (value) => {
        request = value;
        if (decision === "timeout") return new Promise(() => {});
        if (decision === "throw") throw new Error("dialog unavailable");
        return decision;
      } });
      await f.core.setGrants([{ path: f.folder, readOnly: false }]);
      if (decision === "allow") {
        const result = await f.core.execute("write_text", write(f.file("new.txt")), { source: "云端伙伴" });
        assert(result.confirmed); assert.equal(await fs.readFile(f.file("new.txt"), "utf8"), "新文本");
        assert.equal(request.source, "云端伙伴"); assert.equal(request.summary, "替换文本内容");
      } else {
        await assert.rejects(f.core.execute("write_text", write(f.file("new.txt"))), denied(decision === "throw" ? "IO" : "CONFIRM_DENIED"));
        await assert.rejects(fs.stat(f.file("new.txt")), { code: "ENOENT" });
      }
    });
  }
});

test("文件夹许可仅限可信会话，撤销授权和断线清理均清除许可", async (t) => {
  let confirmations = 0;
  const f = await fixture(t, { confirm: async () => { confirmations++; return "allow-folder-for-session"; } });
  await f.core.setGrants([{ path: f.folder, readOnly: false }]);
  await f.core.execute("write_text", write(f.file("a.txt")), { sessionId: "one" });
  await f.core.execute("write_text", write(f.file("b.txt")), { sessionId: "one" });
  assert.equal(confirmations, 1);
  await f.core.execute("write_text", write(f.file("c.txt")), { sessionId: "two" });
  await f.core.execute("write_text", write(f.file("d.txt")));
  await f.core.execute("write_text", write(f.file("e.txt")));
  assert.equal(confirmations, 4);
  f.core.clearSessions();
  await f.core.execute("write_text", write(f.file("a.txt")), { sessionId: "one" });
  assert.equal(confirmations, 5);
  await f.core.setGrants([{ path: f.folder, readOnly: true }]);
  await assert.rejects(f.core.execute("write_text", write(f.file("a.txt")), { sessionId: "one" }), denied("READ_ONLY"));
});

test("确认期间撤销授权或取消后不落盘，临时文件清理", async (t) => {
  const f = await fixture(t);
  let core;
  core = createHandsCore({ confirm: async () => { await core.setGrants([]); return "allow"; } });
  await core.setGrants([{ path: f.folder, readOnly: false }]);
  await assert.rejects(core.execute("write_text", write(f.file("new.txt"))), denied("DENIED"));
  const controller = new AbortController();
  const abortCore = createHandsCore({ confirm: async () => { controller.abort(); return "allow"; } });
  await abortCore.setGrants([{ path: f.folder, readOnly: false }]);
  await assert.rejects(abortCore.execute("write_text", write(f.file("new.txt")), { signal: controller.signal }));
  assert.deepEqual(await fs.readdir(f.folder), []);
});

test("不能把授权根目录或子目录当文件覆盖，取消接收不替换目标", async (t) => {
  const f = await fixture(t, { confirm: async () => "allow" });
  await f.core.setGrants([{ path: f.folder, readOnly: false }]);
  await fs.mkdir(f.file("child"));
  for (const filename of [f.folder, f.file("child")]) await assert.rejects(f.core.execute("write_text", write(filename)), denied("DENIED"));
  await fs.writeFile(f.file("a.txt"), "unchanged");
  await fs.writeFile(f.file("b.txt"), "destination");
  await assert.rejects(f.core.execute("move", { path: f.file("a.txt"), destination: f.file("b.txt"), summary: "禁止覆盖" }), denied("IO"));
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "unchanged");
  assert.equal(await fs.readFile(f.file("b.txt"), "utf8"), "destination");
  const controller = new AbortController();
  await assert.rejects(f.core.execute("save_to_laptop", { path: f.file("a.txt"), cloud_path: "/data/work/x", summary: "接收取消" }, {
    signal: controller.signal,
    receiveFile: async (handle) => { await handle.writeFile("partial"); controller.abort(); return 7; },
  }), denied("CANCELLED"));
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "unchanged");
  assert(!(await fs.readdir(f.root)).some((p) => p.startsWith(".zp-hands-")));
  assert(!(await fs.readdir(f.folder)).some((p) => p.startsWith(".zp-hands-")));
});

test("1 MB 文本和 200 MB 文件上限按字节执行，传输失败不覆盖已有目标", async (t) => {
  const f = await fixture(t, { confirm: async () => "allow" });
  await f.core.setGrants([{ path: f.folder, readOnly: false }]);
  const text = "x".repeat(TEXT_LIMIT);
  await f.core.execute("write_text", write(f.file("limit.txt"), text));
  assert.equal((await f.core.execute("read_text", { path: f.file("limit.txt") })).bytes, TEXT_LIMIT);
  await assert.rejects(f.core.execute("write_text", write(f.file("limit.txt"), "中".repeat(Math.ceil(TEXT_LIMIT / 3)))), denied("SIZE_LIMIT"));
  const oversized = await fs.open(f.file("big.txt"), "w");
  await oversized.truncate(FILE_LIMIT + 1); await oversized.close();
  await assert.rejects(f.core.execute("read_text", { path: f.file("big.txt") }), denied("SIZE_LIMIT"));
  await assert.rejects(f.core.execute("fetch_to_cloud", { path: f.file("big.txt") }, { sendFile: async () => assert.fail("oversize sent") }), denied("SIZE_LIMIT"));
  await assert.rejects(f.core.execute("save_to_laptop", { path: f.file("limit.txt"), cloud_path: "/data/work/a", summary: "替换" }, { receiveFile: async (handle) => { await handle.writeFile("partial"); throw new Error("transfer failed"); } }), denied("IO"));
  assert.equal(await fs.readFile(f.file("limit.txt"), "utf8"), text);
  assert(!(await fs.readdir(f.folder)).some((name) => name.startsWith(".zp-hands-")));
});

test("搜索和目录输出有界；无效参数拒绝；打开和废纸篓由宿主注入", async (t) => {
  let trashed;
  let opened;
  const f = await fixture(t, { confirm: async () => "allow", trash: async (p) => { trashed = p; await fs.rename(p, path.join(f.outside, "trashed.txt")); }, open: async (p) => { opened = p; } });
  await f.core.setGrants([{ path: f.folder, readOnly: false }]);
  await Promise.all(Array.from({ length: 510 }, (_, i) => fs.writeFile(f.file(`报价-${i}.txt`), "季度采购")));
  const listing = (await f.core.execute("list_dir", { path: f.folder })).value;
  assert.equal(listing.entries.length, 500); assert(listing.truncated);
  const search = (await f.core.execute("search", { path: f.folder, query: "季度", mode: "text" })).value;
  assert.equal(search.results.length, 100); assert(search.truncated);
  assert.throws(() => validateCall(tools, "write_text", { ...write(f.file("x")), unexpected: true }), denied("INVALID_ARGUMENT"));
  await f.core.execute("open", { path: f.file("报价-0.txt") }); assert.equal(opened, f.file("报价-0.txt"));
  await fs.writeFile(f.file("script.sh"), "echo dummy");
  await assert.rejects(f.core.execute("open", { path: f.file("script.sh") }), denied("DENIED"));
  await f.core.execute("move", { path: f.file("报价-0.txt"), destination: f.file("moved.txt"), summary: "改名" });
  await f.core.execute("delete", { path: f.file("moved.txt"), summary: "放入废纸篓" });
  assert.equal(trashed, f.file("moved.txt")); assert.equal(await fs.readFile(path.join(f.outside, "trashed.txt"), "utf8"), "季度采购");
  await assert.rejects(f.core.execute("delete", { path: f.folder, summary: "整个目录" }), denied("DENIED"));
});
