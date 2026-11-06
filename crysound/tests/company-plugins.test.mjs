import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { preparePluginPolicy } from "../config/company-plugins.mjs";
import { patchOfficialPlugins, patchOfficialPluginsRuntime } from "../scripts/patch-official-plugins.mjs";

const official = "@crysound/design", thirdParty = "dsh-slidestudio";
const config = { officialPlugins: { [official]: { displayName: "兆华设计", maintainers: [] } }, retire: { id: "market-v1", packages: [thirdParty, "dsh-video-editor", "dsh-oil-ui"] } };
function fixture(t, old = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "company-plugins-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "package.json");
  const save = (manifest) => fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  save({ dependencies: { ...(old ? { [thirdParty]: "0.2.9" } : {}), [official]: "0.2.0", personal: "1.0.0" },
    dsh: { profile: { bundles: [...(old ? [thirdParty] : []), "personal"] }, company: { unrelated: true } } });
  const work = path.join(root, "work"); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "presentation.html"), "user work");
  const calls = [];
  const remove = (names) => { calls.push(names); const manifest = read(); for (const name of names) delete manifest.dependencies[name]; save(manifest); };
  return { root, read, save, work, calls, remove };
}

test("新老工作区迁移幂等，保留作品、个人插件与已停用的官方插件；移出后允许本人重装第三方", (t) => {
  for (const old of [true, false]) {
    const f = fixture(t, old);
    preparePluginPolicy(f.root, config, f.remove);
    const first = fs.readFileSync(path.join(f.root, "package.json"));
    preparePluginPolicy(f.root, config, f.remove);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "package.json")), first);
    assert.deepEqual(f.calls, old ? [[thirdParty]] : []);
    assert.equal(f.read().dependencies[thirdParty], undefined);
    assert.equal(f.read().dependencies.personal, "1.0.0");
    assert.deepEqual(f.read().dsh.profile.bundles, ["personal"]);
    assert.deepEqual(f.read().dsh.company, { unrelated: true, officialPackages: [official] });
    assert.equal(fs.readFileSync(path.join(f.work, "presentation.html"), "utf8"), "user work");
    const manifest = f.read(); manifest.dependencies[thirdParty] = "0.2.9"; manifest.dsh.profile.bundles.push(thirdParty); f.save(manifest);
    preparePluginPolicy(f.root, config, () => assert.fail("migration must run only once"));
    assert.equal(f.read().dependencies[thirdParty], "0.2.9");
  }
});

test("移出失败保留迁移待办，官方保护已生效；下次更新重试成功后才标记", (t) => {
  const f = fixture(t);
  assert.throws(() => preparePluginPolicy(f.root, config, () => { throw new Error("remove failed"); }), /remove failed/);
  assert.equal(fs.existsSync(path.join(f.root, ".zp-retired-market-v1")), false);
  assert.deepEqual(f.read().dsh.company.officialPackages, [official]);
  assert.throws(() => preparePluginPolicy(f.root, config, () => {}), /尚未移出/);
  preparePluginPolicy(f.root, config, f.remove);
  assert.equal(fs.existsSync(path.join(f.root, ".zp-retired-market-v1")), true);
});

