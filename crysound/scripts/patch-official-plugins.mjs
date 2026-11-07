// Keep the native manager's enable/disable behavior; protect company official dependencies from removal.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Protect official dependencies from user removal while preserving native updates and rollback.
 * @param {string} text Published dsh-plugin-manager 0.2.2-rc.1 lib/index.js.
 * @returns {string} Idempotently patched module; a changed upstream expression fails before writing.
 */
export function patchOfficialPlugins(text) {
  const marker = "/* CRYSOUND official removal policy v2 */";
  if (text.includes(marker)) return text;
  const replace = (before, after, count = 1) => {
    if (text.split(before).length !== count + 1) throw new Error("官方插件保护补丁未唯一命中，请核对 dsh 版本");
    text = text.replaceAll(before, after);
  };
  const needle = "const removable = owned || enabled && !installed && !shipped;";
  const protectedInventory = "const removable = !manifest.dsh?.company?.officialPackages?.includes(name) && (owned || enabled && !installed && !shipped);";
  if (text.includes("/* CRYSOUND official removal policy v1 */")) {
    replace("/* CRYSOUND official removal policy v1 */\n", "");
    replace(protectedInventory, needle);
  }
  replace(needle, protectedInventory);
  // Remote removeBundle never accepts an override. Only the native update path can replace a bundle.
  replace("removeBundle(name) {", "removeBundle(name) {\n\t\t\treturn this.#removeBundle(name, false);\n\t\t}\n\t\t#removeBundle(name, replacing) {");
  replace('if (bundle === void 0 || !bundle.removable) throw new ManagementFailure("not-removable");',
    'if (bundle === void 0 || (!bundle.removable && !(replacing && typeof updateRefusal(bundle, name) !== "string"))) throw new ManagementFailure("not-removable");');
  replace("this.removeBundle(name)", "this.#removeBundle(name, true)", 2);
  return marker + "\n" + text;
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
