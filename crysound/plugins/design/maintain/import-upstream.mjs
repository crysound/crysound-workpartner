/** Recreate the audited upstream subset from a pinned local checkout and frontend-design files. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [checkout, frontendSkill, frontendLicense] = process.argv.slice(2);
if (!checkout || !frontendSkill || !frontendLicense) throw new Error('Usage: node maintain/import-upstream.mjs <huashu checkout> <frontend SKILL.md> <frontend LICENSE.txt>');
const commit = 'b2460b031c33ff32d2bf3b97263527daa231e4de';
for (const [path, expected] of [
  [frontendSkill, 'd91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3'],
  [frontendLicense, '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'],
]) {
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error('Unexpected frontend-design source bytes');
}

if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) throw new Error('Unexpected huashu-design commit');
if (execFileSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('huashu-design checkout must be clean');
const imported = [];
function copy(source, target) {
  mkdirSync(dirname(join(root, target)), { recursive: true });
  cpSync(source, join(root, target));
  if (target === 'references/content-guidelines.md') writeFileSync(join(root, target), readFileSync(source, 'utf8').replace(/[ \t]+$/gm, ''));
  imported.push(target);
}
for (const file of ['LICENSE', 'references/typography.md', 'references/content-guidelines.md', 'references/critique-guide.md']) copy(join(checkout, file), file);
for (const file of ['ios_frame.jsx', 'android_frame.jsx', 'browser_window.jsx', 'macos_window.jsx', 'design_canvas.jsx']) copy(join(checkout, 'assets', file), `assets/${file}`);
for (const section of ['web', 'app', 'info', 'east']) {
  // Keep images only: sample HTML can load fonts/CDNs and is unnecessary for choosing a direction.
  for (const file of readdirSync(join(checkout, 'assets/style-specimens', section)).sort()) {
    if (file.endsWith('.jpg')) copy(join(checkout, 'assets/style-specimens', section, file), `assets/style-specimens/${section}/${file}`);
  }
  copy(join(checkout, `assets/style-specimens/sheet-${section}.jpg`), `assets/style-specimens/sheet-${section}.jpg`);
}
let styles = readFileSync(join(checkout, 'references/design-styles.md'), 'utf8');
styles = styles.replace(/## PPT风格库[\s\S]*?(?=## 信息图风格库)/, '').replace(/## 小红书图文[\s\S]*?(?=## ⚠️)/, '');
styles = styles.replaceAll('references/app-prototype.md', 'references/modules/app.md');
styles = styles.replaceAll('web|ppt|info|app|east|xhs', 'web|info|app|east').replace('（同名 .html 是源码，可以直接读 CSS 学它的做法）', '（本包只保留样张图片）');
writeFileSync(join(root, 'references/design-styles.md'), styles);
imported.push('references/design-styles.md');
copy(frontendSkill, 'references/frontend-design.md');
copy(frontendLicense, 'licenses/frontend-design-Apache-2.0.txt');
const hashes = Object.fromEntries(imported.sort().map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
writeFileSync(join(root, 'maintain/upstream-files.json'), JSON.stringify({ huashuCommit: commit, frontendCommit: 'ca45fc496a3436251f191354091d557da31c15b5', sha256: hashes }, null, 2) + '\n');
console.log(`Imported ${imported.length} audited files`);
