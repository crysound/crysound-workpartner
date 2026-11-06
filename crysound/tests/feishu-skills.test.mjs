// Node 24, --experimental-vm-modules; real bundled skills, no dependency installation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const setup = new URL("../feishu/setup.mjs", import.meta.url);
function entries(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true });
}
function writableTree(directory) {
  fs.chmodSync(directory, 0o755);
  for (const entry of entries(directory)) {
    if (!entry.isSymbolicLink()) fs.chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
  }
}
function temp(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "partner-skills-"));
  t.after(() => { writableTree(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
// Model Windows' read-only file deletion restriction even on Linux.
function removeWritableTree(directory, options) {
  for (const file of [directory, ...entries(directory).map(entry => join(entry.parentPath, entry.name))]) {
    assert.ok(fs.statSync(file).mode & 0o200, `cleanup must restore write permission: ${file}`);
  }
  fs.rmSync(directory, options);
}
async function load(overrides = {}) {
  const context = createContext({ URL, process: { argv: [], platform: process.platform } });
  const module = new SourceTextModule(fs.readFileSync(setup, "utf8"), {
    context, initializeImportMeta(meta) { meta.url = setup.href; },
  });
  await module.link(async (name) => {
    const exports = overrides[name] ?? await import(name);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace.prepareSkills;
}

test("publishes bundled skills while the root is writable, then makes the final tree read-only and reuses it", async (t) => {
  const parent = temp(t);
  let renames = 0;
  const prepare = await load({ "node:fs": { default: { ...fs,
    renameSync(source, target) {
      // macOS rejects moving a directory whose own write permission was removed.
      if (!(fs.statSync(source).mode & 0o200)) throw Object.assign(new Error("read-only directory cannot move"), { code: "EACCES" });
      renames++;
      fs.renameSync(source, target);
    }, rmSync: removeWritableTree,
  } } });
  const target = prepare(parent);
  assert.equal(renames, 1);
  assert.deepEqual(fs.readdirSync(parent), [target.slice(parent.length + 1)]);
  assert.ok(fs.readFileSync(join(target, "lark-doc", "SKILL.md"), "utf8").length > 0);
  assert.match(fs.readFileSync(join(target, ".complete"), "utf8"), /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o555);
    for (const entry of entries(target)) assert.equal(fs.statSync(join(entry.parentPath, entry.name)).mode & 0o777, entry.isDirectory() ? 0o555 : 0o444);
  }
  const unchanged = fs.statSync(join(target, ".complete")).mtimeMs;
  assert.equal(prepare(parent), target);
  assert.equal(renames, 1);
  assert.equal(fs.statSync(join(target, ".complete")).mtimeMs, unchanged);
});

test("rename failure removes the temporary skill tree including read-only files and permits retry", async (t) => {
  const parent = temp(t);
  const failure = new Error("injected rename failure");
  const prepare = await load({ "node:fs": { default: { ...fs,
    renameSync() { throw failure; }, rmSync: removeWritableTree,
  } } });
  assert.throws(() => prepare(parent), error => error === failure);
  assert.deepEqual(fs.readdirSync(parent), []);
  assert.ok(fs.existsSync(join((await load())(parent), ".complete")));
});

test("failure to protect the published root removes its completion marker and permits retry", async (t) => {
  const parent = temp(t);
  const failure = new Error("injected final chmod failure");
  const prepare = await load({ "node:fs": { default: { ...fs,
    chmodSync(file, mode) {
      if (mode === 0o555 && fs.existsSync(join(file, ".complete")) && !/\.[a-f0-9]{24}$/.test(file)) throw failure;
      fs.chmodSync(file, mode);
    }, rmSync: removeWritableTree,
  } } });
  assert.throws(() => prepare(parent), error => error === failure);
  assert.deepEqual(fs.readdirSync(parent), []);
  assert.ok(fs.existsSync(join((await load())(parent), ".complete")));
});

test("an existing complete skill directory is reused without extraction or permission changes", async (t) => {
  const parent = temp(t), prepare = await load(), target = prepare(parent);
  const forbidden = () => { throw new Error("complete skills must not be changed"); };
  const reuse = await load({
    "node:fs": { default: { ...fs, chmodSync: forbidden, renameSync: forbidden, rmSync: forbidden, mkdirSync: forbidden } },
    "node:child_process": { spawnSync: forbidden },
  });
  assert.equal(reuse(parent), target);
});

test("failed extraction leaves no skill directory or completion marker", async (t) => {
  const parent = temp(t);
  const prepare = await load({ "node:child_process": { spawnSync: () => ({ status: 1 }) } });
  assert.throws(() => prepare(parent), /tar/);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("Windows smoke cleanup restores the read-only skill files before removing its temporary tree", async (t) => {
  const parent = temp(t), target = (await load())(parent);
  const source = fs.readFileSync(new URL("../../apps/desktop/scripts/crysound-smoke-windows-workspace.ts", import.meta.url), "utf8");
  const start = source.indexOf("function removeTemporaryTree(");
  const end = source.indexOf("\ntry {", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = new Function("existsSync", "chmodSync", "readdirSync", "join", "rmSync",
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn removeTemporaryTree;`)(fs.existsSync, fs.chmodSync, fs.readdirSync, join, removeWritableTree);
  cleanup(target);
  assert.deepEqual(fs.readdirSync(parent), []);
});
