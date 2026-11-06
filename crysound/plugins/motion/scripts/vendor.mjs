// Import the exact reviewed, dependency-free renderer subset; never copies demos or character artwork.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] || '');
const commit = '52467f99c602b76ba86d511d37acdfe93fa1e16e';
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) {
  throw new Error(`Expected huashu-motion commit ${commit}`);
}
execFileSync('git', ['-C', source, 'diff', '--quiet', 'HEAD']);
const files = new Set(['LICENSE', 'cli/lib/render.js', 'cli/lib/still.js', 'cli/lib/sound.js', 'cli/lib/check.js',
  'runtime/om.js', 'runtime/om-engine.js', 'runtime/clip/clip.js',
  'templates/blank/vendor/gsap.min.js', 'templates/blank/vendor/GSAP-LICENSE.html', 'templates/blank/vendor/GSAP-LICENSE.txt',
  'templates/blank/assets/fonts/NotoSansSC-500.woff', 'templates/blank/assets/fonts/NotoSansSC-900.woff',
  'templates/blank/assets/fonts/OFL.txt', 'templates/blank/assets/fonts/LICENSES.md']);
for (const file of files) {
  if (!file.startsWith('cli/lib/')) continue;
  const text = readFileSync(join(source, file), 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*\()['"]\.\/([\w-]+\.js)['"]/g)) {
    files.add(`cli/lib/${match[1]}`);
  }
}
const sha = (data) => createHash('sha256').update(data).digest('hex');
const manifest = { repository: 'https://github.com/alchaincyf/huashu-motion', commit, version: '0.3.1', files: {} };
for (const file of [...files].sort()) {
  const input = readFileSync(join(source, file));
  let output = input;
  if (file.startsWith('cli/lib/') && file !== 'cli/lib/cdp.js') {
    output = Buffer.from(output.toString().replaceAll("from 'node:child_process'", "from '../process.mjs'"));
  }
  if (file === 'cli/lib/render-om.js') {
    output = Buffer.from(output.toString()
      .replace('Math.min(8, Math.round(cpus().length * 0.6))', 'Math.min(2, Math.round(cpus().length * 0.6))')
      .replace('const want = Math.max(1, Math.round(workers) || 1);', 'const want = Math.max(1, Math.min(2, Math.round(workers) || 1));')
      .replace('Math.min(4, queue.length)', 'Math.min(2, queue.length)'));
  }
  if (file === 'cli/lib/capture.js') {
    output = Buffer.from(output.toString()
      .replace('const conn = await launch(chrome,', "if (width > 1920 || height > 1920 || width * height > 1920 * 1080) throw new OmError('Company limit: at most 1920x1080 pixels (portrait allowed)');\n  const conn = await launch(chrome,")
      .replace("const info = await page.evaluate('window.__omEngine.info()');", "const info = await page.evaluate('window.__omEngine.info()');\n  if (!Number.isFinite(info.duration) || info.duration < 0 || info.duration > 30) {\n    await conn.close();\n    throw new OmError('Company limit: film duration must be at most 30 seconds');\n  }"));
  }
  if (file === 'cli/lib/cdp.js') {
    // All helpers stay in the supervised job group, including Chrome's subprocesses.
    output = Buffer.from(input.toString()
      .replaceAll("detached: process.platform !== 'win32'", 'detached: false')
      .replace('// keeping Node alive: the browser runs in its own process group and the whole group is killed.',
        '// keeping Node alive: the company supervisor stops the inherited job group after this worker exits.')
      .replace("if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL');", "child.kill('SIGKILL');"));
  }
  if (!file.endsWith('.woff')) {
    // Preserve license wording while making checked-out bytes stable under Git's text normalization.
    output = Buffer.from(output.toString().replaceAll('\r\n', '\n')
      .replace(/^[ \t]+/gm, (indent) => indent.replaceAll('\t', '  '))
      .replace(/[ \t]+$/gm, '').trimEnd() + '\n');
  }
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  if (output === input) copyFileSync(join(source, file), target);
  else writeFileSync(target, output);
  manifest.files[file] = { upstream: sha(input), shipped: sha(output) };
}
writeFileSync(join(root, 'SOURCES.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Imported ${files.size} files from ${commit}`);
