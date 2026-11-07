// Company plugin policy is applied while the profile Host is stopped.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Retire the configured third-party dependencies once, keeping all user files and other plugins.
 * Refresh the official package list used by the Host to refuse uninstall without preventing disable.
 * A failed removal leaves the migration unmarked so the next update retries it.
 * @param {string} profile Profile directory.
 * @param {object} config Shared plugins.json contents.
 * @param {(names: string[]) => void} remove Native `dsh plugin remove` adapter; must throw on failure.
 * @returns {void}
 */
export function preparePluginPolicy(profile, config, remove) {
  const file = path.join(profile, "package.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const save = (manifest) => {
    const next = JSON.stringify(manifest, null, 2) + "\n";
    if (fs.readFileSync(file, "utf8") === next) return;
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(`${file}.company-tmp`, next, { mode });
    fs.chmodSync(`${file}.company-tmp`, mode);
    fs.renameSync(`${file}.company-tmp`, file);
  };
  let manifest = read();
  const retired = config.retire;
  if (retired && (typeof retired.id !== "string" || !/^[a-z0-9-]+$/.test(retired.id) || !Array.isArray(retired.packages) || retired.packages.some((name) => !/^[a-z0-9][a-z0-9._-]*$/.test(name)))) throw new Error("公司插件迁移配置无效");
  const names = Object.keys(config.officialPlugins ?? {});
  if (names.some((name) => !/^@crysound\/[a-z0-9][a-z0-9._~-]*$/.test(name))) throw new Error("官方包名无效");
  ((manifest.dsh ??= {}).company ??= {}).officialPackages = names;
  save(manifest);
  const mark = retired && path.join(profile, `.zp-retired-${retired.id}`);
  if (mark && !fs.existsSync(mark)) {
    const names = retired.packages.filter((name) => Object.hasOwn(manifest.dependencies ?? {}, name));
    if (names.length) remove(names);
    manifest = read();
    if (retired.packages.some((name) => Object.hasOwn(manifest.dependencies ?? {}, name))) throw new Error("旧预装插件尚未移出，将在下次更新重试");
    // Native remove reconciles selections. Also remove selection-only remnants from interrupted older installs.
    const bundles = manifest.dsh?.profile?.bundles;
    if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => !retired.packages.includes(name));
    save(manifest);
    fs.writeFileSync(mark, "", { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [profile, configFile, cliEntry, profileName] = process.argv.slice(2);
  if (!profile || !configFile || !cliEntry || !["web", "desktop"].includes(profileName)) throw new Error("用法：company-plugins.mjs <profile> <plugins.json> <dsh CLI> <web|desktop>");
  preparePluginPolicy(profile, JSON.parse(fs.readFileSync(configFile, "utf8")), (names) => {
    const result = spawnSync(process.execPath, ["--expose-internals", cliEntry, "plugin", "--profile", profileName, "remove", ...names], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("旧预装插件移出失败，将在下次更新重试", { cause: result.error });
  });
}
