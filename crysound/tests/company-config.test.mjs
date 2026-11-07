// Run in the existing runtime image: see crysound/web/README.md. No dependency installation or image build.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, cp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { refreshProfile } from "../config/profile-upgrades.mjs";
import { serveCompanyConfig, CONFIG_FILES } from "../web/gateway/company-config.mjs";
import { tokenUser } from "../web/gateway/market-auth.mjs";
import { companyConfig } from "../../apps/desktop/src/crysound/company-config.ts";
import { prepareCompanyWorkspace } from "../../apps/desktop/src/crysound/workspace.ts";

const runtime = process.env.DSH_CLI_ENTRY || "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js";
let require = createRequire(runtime);
for (const name of ["@deepseek-ai/dsh/package.json", "@deepseek-ai/dsh-base/package.json", "@deepseek-ai/dsh-config-editor/package.json"]) require = createRequire(require.resolve(name));
const yaml = require("yaml");
const assets = resolve(import.meta.dirname, "..");
const secret = "fake-session-secret-for-tests";
const sign = (payload) => {
  const data = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
  return `zpd.${data}.${crypto.createHmac("sha256", secret).update(`zpd.${data}`).digest("base64url")}`;
};
const token = sign({ u: "fake-user", e: Date.now() / 1000 + 3600 });
const auth = (req) => tokenUser(req, secret, [{ unionId: "fake-user", slug: "fake-user" }]);
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "partner-config-test-"));
  t.after(async () => {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o755);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return `http://127.0.0.1:${instance.address().port}`;
}
const load = (text) => yaml.parse(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }] });
const provider = (rows) => rows.findLast(row => row.id === "llm-pi-ai").config.providers;

test("new and existing company profiles declare image input for both GPT models", async (t) => {
  const root = await temp(t), seed = join(assets, "config/partner.patch.yml");
  const { Config } = await import(createRequire(runtime).resolve("@deepseek-ai/dsh-llm-pi-ai"));
  for (const existing of [false, true]) {
    const file = join(root, existing ? "existing.yml" : "new.yml");
    if (existing) {
      const legacy = load(await readFile(seed, "utf8"));
      for (const model of provider(legacy).magpie.models) delete model.input;
      provider(legacy).personal = { api: "openai-completions", models: [{ id: "personal-text-model" }] };
      await writeFile(file, yaml.stringify(legacy));
    }
    refreshProfile(file, seed, yaml, !existing);
    const after = await readFile(file, "utf8");
    const profiles = Config({ providers: provider(load(after)) }).providers.get();
    assert.equal(profiles.magpie.api, "openai-completions");
    assert.deepEqual(profiles.magpie.models.map(model => [model.id, model.input]), [
      ["codex/gpt-6.1-sol", ["text", "image"]],
      ["codex/gpt-6.1-terra", ["text", "image"]],
    ]);
    if (existing) assert.deepEqual(profiles.personal.models[0].input, [], "personal model capabilities stay unchanged");
    refreshProfile(file, seed, yaml);
    assert.equal(await readFile(file, "utf8"), after, "second refresh is byte-identical");
  }
});

