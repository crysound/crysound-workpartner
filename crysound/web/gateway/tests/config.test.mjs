// 配置迁移、字面令牌与 Host fetch 包装均在临时文件中验证。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const config = fileURLToPath(new URL("../../../config/", import.meta.url));
const index = "http://zhaohua-partner-gateway:3090/_zp/market/index.json";
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-config-test-"));
  t.after(() => {
    for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (e.isDirectory()) fs.chmodSync(path.join(e.parentPath, e.name), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
}

test("旧 profile 补市场配置和 bundle，重复启动不重复，之后手动关闭 bundle 不重开", (t) => {
  const root = temp(t), patch = path.join(root, "cordis.patch.yml"), manifest = path.join(root, "package.json");
  fs.writeFileSync(patch, "- id: other\n  config:\n    keep: true\n");
  fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: { bundles: ["other-bundle"] } } }));
  const apply = () => run(path.join(config, "market-profile.mjs"), [patch, manifest, index]);
  apply();
  const first = fs.readFileSync(patch, "utf8");
  apply(); assert.equal(fs.readFileSync(patch, "utf8"), first);
  assert.match(first, /keep: true/); assert.match(first, /plugin-market/); assert.ok(first.includes(index));
  const m = JSON.parse(fs.readFileSync(manifest));
  assert.deepEqual(m.dsh.profile.bundles, ["other-bundle", "@deepseek-ai/dsh-experimental-plugin-market-bundle"]);
  m.dsh.profile.bundles.pop(); fs.writeFileSync(manifest, JSON.stringify(m));
  apply(); assert.deepEqual(JSON.parse(fs.readFileSync(manifest)).dsh.profile.bundles, ["other-bundle"]);
});

test("已有市场配置只补缺失的 indexes；保留用户其他设置和自定义索引", (t) => {
  const root = temp(t), patch = path.join(root, "cordis.patch.yml"), manifest = path.join(root, "package.json");
  for (const initial of [
    "- id: 'plugin-market'\n  config:\n    cacheTtlMs: 2000\n",
    "- id: plugin-market\n  config: {}\n",
    "- id: plugin-market\n  disabled: false\n",
    "[]\n",
  ]) {
    fs.writeFileSync(patch, initial); fs.writeFileSync(manifest, "{}");
    run(path.join(config, "market-profile.mjs"), [patch, manifest, index]);
    const first = fs.readFileSync(patch, "utf8");
    assert.ok(first.includes(index));
    run(path.join(config, "market-profile.mjs"), [patch, manifest, index]);
    assert.equal(fs.readFileSync(patch, "utf8"), first);
    if (initial.includes("cacheTtlMs")) assert.match(first, /cacheTtlMs: 2000/);
  }
  const custom = "- id: plugin-market\n  config:\n    indexes: [https://custom.test/index.json]\n";
  fs.writeFileSync(patch, custom);
  run(path.join(config, "market-profile.mjs"), [patch, manifest, index]);
  assert.equal(fs.readFileSync(patch, "utf8"), custom);
});

