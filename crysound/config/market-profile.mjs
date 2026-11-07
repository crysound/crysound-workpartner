// 给旧 profile 补市场源；已有 indexes 保持用户设置，bundle 只默认启用一次。
import fs from "node:fs";
import path from "node:path";

const [patch, manifestFile, index] = process.argv.slice(2);
if (!patch || !manifestFile || !/^https?:\/\//.test(index)) throw new Error("用法：market-profile.mjs <patch> <package.json> <index URL>");
function updateProfile() {
  let text = fs.existsSync(patch) ? fs.readFileSync(patch, "utf8") : "";
  text = text.replaceAll("https://partner.invalid/_zp/market/index.json", index);
  const lines = text.replace(/^\[\]\s*$/m, "").split("\n");
  if (lines.some((line) => line.trim() && !/^\s/.test(line) && !line.startsWith("#") && !/^- (?:id: ["']?[^\s"',{}]+["']?|insert:)\s*(?:#.*)?$/.test(line))) {
    console.warn("警告：市场 profile 使用不支持的 YAML 写法，已跳过；请在设置页手工添加公司索引和市场 bundle");
    return;
  }
  const start = lines.findIndex((line) => /^- id: ["']?plugin-market["']?\s*(?:#.*)?$/.test(line));
  if (start < 0) {
    lines.push("- id: plugin-market", "  config:", "    indexes:", `      - ${index}`);
  } else {
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith("- ")) end++;
    const row = lines.slice(start, end);
    if (!row.some((line) => /^    indexes\s*:/.test(line))) {
      const config = row.findIndex((line) => /^  config\s*:/.test(line));
      if (config < 0) lines.splice(start + 1, 0, "  config:", "    indexes:", `      - ${index}`);
      else {
        if (!/^  config:\s*(?:\{\})?\s*(?:#.*)?$/.test(row[config])) {
          console.warn("警告：市场 config 使用行内 YAML，已跳过；请在设置页手工添加公司索引和市场 bundle");
          return;
        }
        lines[start + config] = "  config:";
        lines.splice(start + config + 1, 0, "    indexes:", `      - ${index}`);
      }
    }
  }
  const mark = path.join(path.dirname(manifestFile), ".zp-market-v1");
  const manifest = fs.existsSync(mark) ? null : JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const next = lines.join("\n").replace(/\n*$/, "\n");
  if (!fs.existsSync(patch) || next !== fs.readFileSync(patch, "utf8")) {
    fs.writeFileSync(`${patch}.tmp`, next, { mode: 0o600 });
    fs.renameSync(`${patch}.tmp`, patch);
  }
  if (manifest) {
    const bundles = ((manifest.dsh ??= {}).profile ??= {}).bundles ??= [];
    const bundle = "@deepseek-ai/dsh-experimental-plugin-market-bundle";
    if (!bundles.includes(bundle)) {
      bundles.push(bundle);
      fs.writeFileSync(`${manifestFile}.tmp`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(`${manifestFile}.tmp`, manifestFile);
    }
    fs.writeFileSync(mark, "", { mode: 0o600 });
  }
}

try { updateProfile(); } catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  console.warn("警告：市场 profile 配置无法解析，已跳过；请在设置页手工添加公司索引和市场 bundle");
}
