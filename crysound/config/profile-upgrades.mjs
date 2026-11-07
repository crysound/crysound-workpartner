// Refresh company model, search, tool guidance, Sidebar Browser and work-step display settings while the Host is stopped. Other providers and !!js expressions stay in the YAML document.
// node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed] [--web-preview]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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
  for (const key of ["searchTimeoutMs", "fetchMaxOutputChars", "fetchSummary", "fetchSummaryModel", "fetchSummaryBaseURL", "fetchSummaryTimeoutMs", "fetchSummaryMaxTokens", "fetchSummaryMinChars", "fetchOpen", "fetchOpenModel", "fetchDirectTimeoutMs", "fetchOpenTimeoutMs", "fetchTotalTimeoutMs", "fetchDeepSeek", "fetchDeepSeekTimeoutMs", "fetchDeepSeekMinChars"]) {
    mine.setIn([...toolPath, key], toolConfig.get(key, true).clone());
  }

  // Existing Web profiles need the same Browser opt-in; desktop choices stay personal.
  if (enableWebBrowser) {
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

if (import.meta.main) {
  const [file, seed, cliEntry, ...flags] = process.argv.slice(2);
  if (!file || !seed || !cliEntry) throw new Error("用法：node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed] [--web-preview]");
  if (flags.some((flag) => !["--seed", "--web-preview"].includes(flag))) throw new Error("未知配置刷新选项");
  // Follow exported package manifests so both source checkouts and packaged dependency trees work without loading lib outputs.
  let require = createRequire(cliEntry);
  for (const name of ["@deepseek-ai/dsh/package.json", "@deepseek-ai/dsh-base/package.json", "@deepseek-ai/dsh-config-editor/package.json"]) require = createRequire(require.resolve(name));
  refreshProfile(file, seed, require("yaml"), flags.includes("--seed"), flags.includes("--web-preview"));
}
