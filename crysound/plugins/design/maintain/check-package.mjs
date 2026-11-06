/** Validate imported bytes, package resources, company mark and the intentionally reduced scope. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'maintain/upstream-files.json')));
for (const [path, expected] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), expected, path);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
assert.equal(pkg.name, '@crysound/design');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
for (const file of pkg.files) assert.ok(existsSync(join(root, file)), file);
assert.deepEqual(readFileSync(join(root, 'assets/zp-mark.svg')), readFileSync(new URL('../../../brand/zp-mark.svg', import.meta.url)));
function walk(path = '') {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const relative = join(path, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}
for (const file of walk()) {
  assert.ok(!/(?:^|\/)(?:cloud|stickers|ppt|xhs|node_modules)(?:\/|$)|\.py$|\.mp[34]$/.test(file), file);
  if (/\.(md|mjs|jsx|yml)$/.test(file) && !/^(maintain|tests)\//.test(file) && !['SOURCES.md'].includes(file)) {
    const content = readFileSync(join(root, file), 'utf8');
    assert.ok(!/baoyu-design|CL4R1T4S|guizang|PolyForm/.test(content), file);
    for (const match of content.matchAll(/(?:references|scripts|assets)\/[a-zA-Z0-9_./-]+\.(?:md|mjs|jsx|jpg|svg)/g)) {
      assert.ok(existsSync(join(root, match[0])), `${file}: missing ${match[0]}`);
    }
  }
}
console.log(`PASS: ${Object.keys(manifest.sha256).length} imported files, resource links, brand and scope`);
