// Keep the native manager's enable/disable behavior; protect company official dependencies from removal.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Patch the pinned Host inventory so listBundles and removeBundle use the same official-package policy.
 * @param {string} text Published dsh-plugin-manager 0.2.2-rc.1 lib/index.js.
 * @returns {string} Idempotently patched module; a changed upstream expression fails before writing.
 */
export function patchOfficialPlugins(text) {
  const marker = "/* CRYSOUND official removal policy v1 */";
  if (text.includes(marker)) return text;
  const needle = "const removable = owned || enabled && !installed && !shipped;";
  if (text.split(needle).length !== 2) throw new Error("官方插件保护补丁未唯一命中，请核对 dsh 版本");
  return marker + "\n" + text.replace(needle, "const removable = !manifest.dsh?.company?.officialPackages?.includes(name) && (owned || enabled && !installed && !shipped);");
}

/**
 * Patch the runtime copy, preserving mode and breaking any pnpm hardlink.
 * @param {string} root Runtime node_modules directory.
 * @returns {void}
 */
export function patchOfficialPluginsRuntime(root) {
  const file = path.join(root, "@deepseek-ai/dsh-plugin-manager/lib/index.js");
  const before = fs.readFileSync(file, "utf8"), next = patchOfficialPlugins(before);
  if (before === next) return;
  const mode = fs.statSync(file).mode;
  fs.unlinkSync(file);
  fs.writeFileSync(file, next, { mode });
  fs.chmodSync(file, mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) patchOfficialPluginsRuntime(process.argv[2]);
