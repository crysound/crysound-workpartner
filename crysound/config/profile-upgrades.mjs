// Refresh company model, search, tool guidance and display defaults while the Host is stopped. Other providers and !!js expressions stay in the YAML document.
// node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed] [--web-preview]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TOOL_EFFICIENCY_GUIDANCE = `Use tools efficiently while preserving correctness and the user's permission boundaries. The following company deployment exceptions replace the single-file read/search tool preferences above for multi-file inspection and small scripts; all permission and sandbox rules still apply.
- When inspecting several text files in the shell's workspace, prefer one bounded shell command or an available batch-read tool over separate read calls for every file. A single command can discover paths, read relevant content and calculate an aggregate. Use rg with context or combine bounded file ranges with path headings; cap total output. Do not first list paths and then read every file separately. If grep already returned sufficient evidence, use it without rereading every match. If truncated or ambiguous, fetch the missing relevant portions before drawing conclusions. Use the original readers when shell access is unavailable, the files belong to a different execution environment, or a specialized reader is needed (such as images); never bypass access restrictions.
- For a small script whose contents and execution are already authorized, prefer one shell call that writes the script and then runs it only if writing succeeds (for example, a quoted heredoc followed by && python3 script.py). Do not split a new script into a write tool call and a later execution call. Inspect input when needed, then combine writing and running. Check the actual output in that call. Quote paths and heredoc delimiters so user data is not expanded as shell code. Keep separate steps when intermediate inspection, approval, or a previous result is required; inspect existing files before changing them and prefer targeted edits.
- If you intend to call multiple tools and their inputs do not depend on each other's results, make those independent calls in the same response so they can run in parallel. Do not serialize independent work or combine operations that depend on each other, race on shared state, or require separate approval.
- For web research, stop searching and fetching once the evidence is sufficient to answer the user's question; fetch only pages needed to fill a specific evidence gap and meet any requested source count. If the search answer or source summaries already answer the question, answer directly with the available source links without web_fetch. Supply web_fetch's optional prompt with the specific question or evidence needed so it can return a focused summary.
- If a webpage cannot be read (403, login required, or anti-bot restrictions), use another source; do not write scripts, curl commands, or other workarounds to bypass those restrictions.`;

export function refreshProfile(file, seedFile, yaml, seedDefaults = false, enableWebBrowser = false) {
  const parse = (text) => {
    const document = yaml.parseDocument(text, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
    });
    if (document.errors.length) throw document.errors[0];
    if (!yaml.isSeq(document.contents)) throw new Error("公司配置和个人配置必须是 YAML 条目列表");
    document.contents.flow = false;
    return document;
  };
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "[]\n";
  const mine = parse(before);
  const seed = parse(fs.readFileSync(seedFile, "utf8"));
  const find = (document, id) => document.contents.items.findLastIndex((item) => yaml.isMap(item) && item.get("id") === id && !item.has("insert"));
  if (seedDefaults) {
    for (const entry of seed.contents.items) {
      if (!yaml.isMap(entry) || typeof entry.get("id") !== "string") throw new Error("公司配置缺少条目 id");
      if (find(mine, entry.get("id")) < 0) mine.add(entry.clone());
    }
  }
  const companyIndex = find(seed, "llm-pi-ai");
  const provider = seed.getIn([companyIndex, "config", "providers", "magpie"], true);
  if (!yaml.isMap(provider)) throw new Error("公司配置缺少 magpie 提供方");
  let index = find(mine, "llm-pi-ai");
  if (index < 0) {
    mine.add(mine.createNode({ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: {} } }));
    index = mine.contents.items.length - 1;
  }
  // A dynamic providers expression cannot be safely edited without evaluating user code.
  for (const path of [[index, "config"], [index, "config", "providers"]]) {
    const value = mine.getIn(path, true);
    if (value === undefined) mine.setIn(path, mine.createNode({}));
    else if (!yaml.isMap(value)) throw new Error("个人模型配置使用了动态表达式，无法安全刷新公司提供方；请把 providers 改为映射");
  }
  mine.setIn([index, "config", "providers", "magpie"], provider.clone());

  // Search uses the same company gateway on both web and desktop, including existing literal addresses.
  const searchIndex = find(seed, "web-search-deepseek");
  const searchConfig = seed.getIn([searchIndex, "config"], true);
  if (!yaml.isMap(searchConfig) || !searchConfig.has("baseURL") || !searchConfig.has("model")) throw new Error("公司配置缺少网页搜索地址或模型");
  const personalSearchIndex = find(mine, "web-search-deepseek");
  if (personalSearchIndex < 0) {
    mine.add(seed.contents.items[searchIndex].clone());
  } else {
    const path = [personalSearchIndex, "config"];
    const config = mine.getIn(path, true);
    if (config === undefined) mine.setIn(path, mine.createNode({}));
    else if (!yaml.isMap(config)) throw new Error("个人网页搜索配置使用了动态表达式，无法安全刷新公司地址和模型；请把 config 改为映射");
    for (const key of ["baseURL", "model"]) mine.setIn([...path, key], searchConfig.get(key, true).clone());
  }

  // Refresh company web-tool limits for existing profiles while retaining other tool options.
  const toolIndex = find(seed, "tool-web");
  const toolConfig = seed.getIn([toolIndex, "config"], true);
  if (!yaml.isMap(toolConfig)) throw new Error("公司配置缺少网页工具上限");
  let personalToolIndex = find(mine, "tool-web");
  if (personalToolIndex < 0) {
    mine.add(seed.contents.items[toolIndex].clone());
    personalToolIndex = mine.contents.items.length - 1;
  }
  const toolPath = [personalToolIndex, "config"];
  const personalToolConfig = mine.getIn(toolPath, true);
  if (personalToolConfig === undefined) mine.setIn(toolPath, mine.createNode({}));
  else if (!yaml.isMap(personalToolConfig)) throw new Error("个人网页工具配置使用了动态表达式，无法安全刷新公司上限；请把 config 改为映射");
  for (const key of ["fetchOpen", "fetchOpenModel", "fetchOpenTimeoutMs"]) mine.deleteIn([...toolPath, key]);
  for (const key of ["searchTimeoutMs", "fetchMaxOutputChars", "fetchSummary", "fetchSummaryModel", "fetchSummaryBaseURL", "fetchSummaryTimeoutMs", "fetchSummaryMaxTokens", "fetchSummaryMinChars", "fetchTreg", "fetchDirectTimeoutMs", "fetchTregTimeoutMs", "fetchTotalTimeoutMs", "fetchDeepSeek", "fetchDeepSeekTimeoutMs", "fetchDeepSeekMinChars"]) {
    mine.setIn([...toolPath, key], toolConfig.get(key, true).clone());
  }

  // Web deployment grants memory management and enables Browser; desktop choices stay personal.
  if (enableWebBrowser) {
    // The authenticated gateway is the only route into each person's Web Host.
    let memoryIndex = find(mine, "mnemon");
    if (memoryIndex < 0) {
      mine.add(mine.createNode({ id: "mnemon", config: {} }));
      memoryIndex = mine.contents.items.length - 1;
    }
    const memoryPath = [memoryIndex, "config"];
    const memory = mine.getIn(memoryPath, true);
    if (memory === undefined) mine.setIn(memoryPath, mine.createNode({}));
    else if (!yaml.isMap(memory)) throw new Error("个人记忆配置使用了动态表达式，无法安全设置网页访问；请把 config 改为映射");
    mine.setIn([...memoryPath, "remoteAccess"], "trusted-host");

    const browserIndex = find(mine, "ui-sidebar-browser");
    if (browserIndex < 0) {
      const companyBrowser = find(seed, "ui-sidebar-browser");
      if (companyBrowser < 0) throw new Error("公司配置缺少侧栏浏览器启用项");
      mine.add(seed.contents.items[companyBrowser].clone());
    } else {
      mine.contents.items[browserIndex].set("disabled", mine.createNode(false));
    }
  }

  // Historical default migration: leave the user's chosen model/effort alone.
  const defaultIndex = find(mine, "agent-default-model");
  const defaults = mine.getIn([defaultIndex, "config"], true);
  if (yaml.isMap(defaults) && defaults.get("provider") === "magpie"
    && /^codex\/gpt-6\.1(?:-|$)/u.test(String(defaults.get("model"))) && !defaults.has("reasoningEffort")) {
    defaults.set("reasoningEffort", "medium");
  }
  // Company default for the work-step display; a value the user already chose stays.
  let chatIndex = find(mine, "ui-chat");
  if (chatIndex < 0) {
    mine.add(mine.createNode({ id: "ui-chat", name: "@deepseek-ai/dsh-client-ui-chat", config: {} }));
    chatIndex = mine.contents.items.length - 1;
  }
  const chat = mine.getIn([chatIndex, "config"], true);
  if (chat === undefined) mine.setIn([chatIndex, "config"], mine.createNode({ transcriptView: "standard" }));
  else if (yaml.isMap(chat) && !chat.has("transcriptView")) chat.set("transcriptView", "standard");
  // Only the Web entrypoint passes --web-preview. Settings writes use the same
  // profile fields, so absence (not equality to an old default) controls seeding.
  if (enableWebBrowser) {
    for (const [id, field, value] of [["ui-conversation", "busyEnter", "steer"], ["ui-chat", "performanceUsage", "compact"]]) {
      let index = find(mine, id);
      if (index < 0) {
        mine.add(mine.createNode({ id, name: `@deepseek-ai/dsh-client-${id}`, config: {} }));
        index = mine.contents.items.length - 1;
      }
      const configPath = [index, "config"];
      if (mine.getIn(configPath, true) === undefined) mine.setIn(configPath, mine.createNode({}));
      const config = mine.getIn(configPath, true);
      if (yaml.isMap(config) && !config.has(field)) config.set(field, value);
    }
  }
  // Generate a self-contained module from the existing config download: older desktop
  // clients do not know about extra configuration files. A distinct section survives
  // standard preset persona replacement; complete-prompt presets keep their own prompt.
  const guidance = `// Managed by company profile upgrades.
