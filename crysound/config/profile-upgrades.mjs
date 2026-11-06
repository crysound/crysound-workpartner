// 已开通用户的配置升级：默认配置只在首次开通时写入，之后公司默认值变了，靠这里把仍是旧默认值的条目改成新值。
// 只改与旧默认值逐字相同的块，用户自己改过的不动；可重复执行。网页版入口脚本与桌面版启动时都会运行。
// 用法：node profile-upgrades.mjs <cordis.patch.yml>
import fs from "node:fs";

// GPT-6.1 的推理等级与 magpie 公布的一一对应（low、medium、high、xhigh、max）；dsh 没有 ultra 档。
function gptReasoningLevels(lines) {
  let model = "";
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const id = /^\s*- id: (\S+)/.exec(lines[i]);
    if (id) model = id[1];
    if (!model.startsWith("codex/gpt-6.1") || !/^\s*reasoningEfforts:\s*$/.test(lines[i])) continue;
    const pad = /^(\s*)/.exec(lines[i + 1] ?? "")[1];
    const old = [`${pad}low: low`, `${pad}medium: medium`, `${pad}high: high`];
    const next = lines[i + 4] ?? "";
    const sameLevel = next.startsWith(pad) && /^\w/.test(next.slice(pad.length));
    if (old.every((line, k) => lines[i + 1 + k] === line) && !sameLevel) {
      lines.splice(i + 4, 0, `${pad}xhigh: xhigh`, `${pad}max: max`);
      changed = true;
    }
  }
  return changed;
}

// 默认推理等级为中：只改仍用公司默认 GPT、且没选过等级的同事。
function defaultEffortMedium(lines) {
  const start = lines.findIndex((line) => /^- id: agent-default-model\s*$/.test(line));
  if (start < 0) return false;
  let end = start + 1;
  while (end < lines.length && !/^(- |#)/.test(lines[end])) end++;
  const row = lines.slice(start, end);
  const model = row.findIndex((line) => /^\s+model: codex\/gpt-6\.1/.test(line));
  if (model < 0 || !row.some((line) => /^\s+provider: magpie\s*$/.test(line)) || row.some((line) => /^\s+reasoningEffort:/.test(line))) return false;
  lines.splice(start + model + 1, 0, `${/^(\s*)/.exec(row[model])[1]}reasoningEffort: medium`);
  return true;
}

const file = process.argv[2];
if (!file) throw new Error("用法：node profile-upgrades.mjs <cordis.patch.yml>");
if (fs.existsSync(file)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const levels = gptReasoningLevels(lines);
  const effort = defaultEffortMedium(lines);
  if (levels || effort) {
    fs.writeFileSync(`${file}.tmp`, lines.join("\n"), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    console.log(`配置升级：${[levels && "GPT-6.1 推理等级补到 xhigh、max", effort && "默认推理等级设为中"].filter(Boolean).join("；")}`);
  }
}
