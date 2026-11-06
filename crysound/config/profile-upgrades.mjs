// Refresh company model and search settings while the Host is stopped. Other providers and !!js expressions stay in the YAML document.
// node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed]
import fs from "node:fs";
import { createRequire } from "node:module";

export function refreshProfile(file, seedFile, yaml, seedDefaults = false) {
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

  // Preserve the search migration without replacing the user's existing search setup.
  const searchIndex = find(seed, "web-search-deepseek");
  if (searchIndex >= 0 && find(mine, "web-search-deepseek") < 0) mine.add(seed.contents.items[searchIndex].clone());

  // Historical default migration: leave the user's chosen model/effort alone.
  const defaultIndex = find(mine, "agent-default-model");
  const defaults = mine.getIn([defaultIndex, "config"], true);
  if (yaml.isMap(defaults) && defaults.get("provider") === "magpie"
    && /^codex\/gpt-6\.1(?:-|$)/u.test(String(defaults.get("model"))) && !defaults.has("reasoningEffort")) {
    defaults.set("reasoningEffort", "medium");
  }
  const after = String(mine);
  if (before !== after) {
    fs.writeFileSync(`${file}.tmp`, after, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
}

if (import.meta.main) {
  const [file, seed, cliEntry, flag] = process.argv.slice(2);
  if (!file || !seed || !cliEntry) throw new Error("用法：node profile-upgrades.mjs <profile patch> <company patch> <dsh CLI entry> [--seed]");
  // Follow exported package manifests so both source checkouts and packaged dependency trees work without loading lib outputs.
  let require = createRequire(cliEntry);
  for (const name of ["@deepseek-ai/dsh/package.json", "@deepseek-ai/dsh-base/package.json", "@deepseek-ai/dsh-config-editor/package.json"]) require = createRequire(require.resolve(name));
  refreshProfile(file, seed, require("yaml"), flag === "--seed");
}