test("容器 .npmrc 写字面令牌、600，轮换后无旧令牌且保留其他 scope", (t) => {
  const root = temp(t), file = path.join(root, ".npmrc"), tokenFile = path.join(root, "fake-token");
  fs.writeFileSync(file, "registry=https://registry.npmjs.org/\n@other:registry=https://other.test/\n");
  fs.writeFileSync(tokenFile, "fake-container-token\n");
  run(path.join(config, "market-npmrc.mjs"), [file, tokenFile]);
  fs.writeFileSync(tokenFile, "fake-replacement-token\n");
  run(path.join(config, "market-npmrc.mjs"), [file, tokenFile]);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /_authToken=fake-replacement-token/);
  assert.doesNotMatch(text, /fake-container-token|\$\{/);
  assert.match(text, /@other:registry=/);
  assert.equal(text.match(/@crysound:registry=/g).length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("Host 只给公司市场补身份，保留 Request 与 init 请求头，轮换文件后读取新令牌", async (t) => {
  const root = temp(t), tokenFile = path.join(root, "fake-token");
  fs.writeFileSync(tokenFile, "fake-first-token");
  const original = globalThis.fetch;
  const savedEnv = { ...process.env };
  t.after(() => { globalThis.fetch = original; process.env = savedEnv; });
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response("{}"); };
  process.env.CRYSOUND_MARKET_ORIGIN = "http://gateway.test";
  process.env.CRYSOUND_MARKET_TOKEN_FILE = tokenFile;
  await import(`../../../host-hook.mjs?test=${Date.now()}`);
  await fetch(new Request("http://gateway.test/_zp/market/index.json", { headers: { "x-keep": "yes" } }));
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer fake-first-token");
  assert.equal(calls[0].init.headers.get("x-keep"), "yes");
  fs.writeFileSync(tokenFile, "fake-second-token");
  await fetch("http://gateway.test/_zp/market/index.json", { headers: { "x-init": "yes" } });
  assert.equal(calls[1].init.headers.get("authorization"), "Bearer fake-second-token");
  assert.equal(calls[1].init.headers.get("x-init"), "yes");
  assert.equal(calls[1].init.redirect, "error");
  await fetch("http://gateway.test.evil/_zp/market/index.json");
  await fetch("http://gateway.test/other");
  assert.equal(calls[2].init, undefined); assert.equal(calls[3].init, undefined);
});


test("桌面 profile 的 .npmrc 登录、轮换、退出仅改公司两项，权限 600", async (t) => {
  const { writeMarketNpmrc } = await import("../../../../apps/desktop/src/crysound/npmrc.ts");
  const root = temp(t), file = path.join(root, ".npmrc");
  fs.writeFileSync(file, "registry=https://registry.npmjs.org/\n@other:registry=https://other.test/\n");
  const origin = "https://partner.example.test";
  await writeMarketNpmrc(root, origin, "fake-desktop-token");
  await writeMarketNpmrc(root, origin, "fake-replacement-token");
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /_authToken=fake-replacement-token/);
  assert.doesNotMatch(text, /fake-desktop-token/);
  assert.equal(text.match(/@crysound:registry=/g).length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await writeMarketNpmrc(root, origin);
  text = fs.readFileSync(file, "utf8");
  assert.match(text, /@other:registry=/);
  assert.doesNotMatch(text, /crysound|_authToken/);
});

test("切换公司域名后移除旧入口的令牌，其他注册表凭据保持原样", async (t) => {
  const { writeMarketNpmrc } = await import("../../../../apps/desktop/src/crysound/npmrc.ts");
  const root = temp(t), file = path.join(root, ".npmrc");
  fs.writeFileSync(file, "//other.test/:_authToken=fake-other\n");
  await writeMarketNpmrc(root, "https://old.example.test", "fake-old");
  await writeMarketNpmrc(root, "https://new.example.test", "fake-new");
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /old.example.test|fake-old/);
  assert.match(text, /new.example.test\/_zp\/npm\/:_authToken=fake-new/);
  assert.match(text, /other.test\/:_authToken=fake-other/);
});

test("桌面公共配置只打包公共域名，运行时可覆盖，非法域名被拒绝", async (t) => {
  const { companyOrigin } = await import("../../../../apps/desktop/src/crysound/origin.ts");
  const root = temp(t), input = path.join(root, "fake.env"), output = path.join(root, "public-host.json");
  fs.writeFileSync(input, 'PUBLIC_HOST="partner.example.test"\nMEEGLE_HOST=project.example.test\nUNRELATED_SECRET=fake-not-for-package\n');
  run(fileURLToPath(new URL("../../../scripts/configure-public-host.mjs", import.meta.url)), [input, output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: "project.example.test" });
  assert.equal(companyOrigin(root, {}), "https://partner.example.test");
  assert.equal(companyOrigin(root, { PUBLIC_HOST: "override.example.test" }), "https://override.example.test");
  for (const PUBLIC_HOST of ["", "https://host.test", "user@host.test", "host.test/path", "host.test?query"]) {
    assert.throws(() => companyOrigin(root, { PUBLIC_HOST }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/configure-public-host.mjs", import.meta.url)), input, output], {
      encoding: "utf8", env: { PATH: process.env.PATH, PUBLIC_HOST },
    });
    assert.equal(result.status, 1);
  }
});

test("桌面工作区升级实际补齐索引和可发现技能，重复启动保留用户关闭状态", async (t) => {
  const { prepareCompanyWorkspace } = await import("../../../../apps/desktop/src/crysound/workspace.ts");
  const root = temp(t), assets = path.join(root, "assets"), profile = path.join(root, "dsh/profiles/desktop"), userData = path.join(root, "user-data");
  fs.mkdirSync(path.join(assets, "config"), { recursive: true });
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(userData);
  fs.cpSync(path.join(config, "skills"), path.join(assets, "config/skills"), { recursive: true });
  for (const name of ["company-plugins.mjs", "market-profile.mjs", "profile-upgrades.mjs", "partner.patch.yml"]) {
    fs.copyFileSync(path.join(config, name), path.join(assets, "config", name));
  }
  fs.cpSync(fileURLToPath(new URL("../../../feishu/", import.meta.url)), path.join(assets, "feishu"), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL("../../../plugin-artifacts.mjs", import.meta.url)), path.join(assets, "plugin-artifacts.mjs"));
  fs.writeFileSync(path.join(assets, "config/public-host.json"), JSON.stringify({ PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: "project.example.test" }));
  const defaults = JSON.parse(fs.readFileSync(path.join(config, "plugins.json"))).defaultBundles;
  fs.writeFileSync(path.join(assets, "config/plugins.json"), JSON.stringify({ plugins: [], defaultBundles: defaults }));
  fs.writeFileSync(path.join(profile, "package.json"), "{}");
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "- id: other\n  config:\n    keep: true\n");
  for (const mark of [".zp-default-plugins-v1", ".zp-seed-v1"]) fs.writeFileSync(path.join(userData, mark), "");
  const options = { assets, profile, userData, execPath: process.execPath, cliEntry: process.env.DSH_CLI_ENTRY || fileURLToPath(new URL("../../../../apps/cli/src/bin.ts", import.meta.url)), environment: { PATH: process.env.PATH, CRYSOUND_LLM_BASE: "https://partner.example.test/_zp/llm/v1" } };
  await prepareCompanyWorkspace(options);
  assert.match(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /https:\/\/partner.example.test\/_zp\/market\/index.json/);
  assert.match(fs.readFileSync(path.join(root, "dsh/skills/publish-zhaohua-market/SKILL.md"), "utf8"), /name: publish-zhaohua-market/);
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, "package.json")));
  assert.ok(manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-experimental-plugin-market-bundle"));
  manifest.dsh.profile.bundles = [];
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify(manifest));
  await prepareCompanyWorkspace(options);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, "package.json"))).dsh.profile.bundles, []);
});