const published = process.env.OFFICIAL_MANAGER_MODULE;
function nativeMethods(text) {
  const names = [["readBundles", "/** Read the registries"], ["setBundleEnabled", "/**\n\t\t* Install a package"], ["removeBundle", "/** The rows a bundle's patch"], ["async updateBundle", "/**\n\t\t* The registry a version listing"]];
  return names.map(([name, end]) => text.slice(text.indexOf(`\t\t${name}(`), text.indexOf(end, text.indexOf(`\t\t${name}(`)))).join("\n");
}
function manager(text, manifest) {
  const context = {
    readProfileManifest: () => manifest, readProfileVersionExemptions: () => [], bundleSelection: (m) => m.dsh.profile.bundles,
    readFileSync: () => '{}', OFFICIAL_ON_DEMAND_CATALOG: [], OPTIONAL_BUNDLES: [], getDshRuntimeVersion: () => '0.2.2-rc.1',
    bundleManifest: (name) => ({ name, version: manifest.dependencies[name], description: name, dsh: { bundle: {} } }),
    dependencySpec: (name, version) => `${name}@${version}`, evaluatePluginCompatibility: () => undefined, resolveBundleDir: () => '/tmp',
    readPluginMeta: () => undefined, assertBundlePlatform: () => {}, process, pathToFileURL, join: path.join,
    managementError: (error) => ({ code: error.message }), ManagementFailure: class extends Error {},
    semver, parsedForRegistry: (spec) => ({ kind: 'registry', name: spec.slice(0, spec.lastIndexOf('@')) }),
    registryPlan: (registry) => [registry], VERSION_FIELDS: [],
    recordOf: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
  };
  const helpers = ['updateRefusal', 'versionFacts'].map((name) => {
    const start = text.indexOf(`function ${name}(`);
    return text.slice(start, text.indexOf('\n}', start) + 2);
  }).join('\n');
  const methods = vm.runInNewContext(`${helpers}\nnew (class {${nativeMethods(text)}})()`, context);
  return Object.assign(methods, {
    profile: {}, protectsManager: () => false, declaredRows: () => ({ rows: [], overrides: [] }),
    listBundles() { return Promise.resolve(this.readBundles()); },
    configure: (task) => task(), change: async (task, initial) => { const result = { changed: false, application: 'applied', ...initial }; await task(result); return result; },
    ownerContext: { get: () => true }, ctx: { loader: { entries: () => [] } }, bundleRows: () => [],
    selectBundle: async (name, enabled) => { manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== name); if (enabled) manifest.dsh.profile.bundles.push(name); },
    reload: () => ({}), installedFrom: new Map(), configuredRegistries: {}, runPnpm: () => ({ exitCode: 0 }), publishAndReload: () => ({}),
  });
}

function updater(text, { enabled = true, hmr = true } = {}) {
  const manifest = { dependencies: { [official]: '0.2.0' }, dsh: { profile: { bundles: enabled ? [official] : [] }, company: { officialPackages: [official] } } };
  const m = manager(text, manifest), removed = [], installed = [];
  m.ownerContext = { get: () => hmr ? true : undefined };
  m.registries = async () => ({});
  m.registryFor = () => 'https://test.invalid/';
  m.askRegistries = async () => ({ status: 'answered', registry: 'https://test.invalid/', answer: { name: official, version: '0.3.0', dsh: { bundle: {} } } });
  m.runPnpm = (args) => { removed.push(args[1]); delete manifest.dependencies[args[1]]; return { exitCode: 0 }; };
  m.installBundle = async (spec, options) => {
    installed.push(spec);
    manifest.dependencies[official] = spec.slice(spec.lastIndexOf('@') + 1);
    await m.selectBundle(official, options.enabled);
    return { changed: true, application: 'applied', stage: 'enable' };
  };
  return { m, manifest, removed, installed };
}

test("官方插件可原生更新且保留启停选择，直接卸载与额外参数仍被拒绝", { skip: !published }, async () => {
  const text = patchOfficialPlugins(fs.readFileSync(published, 'utf8'));
  for (const enabled of [true, false]) for (const hmr of [true, false]) {
    const { m, manifest, removed, installed } = updater(text, { enabled, hmr });
    await assert.rejects(() => m.removeBundle(official, true), /not-removable/);
    const result = await m.updateBundle(official, '0.3.0');
    assert.equal(result.step, 'install');
    assert.equal(manifest.dependencies[official], '0.3.0');
    assert.equal(manifest.dsh.profile.bundles.includes(official), enabled);
    assert.deepEqual(removed, hmr ? [official] : []);
    assert.deepEqual(installed, [`${official}@0.3.0`]);
    await assert.rejects(() => m.removeBundle(official), /not-removable/);
  }
});

test("官方更新失败或取消后恢复旧版，启用失败时先清理新版；恢复原启停选择", { skip: !published }, async () => {
  const text = patchOfficialPlugins(fs.readFileSync(published, 'utf8'));
  for (const enabled of [true, false]) for (const stage of ['install', 'enable']) for (const application of ['failed', 'cancelled']) {
    const { m, manifest, removed, installed } = updater(text, { enabled });
    const install = m.installBundle;
    m.installBundle = async (spec, options) => {
      if (spec.endsWith('@0.3.0')) {
        if (stage === 'enable') await install(spec, options);
        return { changed: stage === 'enable', application, stage };
      }
      return install(spec, options);
    };
    const result = await m.updateBundle(official, '0.3.0');
    assert.equal(result.result.application, application);
    assert.equal(result.restore.application, 'applied');
    assert.equal(manifest.dependencies[official], '0.2.0');
    assert.equal(manifest.dsh.profile.bundles.includes(official), enabled);
    assert.deepEqual(removed, stage === 'enable' ? [official, official] : [official]);
    assert.equal(installed.at(-1), `${official}@0.2.0`);
    await assert.rejects(() => m.removeBundle(official), /not-removable/);
  }
});

