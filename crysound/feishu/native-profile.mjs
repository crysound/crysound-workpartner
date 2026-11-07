import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Insert a company-owned plugin, upgrading the old override-only row in place. */
export function prepareProfilePlugin(patch, id, row) {
  const initial = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '[]\n';
  const lines = initial.replace(/^\[\]\s*$/m, '').split('\n');
  const rootRow = new RegExp(`^- id: ['"]?${id}['"]?\\s*$`);
  const start = lines.findIndex(line => rootRow.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('- ')) end++;
    // Preserve any configuration on the old managed row while making it an insertion.
    lines.splice(start, end - start, '- insert:', ...lines.slice(start, end).map(line => line ? `    ${line}` : line));
  } else {
    if (new RegExp(`^ +- id: ['"]?${id}['"]?\\s*$`, 'm').test(initial)) return;
    lines.push('- insert:', ...row.trimEnd().split('\n').map(line => `    ${line}`));
  }
  const next = lines.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(`${patch}.feishu.tmp`, next, { mode: 0o600 });
  fs.renameSync(`${patch}.feishu.tmp`, patch);
}

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
  prepareProfilePlugin(patch, 'company-feishu-settings', "- id: company-feishu-settings\n  name: '@crysound/feishu-settings'\n");
}
