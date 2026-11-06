// Verify shipped artifacts, including the pixels inside Windows ICO frames.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const source = new URL('../', import.meta.url);
const root = new URL('../../../', source);
const require = createRequire(new URL('apps/desktop/package.json', root));
const sharp = require(process.env.LOGO_SHARP_MODULE || 'sharp');
const read = path => readFileSync(new URL(path, root));
const big = read('crysound/brand/logo-src/B.svg');
const small = read('crysound/brand/logo-src/B-16.svg');
for (const name of ['crysound/brand/zp-mark-32.svg', 'crysound/brand/favicon.svg',
  'crysound/brand/favicon-dark.svg', 'apps/web/public/favicon.svg', 'apps/web/public/favicon-dark.svg']) {
  assert.deepEqual(read(name), small, name);
}
assert.deepEqual(read('crysound/brand/zp-mark.svg'), big);
assert(!small.includes('<circle'), 'small logo must have no glints');
for (const [name, sizes] of [
  ['icon-windows.ico', [16, 24, 32, 48, 64, 128, 256]],
  ['tray-windows.ico', [16, 20, 24, 32, 40, 48, 64]],
]) {
  const ico = read(`apps/desktop/resources/${name}`);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), sizes.length);
  for (const [i, size] of sizes.entries()) {
    const at = 6 + 16 * i, length = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    assert.equal(ico[at] || 256, size);
    const frame = ico.subarray(offset, offset + length);
    const svg = size <= 32 ? small : big;
    const expected = await sharp(svg, { density: 72 * size / (size <= 32 ? 16 : 64) }).resize(size, size).raw().toBuffer();
    assert.deepEqual(await sharp(frame).raw().toBuffer(), expected, `${name}: ${size}px pixels`);
  }
}
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512],
  ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180],
  ['feishu-app-1024.png', 1024], ['feishu-sidebar-32.png', 32]]) {
  const meta = await sharp(read(`crysound/brand/${name}`)).metadata();
  assert.equal(meta.width, size, name); assert.equal(meta.height, size, name);
}
const mac = await sharp(read('apps/desktop/resources/icon-macos.png')).ensureAlpha().raw().toBuffer();
assert.equal(mac[(512 * 1024 + 99) * 4 + 3], 0, 'Mac inset must stay transparent');
assert(mac[(512 * 1024 + 100) * 4 + 3] > 0, 'Mac tile must start at its 100px inset');
const mask = await sharp(read('crysound/brand/icon-maskable-512.png')).removeAlpha().raw().toBuffer();
// Outside the safe circle, only the solid brand background may remain.
for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
  if (Math.hypot(x - 255.5, y - 255.5) <= 205) continue;
  const at = (y * 512 + x) * 3;
  assert.equal(mask[at], 23); assert.equal(mask[at + 1], 0); assert.equal(mask[at + 2], 87);
}
// Re-running the canonical generator must not drift any of its outputs.
const outputs = ['crysound/brand/pet.js', ...['B.svg', 'B-16.svg', 'B-mono.svg', 'B-mono-white.svg'].map(n => 'crysound/brand/logo-src/' + n),
  ...['zp-mark.svg', 'zp-mark-32.svg', 'favicon.svg', 'favicon-dark.svg', 'icon-192.png', 'icon-512.png',
    'icon-maskable-512.png', 'apple-touch-icon.png', 'feishu-app-1024.png', 'feishu-sidebar-32.png'].map(n => 'crysound/brand/' + n),
  ...['icon-macos.svg', 'icon-macos.png', 'icon-windows.svg', 'icon-windows.png', 'icon-windows.ico',
    'icon.svg', 'icon.png', 'tray-windows.ico'].map(n => 'apps/desktop/resources/' + n),
  'apps/web/public/favicon.svg', 'apps/web/public/favicon-dark.svg'];
const digest = () => outputs.map(n => createHash('sha256').update(read(n)).digest('hex'));
const before = digest();
execFileSync(process.execPath, [new URL('gen.mjs', import.meta.url).pathname], { env: process.env });
assert.deepEqual(digest(), before, 'generator must reproduce all committed artifacts');
console.log('PASS: favicon copies, PNG sizes, Mac inset, maskable safe area, every ICO frame, generation idempotence');
