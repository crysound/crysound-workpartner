import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install the bundled, dependency-free settings module after managed plugin installs.
 * @param patch Personal profile patch; preserves all unrelated dependencies and rows.
 */
export function prepareNativeProfile(patch) {
  const profile = path.dirname(patch);
  const source = fileURLToPath(new URL('./native/', import.meta.url));
  const bundled = path.join(profile, 'company-plugins/feishu-settings');
  const installed = path.join(profile, 'node_modules/@crysound/feishu-settings');
  // Copying, rather than linking, also works on Windows without symlink privileges.
  for (const target of [bundled, installed]) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of ['package.json', 'index.mjs', 'client.js', 'daily-host.mjs']) {
      const bytes = fs.readFileSync(path.join(source, file));
      const destination = path.join(target, file);
      if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) {
        fs.writeFileSync(destination + '.tmp', bytes);
        fs.renameSync(destination + '.tmp', destination);
      }
    }
  }
  const manifest = path.join(profile, 'package.json');
  const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : {};
  if (pkg.dependencies?.['@crysound/feishu-settings'] !== 'file:company-plugins/feishu-settings') {
    (pkg.dependencies ??= {})['@crysound/feishu-settings'] = 'file:company-plugins/feishu-settings';
    fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
  }
  const initial = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '[]\n';
  if (/^- id: ['"]?company-feishu-settings['"]?\s*$/m.test(initial)) return;
  fs.writeFileSync(patch, initial.replace(/^\[\]\s*$/m, '').replace(/\n*$/, '\n') + "\n- id: company-feishu-settings\n  name: '@crysound/feishu-settings'\n", { mode: 0o600 });
}
