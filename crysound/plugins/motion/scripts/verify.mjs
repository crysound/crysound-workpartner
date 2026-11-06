// Recomputable source/license/package checks, independent of dependencies or a browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = JSON.parse(readFileSync(join(root, 'SOURCES.json'), 'utf8'));
assert.equal(sources.commit, '52467f99c602b76ba86d511d37acdfe93fa1e16e');
for (const [path, expected] of Object.entries(sources.files)) {
  const content = readFileSync(join(root, path));
  assert.equal(createHash('sha256').update(content).digest('hex'), expected.shipped, path);
}
const logo = readFileSync(join(root, '../../brand/zp-mark.svg'));
assert.deepEqual(readFileSync(join(root, 'templates/company/assets/zp-mark.svg')), logo);
for (const path of ['LICENSE', 'THIRD_PARTY.md', 'templates/blank/vendor/GSAP-LICENSE.html',
  'templates/blank/assets/fonts/OFL.txt', 'templates/blank/assets/fonts/LICENSES.md']) assert.ok(existsSync(join(root, path)), path);
const forbidden = /toon\.js|y4_storytime|storytime|kokoro\.py|voice\.js|samples-build|server\.js|grab\.js|share\.js/;
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      assert.ok(!forbidden.test(path), path);
      if (/\.(js|mjs)$/.test(path)) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
      if (/\.(js|mjs|html)$/.test(path) && !path.endsWith('gsap.min.js')) {
        const text = readFileSync(path, 'utf8');
        assert.ok(!/fetch\(|https?:\/\/[^\s]+\.(onnx|bin|zip)|TOON\.|lib\/toon|grammars\/y4/.test(text), path);
      }
    }
  }
}
for (const dir of ['cli', 'runtime', 'templates']) walk(join(root, dir));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@crysound/motion');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.dependencies, undefined);
assert.equal(manifest.publishConfig, undefined);
for (const hook of ['install', 'preinstall', 'postinstall', 'prepare', 'prepack']) assert.equal(manifest.scripts[hook], undefined);
console.log(`Source hashes (${Object.keys(sources.files).length}), licenses, company logo, disabled content and JavaScript syntax: passed`);