test("不支持的用户 YAML 或无效 manifest 只警告，跳过市场配置且保留原文件", (t) => {
  const root = temp(t), patch = path.join(root, "cordis.patch.yml"), manifest = path.join(root, "package.json");
  for (const initial of [
    "- id: plugin-market\n  config: {cacheTtlMs: 2000}\n",
    "- {id: plugin-market, config: {indexes: []}}\n",
    "[{id: plugin-market, config: {indexes: []}}]\n",
  ]) {
    fs.writeFileSync(patch, initial); fs.writeFileSync(manifest, "{}");
    const result = spawnSync(process.execPath, [path.join(config, "market-profile.mjs"), patch, manifest, index], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /警告.*已跳过/);
    assert.equal(fs.readFileSync(patch, "utf8"), initial);
    assert.equal(fs.readFileSync(manifest, "utf8"), "{}");
    assert.equal(fs.existsSync(path.join(root, ".zp-market-v1")), false);
  }
  fs.writeFileSync(patch, "[]\n"); fs.writeFileSync(manifest, "broken");
  const result = spawnSync(process.execPath, [path.join(config, "market-profile.mjs"), patch, manifest, index], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /警告.*无法解析/);
  assert.equal(fs.readFileSync(patch, "utf8"), "[]\n");
  assert.equal(fs.readFileSync(manifest, "utf8"), "broken");
});

test("可选市场配置、插件修补和技能复制失败仍启动 dsh，公司模型刷新失败则停止", (t) => {
  const root = temp(t), bin = path.join(root, "bin"), home = path.join(root, "dsh");
  fs.mkdirSync(bin); fs.mkdirSync(home);
  for (const mark of [".zp-default-plugins-v1", ".zp-seed-v1"]) fs.writeFileSync(path.join(home, mark), "");
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  stub("node", 'if [ "$1" = "-e" ]; then exit 0; fi\ncase "$1" in */plugin-artifacts.mjs|*profile-upgrades.mjs) exit 0;; esac\nexit 1');
  stub("cp", "exit 1");
  stub("cat", "echo fake-model-key");
  stub("mkdir", 'if [ "$2" = "/data/work" ]; then exit 1; fi\nexec /bin/mkdir "$@"');
  stub("hostname", "echo 127.0.0.1");
  stub("dsh", 'echo "dsh launched: $*"\numask');
  const mounted = path.join(root, "config");
  fs.cpSync(config, mounted, { recursive: true });
  const entrypoint = path.join(root, "entrypoint.sh");
  fs.writeFileSync(entrypoint, fs.readFileSync(fileURLToPath(new URL("../../entrypoint.sh", import.meta.url)), "utf8").replace("CONFIG=/opt/partner-config", `CONFIG=${mounted}`));
  const result = spawnSync("/bin/sh", ["-c", 'umask 022; exec /bin/sh "$1"', "entrypoint-test", entrypoint], {
    cwd: root, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, DSH_HOME: home, PUBLIC_HOST: "partner.example.test", MAGPIE_BASE_URL: "http://models.example.test/v1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dsh launched: --profile web/);
  for (const step of ["市场 npm 配置", "插件修补", "市场发布技能复制", "市场 profile 配置"]) assert.ok(result.stderr.includes(`警告：${step}失败`), step);
  assert.match(result.stdout, /\n0*22\s*$/);
  stub("node", 'if [ "$1" = "-e" ]; then exit 0; fi\ncase "$1" in */plugin-artifacts.mjs) exit 0;; esac\nexit 1');
  const failed = spawnSync("/bin/sh", [entrypoint], {
    cwd: root, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, DSH_HOME: home, PUBLIC_HOST: "partner.example.test", MAGPIE_BASE_URL: "http://models.example.test/v1" },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /公司模型配置刷新失败/);
  assert.doesNotMatch(failed.stdout, /dsh launched/);
});