test("new and existing company profiles enable the Sidebar Browser before plugin loading", async (t) => {
  const root = await temp(t), seed = join(assets, "config/partner.patch.yml");
  const scenarios = [
    undefined,
    "# existing workspace\n- id: ui-sidebar-terminal\n  disabled: true\n",
    "- id: ui-sidebar-browser\n  disabled: true\n",
    "- id: ui-sidebar-browser\n  disabled: !!js ctx.get('profileContext')?.name !== 'desktop'\n",
    "- id: ui-sidebar-browser\n  disabled: false\n- id: ui-sidebar-browser\n  disabled: true\n",
  ];
  for (const [index, before] of scenarios.entries()) {
    const file = join(root, `browser-${index}.yml`);
    if (before !== undefined) await writeFile(file, before);
    refreshProfile(file, seed, yaml, before === undefined, true);
    const after = await readFile(file, "utf8"), rows = load(after);
    assert.equal(rows.findLast(row => row.id === "ui-sidebar-browser")?.disabled, false,
      `scenario ${index} must override the upstream desktop-only disabled expression`);
    if (index === 1) {
      assert.equal(rows.find(row => row.id === "ui-sidebar-terminal").disabled, true);
      assert.match(after, /# existing workspace/);
    }
    refreshProfile(file, seed, yaml, false, true);
    assert.equal(await readFile(file, "utf8"), after, "second refresh is byte-identical");
  }
});

test("shared refresh preserves an existing desktop Browser choice", async (t) => {
  const root = await temp(t), file = join(root, "desktop.yml"), seed = join(assets, "config/partner.patch.yml");
  await writeFile(file, "- id: ui-sidebar-browser\n  disabled: true\n");
  refreshProfile(file, seed, yaml);
  assert.equal(load(await readFile(file, "utf8")).find(row => row.id === "ui-sidebar-browser").disabled, true);
});

test("refresh replaces the whole company provider and keeps personal providers, comments, expressions and chosen default", async (t) => {
  const root = await temp(t), file = join(root, "cordis.patch.yml"), seed = join(assets, "config/partner.patch.yml");
  await writeFile(file, `# personal configuration\n- id: "llm-pi-ai"\n  config:\n    providers:\n      magpie: {models: [{id: retired-model}], stale: true}\n      mine: {baseURL: 'https://personal.example/v1', models: [{id: personal}]}\n- id: agent-default-model\n  config: {provider: mine, model: personal, reasoningEffort: high}\n- id: expression\n  config:\n    value: !!js process.env.TEST_VALUE\n`);
  refreshProfile(file, seed, yaml);
  const after = await readFile(file, "utf8"), rows = load(after);
  assert.deepEqual(provider(rows).magpie, provider(load(await readFile(seed, "utf8"))).magpie);
  assert.deepEqual(provider(rows).mine, { baseURL: "https://personal.example/v1", models: [{ id: "personal" }] });
  assert.deepEqual(rows[1].config, { provider: "mine", model: "personal", reasoningEffort: "high" });
  assert.match(after, /# personal configuration/);
  assert.match(after, /!!js process.env.TEST_VALUE/);
  refreshProfile(file, seed, yaml);
  assert.equal(await readFile(file, "utf8"), after, "second run is byte-identical");
  const update = join(root, "new-seed.yml");
  await writeFile(update, (await readFile(seed, "utf8")).replaceAll("codex/gpt-6.1-sol", "codex/model-next"));
  refreshProfile(file, update, yaml);
  assert.equal(provider(load(await readFile(file, "utf8"))).magpie.models[0].id, "codex/model-next");
  assert.ok(provider(load(await readFile(file, "utf8"))).mine);
});

test("first startup seeds defaults once; subsequent startups preserve user choices and old defaults migrate", async (t) => {
  const root = await temp(t), file = join(root, "cordis.patch.yml"), seed = join(assets, "config/partner.patch.yml");
  refreshProfile(file, seed, yaml, true);
  let text = await readFile(file, "utf8");
  assert.deepEqual(load(text).filter(row => !row.insert).map(row => row.id), load(await readFile(seed, "utf8")).map(row => row.id));
  text = text.replace("    reasoningEffort: medium\n", "");
  await writeFile(file, text);
  refreshProfile(file, seed, yaml);
  assert.equal(load(await readFile(file, "utf8")).find(row => row.id === "agent-default-model").config.reasoningEffort, "medium");
  await writeFile(file, (await readFile(file, "utf8")).replace("    reasoningEffort: medium", "    reasoningEffort: max"));
  refreshProfile(file, seed, yaml);
  assert.equal(load(await readFile(file, "utf8")).find(row => row.id === "agent-default-model").config.reasoningEffort, "max");
  await writeFile(file, "[]\n");
  refreshProfile(file, seed, yaml);
  assert.deepEqual(load(await readFile(file, "utf8")).filter(row => !row.insert).map(row => row.id), ["llm-pi-ai", "web-search-deepseek", "tool-web", "ui-chat"]);
});

test("new and existing profiles refresh web limits, preserve unrelated options and repeat identically", async (t) => {
  const root = await temp(t), seed = join(assets, "config/partner.patch.yml");
  const { Config, apply } = await import(createRequire(runtime).resolve("@deepseek-ai/dsh-tool-web"));
  for (const [index, before] of [undefined, "[]\n", "- id: tool-web\n  config: {fetchOpen: true, fetchOpenModel: old, fetchOpenTimeoutMs: 6000, fetchMaxOutputChars: 200000, searchTimeoutMs: 65000, searchMaxResults: 6, fetchTimeoutMs: 12000}\n"].entries()) {
    const file = join(root, `web-${index}.yml`);
    if (before !== undefined) await writeFile(file, before);
    refreshProfile(file, seed, yaml, before === undefined);
    const after = await readFile(file, "utf8");
    const config = load(after).findLast(row => row.id === "tool-web").config;
    assert.equal(config.fetchMaxOutputChars, 40000);
    assert.equal(config.searchTimeoutMs, 18000);
    assert.equal(config.fetchSummary, true);
    assert.equal(config.fetchSummaryModel, "deepseek/deepseek-flash");
    assert.equal(config.fetchSummaryTimeoutMs, 2000);
    assert.equal(config.fetchSummaryMaxTokens, 1600);
    assert.equal(config.fetchSummaryMinChars, 12000);
    assert.equal(config.fetchDeepSeek, true);
    assert.equal(config.fetchDeepSeekTimeoutMs, 8000);
    assert.equal(config.fetchDeepSeekMinChars, 80);
    assert.equal(config.fetchTreg, true);
    assert.equal(config.fetchOpen, undefined);
    assert.equal(config.fetchOpenModel, undefined);
    assert.equal(config.fetchOpenTimeoutMs, undefined);
    assert.equal(config.fetchDirectTimeoutMs, 1500);
    assert.equal(config.fetchTregTimeoutMs, 8000);
    assert.equal(config.fetchTotalTimeoutMs, 9500);
    assert.match(config.fetchSummaryBaseURL, /CRYSOUND_LLM_BASE/);
    const tools = [];
    apply({ tools: { register: tool => tools.push(tool) }, systemPrompt: { section() {}, getSectionOrder() { return 0; } } }, Config(config));
    assert.equal(tools.find(tool => tool.name === "web_search").timeoutMs, 18000);
    const fetch = tools.find(tool => tool.name === "web_fetch");
    const result = { url: "https://example.com/article", statusCode: 200, body: { kind: "text", content: "证据".repeat(30000) }, truncated: false };
    const output = fetch.output.render({}, result)[0].text;
    assert.equal(output.length, 40000);
    assert.match(output, /Content truncated/);
    assert.equal(fetch.output.presentationMeta({}, result).truncated, true);
    if (index === 2) {
      assert.equal(config.searchMaxResults, 6);
      assert.equal(fetch.timeoutMs, 12000);
    }
    refreshProfile(file, seed, yaml);
    assert.equal(await readFile(file, "utf8"), after);
  }
});

test("company summary rollback and model changes reach existing profiles without disturbing personal options", async t => {
  const root = await temp(t), seed = join(root, "company.yml"), file = join(root, "profile.yml");
  const company = await readFile(join(assets, "config/partner.patch.yml"), "utf8");
  await writeFile(seed, company);
  await writeFile(file, "- id: tool-web\n  config: {fetchSummary: false, searchMaxResults: 6}\n");
  refreshProfile(file, seed, yaml);
  assert.equal(load(await readFile(file, "utf8")).find(row => row.id === "tool-web").config.fetchSummary, true);
  await writeFile(seed, company.replace("fetchSummary: true", "fetchSummary: false").replace("fetchSummaryModel: deepseek/deepseek-flash", "fetchSummaryModel: codex/gpt-6.1-sol").replace("fetchTreg: true", "fetchTreg: false").replace("fetchDeepSeek: true", "fetchDeepSeek: false").replace("fetchTregTimeoutMs: 8000", "fetchTregTimeoutMs: 7000"));
  refreshProfile(file, seed, yaml);
  const after = await readFile(file, "utf8"), config = load(after).find(row => row.id === "tool-web").config;
  assert.equal(config.fetchSummary, false);
  assert.equal(config.fetchSummaryModel, "codex/gpt-6.1-sol");
  assert.equal(config.fetchTreg, false);
  assert.equal(config.fetchDeepSeek, false);
  assert.equal(config.fetchTregTimeoutMs, 7000);
  assert.equal(config.searchMaxResults, 6);
  assert.match(after, /!!js process.env.CRYSOUND_LLM_BASE/);
  refreshProfile(file, seed, yaml);
  assert.equal(await readFile(file, "utf8"), after);
});

test("new and existing profiles load one company guidance module, refresh its contents and retain other settings", async (t) => {
  const root = await temp(t), seed = join(assets, "config/partner.patch.yml");
  for (const existing of [false, true]) {
    const directory = join(root, existing ? "existing" : "new");
    await mkdir(directory);
    const file = join(directory, "cordis.patch.yml");
    if (existing) await writeFile(file, "# personal\n- id: system-prompt\n  config: {personaPrefix: 'My persona'}\n");
    refreshProfile(file, seed, yaml, !existing);
    const entries = load(await readFile(file, "utf8")).flatMap(row => row.insert || []);
    assert.deepEqual(entries, [{ id: "crysound-tool-efficiency", name: "./crysound-tool-efficiency.mjs" }]);
    const module = join(directory, "crysound-tool-efficiency.mjs");
    const expected = await readFile(module, "utf8");
    assert.match(expected, /Use tools efficiently/);
    const before = await readFile(file, "utf8");
    if (existing) assert.match(before, /My persona/);
    await writeFile(module, "// stale company module\n");
    refreshProfile(file, seed, yaml);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await readFile(module, "utf8"), expected);
    const manifest = join(directory, "package.json");
    await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    const result = spawnSync(process.execPath, [join(assets, "config/market-profile.mjs"), file, manifest, "https://market.example.invalid/index.json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "company insertion must not prevent market setup");
    assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")).dsh.profile.bundles, ["@deepseek-ai/dsh-experimental-plugin-market-bundle"]);
  }
});

test("invalid personal configuration fails without changing the file", async (t) => {
  const root = await temp(t), file = join(root, "cordis.patch.yml");
  for (const text of ["- id: [broken\n", "- id: llm-pi-ai\n  config:\n    providers: !!js process.env.PROVIDERS\n", "- id: web-search-deepseek\n  config: !!js process.env.SEARCH_CONFIG\n", "- id: tool-web\n  config: !!js process.env.TOOL_CONFIG\n"]) {
    await writeFile(file, text);
    assert.throws(() => refreshProfile(file, join(assets, "config/partner.patch.yml"), yaml));
    assert.equal(await readFile(file, "utf8"), text);
  }
});

test("gateway requires a valid active desktop token, serves only the allowlisted files, and reflects file updates", async (t) => {
  const root = await temp(t);
  for (const file of CONFIG_FILES) { await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), `test ${file}`); }
  const origin = await server(t, (req, res) => void serveCompanyConfig(req, res, new URL(req.url, "http://localhost").pathname, auth, root));
  const headers = { authorization: `Bearer ${token}` };
  for (const credential of [undefined, "fake-token", sign({ u: "fake-user", e: 1 }), sign({ u: "removed-user", e: Date.now() / 1000 + 3600 }), sign("bad-json"), sign(null), `${token}.extra`, `zpd.fake.${"é".repeat(43)}`]) {
    const response = await fetch(`${origin}/_zp/config/plugins.json`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    assert.equal(response.status, 401);
    await response.text();
  }
  for (const file of CONFIG_FILES) {
    const response = await fetch(`${origin}/_zp/config/${file}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), `test ${file}`);
  }
  for (const file of ["secret.key", "%2e%2e%2fsecret.key", "subdir/plugins.json"]) {
    const response = await fetch(`${origin}/_zp/config/${file}`, { headers });
    assert.equal(response.status, 404); await response.text();
  }
  const post = await fetch(`${origin}/_zp/config/plugins.json`, { method: "POST", headers });
  assert.equal(post.status, 405); await post.text();
  await writeFile(join(root, "plugins.json"), "updated");
  assert.equal(await (await fetch(`${origin}/_zp/config/plugins.json`, { headers })).text(), "updated");
  await rm(join(root, "plugins.json"));
  assert.equal((await fetch(`${origin}/_zp/config/plugins.json`, { headers })).status, 503);
});

test("desktop selects the gateway snapshot, otherwise the whole packaged snapshot; partial downloads are cleaned", async (t) => {
  const root = await temp(t);
  let failure = false, invalid = false;
  const origin = await server(t, async (req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/_zp/feishu/desktop-config") return res.end(JSON.stringify({ meegle_host: "project.example.test" }));
    const file = req.url.slice("/_zp/config/".length);
    if (failure && file === "partner.patch.yml") { res.writeHead(503); return res.end(); }
    res.end(file === "plugins.json" ? (invalid ? "{}" : JSON.stringify({ plugins: [], defaultBundles: [] })) : `remote ${file}`);
  });
  const environment = { CRYSOUND_LLM_BASE: `${origin}/_zp/llm/v1`, MAGPIE_API_KEY: token };
  const remote = await companyConfig(assets, root, environment);
  assert.notEqual(remote.directory, join(assets, "config"));
  assert.equal(await readFile(join(remote.directory, "partner.patch.yml"), "utf8"), "remote partner.patch.yml");
  await remote.dispose();
  failure = true;
  assert.equal((await companyConfig(assets, root, environment)).directory, join(assets, "config"));
  failure = false; invalid = true;
  assert.equal((await companyConfig(assets, root, environment)).directory, join(assets, "config"));
  assert.equal((await companyConfig(assets, root, { ...environment, CRYSOUND_LLM_BASE: "not a URL" })).directory, join(assets, "config"));
  assert.deepEqual(await readdir(root), []);
});

test("desktop startup applies the selected plugin version and provider, then falls back to packaged config offline", async (t) => {
  const root = await temp(t), profile = join(root, "dsh/profiles/desktop"), userData = join(root, "userData");
  const packaged = join(root, "packaged"), config = join(packaged, "config"), fakeCli = join(root, "cli.cjs");
  await mkdir(profile, { recursive: true }); await mkdir(config, { recursive: true });
  await cp(join(assets, "feishu"), join(packaged, "feishu"), { recursive: true });
  await cp(join(assets, "plugin-artifacts.mjs"), join(packaged, "plugin-artifacts.mjs"));
  await writeFile(join(config, "public-host.json"), JSON.stringify({ PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: "project.example.test" }));
  // Exercise the real preparer and subprocess scripts; the fake installer only records the requested plugin.
  await mkdir(join(root, "node_modules/@deepseek-ai"), { recursive: true });
  await symlink(resolve(createRequire(runtime).resolve("@deepseek-ai/dsh/package.json"), ".."), join(root, "node_modules/@deepseek-ai/dsh"), "dir");
  await writeFile(join(profile, "package.json"), JSON.stringify({ dependencies: {} }));
  await writeFile(fakeCli, `const fs=require('fs'),p=process.env.TEST_MANIFEST,spec=process.argv.at(-1),m=JSON.parse(fs.readFileSync(p));m.dependencies['fake-plugin']=spec.split('@').at(-1);fs.writeFileSync(p,JSON.stringify(m));`);
  for (const file of CONFIG_FILES) { await mkdir(join(config, file, ".."), { recursive: true }); await writeFile(join(config, file), await readFile(join(assets, "config", file))); }
  await writeFile(join(config, "plugins.json"), JSON.stringify({ plugins: [{ name: "fake-plugin", spec: "fake-plugin@1", want: "1" }], defaultBundles: ["fake-bundle"] }));
  let online = true, version = "2";
  const origin = await server(t, async (req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    if (!online) { res.writeHead(503); return res.end(); }
    if (req.url === "/_zp/feishu/desktop-config") return res.end(JSON.stringify({ meegle_host: "project.example.test" }));
    const file = req.url.slice("/_zp/config/".length);
    const text = await readFile(join(config, file), "utf8");
    res.end(file === "plugins.json" ? text.replaceAll('"1"', `"${version}"`).replace("fake-plugin@1", `fake-plugin@${version}`) : text.replaceAll("codex/gpt-6.1-sol", "codex/company-model"));
  });
  const options = { assets: packaged, profile, userData, cliEntry: fakeCli, execPath: process.execPath,
    environment: { ...process.env, CRYSOUND_LLM_BASE: `${origin}/_zp/llm/v1`, MAGPIE_API_KEY: token, TEST_MANIFEST: join(profile, "package.json") } };
  await prepareCompanyWorkspace(options);
  assert.equal(JSON.parse(await readFile(join(profile, "package.json"))).dependencies["fake-plugin"], "2");
  assert.equal(provider(load(await readFile(join(profile, "cordis.patch.yml"), "utf8"))).magpie.models[0].id, "codex/company-model");
  version = "3";
  await prepareCompanyWorkspace(options);
  assert.equal(JSON.parse(await readFile(join(profile, "package.json"))).dependencies["fake-plugin"], "3");
  online = false;
  await prepareCompanyWorkspace(options);
  assert.equal(JSON.parse(await readFile(join(profile, "package.json"))).dependencies["fake-plugin"], "1");
  const manifest = JSON.parse(await readFile(join(profile, "package.json")));
  assert.deepEqual(manifest.dsh.profile.bundles, ["fake-bundle", "@deepseek-ai/dsh-experimental-plugin-market-bundle"]);
  assert.equal(provider(load(await readFile(join(profile, "cordis.patch.yml"), "utf8"))).magpie.models[0].id, "codex/gpt-6.1-sol");
  assert.deepEqual((await readdir(userData)).filter(file => file.startsWith("company-config-")), []);
  // PUBLIC_HOST can launch from source without generating public-host.json.
  await rm(join(config, "public-host.json"));
  online = true;
  await prepareCompanyWorkspace(options);
  const feishuConfig = join(userData, "company/feishu.json");
  assert.equal(JSON.parse(await readFile(feishuConfig, "utf8")).meegleHost, "project.example.test");
  online = false;
  await prepareCompanyWorkspace(options);
  assert.equal(JSON.parse(await readFile(feishuConfig, "utf8")).meegleHost, "");
  assert.match(await readFile(join(userData, "company/bin/lark-cli"), "utf8"), /cli\.mjs/);
  await writeFile(join(config, "public-host.json"), "not JSON");
  await assert.rejects(prepareCompanyWorkspace(options), SyntaxError);
});


test("self-service onboarding passes a read-only host config mount and model URL to Docker", async () => {
  const context = createContext({ process: { env: {
    HOST_PARTNER_DATA: "/host/data", HOST_PARTNER_SECURE: "/host/secure", HOST_PARTNER_CONFIG: "/host/company-config",
    MAGPIE_BASE_URL: "https://models.example.invalid/v1", PUBLIC_HOST: "partner.example.invalid", PARTNER_IMAGE: "fake-image",
  } }, console: { log() {} } });
  let users = [];
  const filesystem = { existsSync: () => true, mkdirSync() {}, chownSync() {},
    readFileSync: () => JSON.stringify(users), writeFileSync: (_file, text) => { users = JSON.parse(text); } };
  const module = new SourceTextModule(await readFile(join(assets, "web/gateway/onboard.mjs"), "utf8"), { context });
  await module.link((name) => name === "./market-auth.mjs"
    ? new SyntheticModule(["writeContainerToken"], function () { this.setExport("writeContainerToken", () => {}); }, { context })
    : name === "../preview/gateway.mjs"
      ? new SyntheticModule(["writeRelayKey"], function () { this.setExport("writeRelayKey", () => {}); }, { context })
      : new SyntheticModule(["default"], function () { this.setExport("default", name === "node:fs" ? filesystem : crypto); }, { context }));
  await module.evaluate();
  const calls = [];
  const docker = async (method, path, body) => {
    calls.push({ method, path, body });
    return { status: method === "GET" ? 404 : path.startsWith("/containers/create") ? 201 : 204, body: "" };
  };
  await module.namespace.provision(docker, { unionId: "fake-user", name: "Fake" });
  const request = calls.find(call => call.path.startsWith("/containers/create")).body;
  assert.deepEqual(JSON.parse(JSON.stringify(request.HostConfig.Mounts)), [
    { Type: "bind", Source: "/host/company-config", Target: "/opt/partner-config", ReadOnly: true },
  ]);
  assert.ok(request.Env.includes("MAGPIE_BASE_URL=https://models.example.invalid/v1"));
  assert.equal(users.length, 1);
});


test("configuration refresh resolves a source-only dependency tree without any generated lib files", async (t) => {
  const root = await temp(t);
  const packages = [
    ["cli", "@deepseek-ai/dsh", { "./lib/bin.js": "./lib/bin.js", "./package.json": "./package.json" }],
    ["base", "@deepseek-ai/dsh-base", { ".": "./lib/index.js", "./package.json": "./package.json" }],
    ["editor", "@deepseek-ai/dsh-config-editor", { ".": "./lib/index.js", "./package.json": "./package.json" }],
  ];
  for (const [directory, name, exports] of packages) {
    await mkdir(join(root, directory, "src"), { recursive: true });
    await writeFile(join(root, directory, "package.json"), JSON.stringify({ name, type: "module", exports }));
  }
  for (const [parent, dependency, target] of [["cli", "@deepseek-ai/dsh-base", "base"], ["base", "@deepseek-ai/dsh-config-editor", "editor"]]) {
    const link = join(root, parent, "node_modules", dependency);
    await mkdir(join(link, ".."), { recursive: true });
    await symlink(join(root, target), link, "dir");
  }
  await mkdir(join(root, "editor/node_modules"), { recursive: true });
  await symlink(join(require.resolve("yaml/package.json"), ".."), join(root, "editor/node_modules/yaml"), "dir");
  const cliEntry = join(root, "cli/src/bin.ts"), patch = join(root, "cordis.patch.yml");
  await writeFile(cliEntry, "// Source entry; no generated artifacts.\n");
  const result = spawnSync(process.execPath, [join(assets, "config/profile-upgrades.mjs"), patch,
    join(assets, "config/partner.patch.yml"), cliEntry, "--seed"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(provider(load(await readFile(patch, "utf8"))).magpie.models[0].id, "codex/gpt-6.1-sol");
  await writeFile(patch, "- id: ui-sidebar-browser\n  disabled: !!js ctx.get('profileContext')?.name !== 'desktop'\n");
  const web = spawnSync(process.execPath, [join(assets, "config/profile-upgrades.mjs"), patch,
    join(assets, "config/partner.patch.yml"), cliEntry, "--web-preview"], { encoding: "utf8" });
  assert.equal(web.status, 0, web.stderr);
  assert.equal(load(await readFile(patch, "utf8")).find(row => row.id === "ui-sidebar-browser").disabled, false);
  for (const [directory] of packages) assert.ok(!(await readdir(join(root, directory))).includes("lib"));
});

test("startup refreshes missing and literal search settings from company config on every run", async (t) => {
  const root = await temp(t), file = join(root, "cordis.patch.yml"), seed = join(assets, "config/partner.patch.yml");
  for (const baseURL of [undefined, "http://models.example.invalid:3425/v1", "https://partner.example.invalid/_zp/llm/v1"]) {
    const rows = baseURL === undefined ? [] : [{ id: "web-search-deepseek", disabled: true,
      config: { baseURL, model: "codex/gpt-6-luna", maxResults: 3 } }];
    await writeFile(file, yaml.stringify(rows));
    refreshProfile(file, seed, yaml);
    const after = await readFile(file, "utf8");
    const search = load(after).find(row => row.id === "web-search-deepseek");
    assert.equal(search.config.baseURL, "process.env.CRYSOUND_LLM_BASE || process.env.DEEPSEEK_BASE_URL");
    assert.match(after, /baseURL: !!js process.env.CRYSOUND_LLM_BASE \|\| process.env.DEEPSEEK_BASE_URL/);
    assert.equal(search.config.model, "deepseek/deepseek-flash");
    if (baseURL !== undefined) {
      assert.equal(search.config.maxResults, 3);
      assert.equal(search.disabled, true);
    }
    refreshProfile(file, seed, yaml);
    assert.equal(await readFile(file, "utf8"), after, "second run is byte-identical");
  }
});

test("work-step display defaults to standard and keeps a chosen value", async (t) => {
  const root = await temp(t), seed = join(assets, "config/partner.patch.yml");
  const scenarios = [
    [undefined, "standard"],
    ["- id: ui-sidebar-terminal\n  disabled: true\n", "standard"],
    ["- id: ui-chat\n  name: '@deepseek-ai/dsh-client-ui-chat'\n  config:\n    foldedReplies: final\n", "standard"],
    ["- id: ui-chat\n  config:\n    transcriptView: detailed\n", "detailed"],
    ["- id: ui-chat\n  config:\n    transcriptView: compact\n", "compact"],
  ];
  for (const [index, [before, expected]] of scenarios.entries()) {
    const file = join(root, `chat-${index}.yml`);
    if (before !== undefined) await writeFile(file, before);
    refreshProfile(file, seed, yaml, before === undefined);
    const after = await readFile(file, "utf8"), rows = load(after);
    const chat = rows.filter(row => row.id === "ui-chat");
    assert.equal(chat.length, 1, `scenario ${index} keeps one ui-chat entry`);
    assert.equal(chat[0].config.transcriptView, expected, `scenario ${index}`);
    if (index === 2) assert.equal(chat[0].config.foldedReplies, "final");
    refreshProfile(file, seed, yaml);
    assert.equal(await readFile(file, "utf8"), after, "second refresh is byte-identical");
  }
});