export const name = "crysound-tool-efficiency";
export const inject = ["systemPrompt"];
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: "crysound:tool-efficiency",
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
    interpolate: false,
    text: ${JSON.stringify(TOOL_EFFICIENCY_GUIDANCE)},
  }));
}
`;
  const guidanceFile = path.join(path.dirname(file), "crysound-tool-efficiency.mjs");
  const inserted = mine.contents.items.some((item) => {
    const entries = yaml.isMap(item) && item.get("insert", true);
    return yaml.isSeq(entries) && entries.items.some((entry) => yaml.isMap(entry) && entry.get("id") === "crysound-tool-efficiency");
  });
  if (!inserted) mine.add(mine.createNode({ insert: [{ id: "crysound-tool-efficiency", name: "./crysound-tool-efficiency.mjs" }] }));
  const after = String(mine);
  if (!fs.existsSync(guidanceFile) || fs.readFileSync(guidanceFile, "utf8") !== guidance) {
    fs.writeFileSync(`${guidanceFile}.tmp`, guidance, { mode: 0o600 });
    fs.renameSync(`${guidanceFile}.tmp`, guidanceFile);
  }
  if (before !== after) {
    fs.writeFileSync(`${file}.tmp`, after, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
}

/**
 * Seed a Native store before the Web Host starts; its Source discovers and activates the first store.
 * @param {string} file Personal profile patch, with plugin dependencies installed beside it.
 * @param {object} yaml DSH's YAML parser.
 * @param {NodeJS.ProcessEnv} environment Host environment, including the default memory root and CLI PATH.
 * @returns {Promise<void>} Leaves personal scopes and existing stores intact; throws on failed initialization.
 */
export async function initializeWebMemory(file, yaml, environment = process.env) {
  const profile = path.dirname(file);
  const marker = path.join(profile, ".zp-personal-memory-v1");
  if (fs.existsSync(marker)) return;
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"));
  if (!manifest.dsh?.profile?.bundles?.includes("dsh-mnemon")) return;
  const document = yaml.parseDocument(fs.readFileSync(file, "utf8"), {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }],
  });
  if (document.errors.length) throw document.errors[0];
  if (!yaml.isSeq(document.contents)) throw new Error("个人配置必须是 YAML 条目列表");
  let command = "mnemon";
  for (const row of document.contents.items) {
    if (!yaml.isMap(row) || !["mnemon", "mnemon-source-memory-spaces"].includes(row.get("id"))) continue;
    if (row.has("disabled") && row.get("disabled", true)?.value !== false) return;
    const config = row.get("config", true);
    if (config === undefined) continue;
    if (!yaml.isMap(config)) return;
    // Personal scopes and expressions are resolved by the plugin, never guessed during offline startup.
    if (["dataDir", "customPackId", "customPacks", "store", "providers"].some(key => config.has(key))) return;
    const scope = config.get("storageScope", true);
    if (scope !== undefined && (scope.tag || scope.value !== "global")) return;
    if (config.has("writeEnabled") && config.get("writeEnabled", true)?.value !== true) return;
    if (config.has("cliPath")) {
      const cli = config.get("cliPath", true);
      if (cli.tag || typeof cli.value !== "string" || !cli.value.trim()) return;
      command = cli.value;
    }
  }
  const root = environment.MNEMON_DATA_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error("网页记忆目录必须是绝对路径");
  const requirePlugin = createRequire(createRequire(path.join(profile, "package.json")).resolve("dsh-mnemon/package.json"));
  const contracts = await import(pathToFileURL(requirePlugin.resolve("dsh-mnemon-source-memory-spaces/contracts")).href);
  const data = path.join(root, contracts.MEMORY_SPACES_DIRECTORY);
  const registries = [
    [path.join(data, contracts.MEMORY_SPACE_REGISTRY_FILE), contracts.summarizeMemorySpaceRegistry, [1]],
    [path.join(root, "state", contracts.MEMORY_PROVIDER_REGISTRY_FILE), contracts.summarizeMemoryProviderRegistry, [1, 2, 3, 4]],
  ];
  for (const [registry, summarize, versions] of registries) {
    if (!fs.existsSync(registry)) continue;
    const stored = JSON.parse(fs.readFileSync(registry, "utf8"));
    const summary = summarize(stored);
    if (!summary.valid || !versions.includes(stored.version) || !Array.isArray(stored.bodies)) throw new Error("已有记忆空间目录无法识别，未创建默认空间");
    if (stored.bodies.length > 0) {
      fs.writeFileSync(marker, "existing\n", { mode: 0o600 });
      return;
    }
  }
  // Any existing store or incomplete directory belongs to its owner; do not replace it.
  if (fs.existsSync(data) && fs.readdirSync(data, { withFileTypes: true }).some(entry => entry.isDirectory() || entry.isSymbolicLink())) {
    fs.writeFileSync(marker, "existing\n", { mode: 0o600 });
    return;
  }
  execFileSync(command, ["--data-dir", root, "store", "create", "personal"], {
    env: environment, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (!fs.existsSync(path.join(data, "personal", contracts.MEMORY_SPACE_DATABASE_FILE))) throw new Error("默认记忆空间未生成数据库");
  fs.writeFileSync(marker, "created\n", { mode: 0o600 });
}

if (import.meta.main) {
  const [file, seed, cliEntry, ...flags] = process.argv.slice(2);
  if (!file || !seed || !cliEntry) throw new Error("用法：node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed] [--web-preview]");
  if (flags.some((flag) => !["--seed", "--web-preview"].includes(flag))) throw new Error("未知配置刷新选项");
  // Follow exported package manifests so both source checkouts and packaged dependency trees work without loading lib outputs.
  let require = createRequire(cliEntry);
  for (const name of ["@deepseek-ai/dsh/package.json", "@deepseek-ai/dsh-base/package.json", "@deepseek-ai/dsh-config-editor/package.json"]) require = createRequire(require.resolve(name));
  const yaml = require("yaml");
  refreshProfile(file, seed, yaml, flags.includes("--seed"), flags.includes("--web-preview"));
  if (flags.includes("--web-preview")) {
    try { await initializeWebMemory(file, yaml); }
    catch (error) { console.error("警告：默认记忆空间初始化未完成，下次启动重试；记忆空间尚未验收：", error.message); }
  }
}