test("更新等待安装期间，另一次用户卸载仍被拒绝", { skip: !published }, async () => {
  const { m } = updater(patchOfficialPlugins(fs.readFileSync(published, 'utf8')));
  const install = m.installBundle, ready = Promise.withResolvers(), proceed = Promise.withResolvers();
  m.installBundle = async (...args) => { ready.resolve(); await proceed.promise; return install(...args); };
  const update = m.updateBundle(official, '0.3.0');
  try {
    await Promise.race([ready.promise, update.then(() => { throw new Error('update ended before installation'); })]);
    await assert.rejects(() => m.removeBundle(official, true), /not-removable/);
  } finally { proceed.resolve(); await update; }
  await assert.rejects(() => m.removeBundle(official), /not-removable/);
});

test("未获注册表确认的新版本和管理组件均在移出之前拒绝", { skip: !published }, async () => {
  const text = patchOfficialPlugins(fs.readFileSync(published, 'utf8'));
  for (const blocked of ['unapproved', 'management', 'older']) {
    const { m, manifest, removed, installed } = updater(text);
    if (blocked === 'unapproved') m.askRegistries = async () => ({ status: 'refused', reason: 'not approved' });
    if (blocked === 'management') m.protectsManager = () => true;
    const result = await m.updateBundle(official, blocked === 'older' ? '0.1.0' : '0.3.0');
    assert.equal(result.step, 'check');
    assert.equal(result.result.application, 'failed');
    assert.equal(manifest.dependencies[official], '0.2.0');
    assert.deepEqual(removed, []);
    assert.deepEqual(installed, []);
  }
});

test("真实发布的 Host 库存与卸载入口拒绝官方卸载，普通包可卸载且官方停用状态保持", { skip: !published }, async () => {
  const original = fs.readFileSync(published, "utf8");
  const manifest = { dependencies: { [official]: "0.2.0", personal: "1.0.0" }, dsh: { profile: { bundles: ["personal"] }, company: { officialPackages: [official] } } };
  for (const patched of [false, true]) {
    const m = manager(patched ? patchOfficialPlugins(original) : original, structuredClone(manifest));
    const rows = await m.listBundles();
    assert.equal(rows.find((r) => r.name === official).removable, !patched);
    assert.equal(rows.find((r) => r.name === official).enabled, false);
    assert.equal(rows.find((r) => r.name === official).error, undefined);
    assert.equal(rows.find((r) => r.name === "personal").removable, true);
    if (patched) await assert.rejects(() => m.removeBundle(official), /not-removable/);
    await m.setBundleEnabled(official, false);
    assert.equal((await m.listBundles()).find((r) => r.name === official).enabled, false);
    await m.removeBundle("personal");
  }
});

test("Host 补丁在临时副本可重复运行、保留模式并不修改硬链接来源", { skip: !published }, (t) => {
  const f = fixture(t), dir = path.join(f.root, "@deepseek-ai/dsh-plugin-manager/lib"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "index.js"), original = fs.readFileSync(published, "utf8");
  const source = path.join(f.root, "source.js"); fs.writeFileSync(source, original, { mode: 0o640 }); fs.chmodSync(source, 0o640); fs.linkSync(source, file);
  patchOfficialPluginsRuntime(f.root); const once = fs.readFileSync(file, "utf8"); patchOfficialPluginsRuntime(f.root);
  assert.equal(fs.readFileSync(file, "utf8"), once);
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.throws(() => patchOfficialPlugins(original.replace('const removable = owned', 'const changed = owned')), /未唯一命中/);
  const legacy = '/* CRYSOUND official removal policy v1 */\n' + original.replace('const removable = owned || enabled && !installed && !shipped;', 'const removable = !manifest.dsh?.company?.officialPackages?.includes(name) && (owned || enabled && !installed && !shipped);');
  assert.equal(patchOfficialPlugins(legacy), once);
  assert.throws(() => patchOfficialPlugins(original.replace('removeBundle(name) {', 'unsupportedRemove(name) {')), /未唯一命中/);
  assert.throws(() => patchOfficialPlugins(original.replace('this.removeBundle(name)', 'this.unsupportedRemove(name)')), /未唯一命中/);
});
