// Web image only: keep the user's explicit default and the upstream desktop runtime intact.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function transform(text, kind, edits) {
  const marker = `/* CRYSOUND web auto review ${kind} v1 */`;
  if (text.includes(marker)) return text;
  for (const [needle, replacement] of edits) {
    if (text.split(needle).length !== 2) throw new Error(`Web auto review ${kind}: patch did not match exactly once`);
    text = text.replace(needle, () => replacement);
  }
  return marker + '\n' + text;
}

/** Patch the pinned Host module: absent personal defaults use Auto, with safe admission fallback. */
export function patchPermissionHost(text) {
  return transform(text, 'host', [
    ['\t\t\tconst inferredDefault = this.derive(EMPTY_KNOBS);\n', ''],
    ['const defaultPreset = config.defaultPreset.get() ?? inferredDefault;\n\t\t\tif (defaultPreset',
      'const defaultPreset = config.defaultPreset.get() ?? AUTO_PRESET;\n\t\t\tif (defaultPreset'],
    ['this.resolve(defaultPreset);', 'if (defaultPreset !== AUTO_PRESET) this.resolve(defaultPreset);'],
    ['const defaultPreset = config.defaultPreset.get() ?? inferredDefault;\n\t\t\t\tif (!Object.hasOwn(this.presets, defaultPreset))',
      'const defaultPreset = config.defaultPreset.get() ?? AUTO_PRESET;\n\t\t\t\tif (defaultPreset !== AUTO_PRESET && !Object.hasOwn(this.presets, defaultPreset))'],
    ['defaultOptions: Object.keys(this.presets).map((name) => this.optionOf(name)),',
      'defaultOptions: [...Object.keys(this.presets).map((name) => this.optionOf(name)), { value: AUTO_PRESET, name: AUTO_PRESET }],'],
    ['if (this.autoAdmit === void 0) throw new Error("permission: cannot restore preset \\"auto\\" without its active integration");\n\t\t\t\tthis.autoAdmit();',
      'if (!this.admitWebAuto()) { this.fallbackWebPermission(session); return; }'],
    ['const name = this.defaultPreset;\n\t\t\t\tconst spec = this.resolve(name);',
      'const name = this.defaultPreset;\n\t\t\t\tif (name === AUTO_PRESET && !this.admitWebAuto()) { this.fallbackWebPermission(session); return; }\n\t\t\t\tconst spec = this.resolve(name);'],
    ['\n\t\t/** Publish a non-vetoing payload-free catalog invalidation. */', `
        admitWebAuto() {
          if (this.autoAdmit === void 0) return false;
          try { this.autoAdmit(); return true; }
          catch (error) { this.ctx.logger.warn("Auto review unavailable; using workspace-write: " + String(error)); return false; }
        }
        fallbackWebPermission(session) {
          session.append("permission/preset", { preset: "workspace-write" });
          setSandboxMode(session, "workspace-write");
          setApprovalPolicy(session, "ask");
        }
\t\t/** Publish a non-vetoing payload-free catalog invalidation. */`],
  ]);
}

/** Advertise a localized Auto default without changing the manual session-switch confirmation. */
export function patchPermissionClient(text) {
  return transform(text, 'client', [
    ...['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'].map(locale => [
      `const ${locale} = {`, `const ${locale} = { "preset.auto": ${JSON.stringify(locale === 'zh' ? '自动审查' : 'Auto review')},`,
    ]),
    ['[FULL_ACCESS_PRESET, "preset.fullAccess"]', '[FULL_ACCESS_PRESET, "preset.fullAccess"], [AUTO_REVIEW_PRESET, "preset.auto"]'],
    ['"preset.fullAccess": en["preset.fullAccess"]', '"preset.fullAccess": en["preset.fullAccess"], "preset.auto": en["preset.auto"]'],
  ]);
}

/** A live Web plugin removal must never promote Auto sessions to Full access. */
export function patchAutoReviewHost(text) {
  return transform(text, 'lifecycle', [
    ['permissionPresets.set(session, "danger-full-access");', 'permissionPresets.fallbackWebPermission(session);'],
  ]);
}

/** Patch all pinned Web artifacts before startup; prepare every edit before writing any file. */
export function patchWebAutoReview(root) {
  const changes = [
    ['dsh-permission-presets/lib/index.js', patchPermissionHost],
    ['dsh-client-ui-permission-presets/lib/client.js', patchPermissionClient],
    ['dsh-experimental-auto-review/lib/index.js', patchAutoReviewHost],
  ].map(([name, patch]) => {
    const file = path.join(root, '@deepseek-ai', name);
    const before = fs.readFileSync(file, 'utf8');
    return { file, before, after: patch(before), mode: fs.statSync(file).mode };
  });
  for (const { file, before, after, mode } of changes) {
    if (before === after) continue;
    fs.unlinkSync(file);
    fs.writeFileSync(file, after, { mode });
    fs.chmodSync(file, mode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: patch-web-auto-review.mjs <runtime node_modules>');
  patchWebAutoReview(process.argv[2]);
}
