import { prepareNativeProfile } from "./native-profile.mjs";
// 可重复的本机准备：命令脚本和不含凭据的配置；公司技能版本目录只读，不覆盖个人文件。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Extract the pinned, bundled official skills once, publishing the directory before making its root read-only.
 * @param parent Company-managed directory outside personal skills and AGENTS.md.
 * @returns Versioned read-only skill root.
 */
export function prepareSkills(parent) {
  const source = fileURLToPath(new URL("./official-skills.tar.gz", import.meta.url));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const target = path.join(parent, `feishu-skills-${hash.slice(0, 16)}`);
  if (fs.existsSync(path.join(target, ".complete"))) return target;
  fs.mkdirSync(parent, { recursive: true });
  const temp = `${target}.${crypto.randomBytes(12).toString("hex")}`;
  fs.mkdirSync(temp);
  let directory = temp;
  try {
    const r = spawnSync("tar", ["-xzf", source, "-C", temp], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("无法展开公司飞书技能，请检查系统 tar 命令");
    fs.writeFileSync(path.join(temp, ".complete"), hash, { mode: 0o444 });
    for (const entry of fs.readdirSync(temp, { recursive: true, withFileTypes: true }).reverse()) fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o555 : 0o444);
    // macOS needs the directory itself writable while updating its parent link.
    fs.renameSync(temp, target);
    directory = target;
    fs.chmodSync(target, 0o555);
  } catch (error) {
    // 清理本次创建的目录（可能已经移动）；Windows 删除前还需恢复文件写权限。
    if (fs.existsSync(directory)) {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isSymbolicLink()) fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
  return target;
}

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
/** Write wrappers using the shipped Node/Electron runtime; identityFile references an existing login file.
 * @param config Paths, execution mode, endpoints and project host; no OAuth credentials are copied.
 * @param configFile Company wrapper configuration target (600).
 */
export function prepareWrappers(config, configFile) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(config.bin, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  for (const name of ["lark-cli", "meegle"]) {
    fs.writeFileSync(path.join(config.bin, name), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(config.execPath)} ${quote(cli)} ${quote(name)} ${quote(configFile)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(path.join(config.bin, name), 0o755);
    // Windows' shell reads a fixed command followed by its original argument tail.
    if (process.platform === "win32") fs.writeFileSync(path.join(config.bin, `${name}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${config.execPath}" "${cli}" "${name}" "${configFile}" %*\r\n`, { mode: 0o755 });
  }
}

/** Add an independent company skill provider, preserving the user's existing patch and default roots.
 * @param patch Existing profile patch path; only the company provider row is owned here.
 */
export function prepareSkillProfile(patch) {
  prepareNativeProfile(patch);
  const initial = fs.existsSync(patch) ? fs.readFileSync(patch, "utf8") : "[]\n";
  if (/^- id: ['"]?company-feishu-skills['"]?\s*$/m.test(initial)) return;
  const text = initial.replace(/^\[\]\s*$/m, "").replace(/\n*$/, "\n") + `\n- id: company-feishu-skills\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    providerName: company-feishu\n    includeDefaultRoots: false\n    watch: false\n    customSkillDirs: !!js '[process.env.CRYSOUND_COMPANY_SKILLS]'\n`;
  const temp = `${patch}.feishu.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, patch);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const skills = prepareSkills("/opt/partner/company");
  prepareWrappers({ kind: "container", bin: "/usr/local/bin", realBin: "/opt/partner-clis/bin", execPath: process.execPath,
    identityFile: "/data/.zp-market-token", tokenUrl: "http://zhaohua-partner-gateway:3091/token", authorizationUrl: "https://partner.invalid/_zp/feishu/", meegleHost: "" }, "/opt/partner/feishu.json");
  console.log(skills);
}
