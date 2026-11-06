// B 玻璃：唯一的配色与造型来源。node crysound/brand/logo-src/src/gen.mjs
// PNG/ICO 导出需要已有的 sharp（也可用 LOGO_SHARP_MODULE 指向已安装的 sharp）。
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
const OUT = new URL("../", import.meta.url).pathname;

const SQ = "M15 0H49A15 15 0 0 1 64 15V49A15 15 0 0 1 49 64H15A15 15 0 0 1 0 49V15A15 15 0 0 1 15 0Z";
// 64 px 起用的头和眼（zp-mark.svg）
const HEAD = "M7.56 52.74A25 25 0 0 1 56.44 52.74A6 6 0 0 1 50.57 60H13.43A6 6 0 0 1 7.56 52.74Z";
const EYES = "M27 37.5A3.5 3.5 0 0 1 30.5 41V46A3.5 3.5 0 0 1 27 49.5A3.5 3.5 0 0 1 23.5 46V41A3.5 3.5 0 0 1 27 37.5ZM42 37.5A3.5 3.5 0 0 1 45.5 41V46A3.5 3.5 0 0 1 42 49.5A3.5 3.5 0 0 1 38.5 46V41A3.5 3.5 0 0 1 42 37.5Z";
// 16 px 用的头和眼（favicon.svg：头更大、眼更粗）
const HEAD16 = "M6.53 52.8A26 26 0 0 1 57.47 52.8A6 6 0 0 1 51.6 60H12.4A6 6 0 0 1 6.53 52.8Z";
const EYES16 = "M26.5 40H29.5A2.5 2.5 0 0 1 32 42.5V49.5A2.5 2.5 0 0 1 29.5 52H26.5A2.5 2.5 0 0 1 24 49.5V42.5A2.5 2.5 0 0 1 26.5 40ZM42.5 40H45.5A2.5 2.5 0 0 1 48 42.5V49.5A2.5 2.5 0 0 1 45.5 52H42.5A2.5 2.5 0 0 1 40 49.5V42.5A2.5 2.5 0 0 1 42.5 40Z";

const svg = (size, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-labelledby="title"><title id="title">兆华工作伙伴</title>` +
  (defs ? `<defs>${defs}</defs>` : "") + body + `</svg>\n`;
const lin = (id, [x1, y1, x2, y2], stops) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a !== undefined ? ` stop-opacity="${a}"` : ""}/>`).join("")}</linearGradient>`;
const rad = (id, [cx, cy, r], stops, extra = "") =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"${extra}>${stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a !== undefined ? ` stop-opacity="${a}"` : ""}/>`).join("")}</radialGradient>`;
const P = (d, fill, extra = "") => `<path d="${d}" fill="${fill}"${extra}/>`;

const DIRS = {
  // B 玻璃：底色渐变 + 顶部柔光 + 上缘亮边；头部白→淡紫，眼睛带高光点
  B: {
    big: () => svg(64,
      lin("t", [14, 0, 50, 64], [[0, "#5733E6"], [0.55, "#260A88"], [1, "#170057"]]) +
      rad("g", [20, 2, 34], [[0, "#fff", 0.26], [0.6, "#fff", 0.06], [1, "#fff", 0]]) +
      lin("r", [0, 0, 0, 18], [[0, "#fff", 0.4], [1, "#fff", 0]]) +
      lin("h", [0, 33, 0, 60], [[0, "#fff"], [0.5, "#F6F3FF"], [1, "#D7CCFF"]]) +
      lin("e", [0, 37.5, 0, 49.5], [[0, "#3A16B4"], [1, "#170057"]]),
      P(SQ, "url(#t)") + P(SQ, "url(#g)") +
      `<path d="M15 .5H49A14.5 14.5 0 0 1 63.5 15V49A14.5 14.5 0 0 1 49 63.5H15A14.5 14.5 0 0 1 .5 49V15A14.5 14.5 0 0 1 15 .5Z" fill="none" stroke="url(#r)"/>` +
      P(HEAD, "url(#h)") + P(EYES, "url(#e)") +
      `<circle cx="28.3" cy="40.6" r="1.35" fill="#fff"/><circle cx="43.3" cy="40.6" r="1.35" fill="#fff"/>`),
    small: () => svg(16,
      lin("t", [14, 0, 50, 64], [[0, "#5733E6"], [0.6, "#260A88"], [1, "#170057"]]) +
      lin("h", [0, 33, 0, 60], [[0, "#fff"], [0.6, "#FAF8FF"], [1, "#E3DAFF"]]),
      P(SQ, "url(#t)") + P(HEAD16, "url(#h)") + P(EYES16, "#170057")),
  },

};

// 单色版：一种颜色，头部镂空露出背景、眼睛同色。所有方向共用同一造型。
const MONO = (c) => svg(64, "", `<path fill="${c}" fill-rule="evenodd" d="${SQ}${HEAD}"/>` + P(EYES, c));

for (const [k, d] of Object.entries(DIRS)) {
  writeFileSync(OUT + `${k}.svg`, d.big());
  writeFileSync(OUT + `${k}-16.svg`, d.small());
  writeFileSync(OUT + `${k}-mono.svg`, MONO("#170057"));
  writeFileSync(OUT + `${k}-mono-white.svg`, MONO("#ffffff"));
}

const brand = new URL('../../', import.meta.url);
const root = new URL('../../', brand);
const desktop = new URL('apps/desktop/resources/', root);
const write = (url, text) => writeFileSync(url, text);
const big = DIRS.B.big(), small = DIRS.B.small();
for (const name of ['zp-mark-32.svg', 'favicon.svg', 'favicon-dark.svg']) write(new URL(name, brand), small);
write(new URL('zp-mark.svg', brand), big);
for (const name of ['favicon.svg', 'favicon-dark.svg']) write(new URL(`apps/web/public/${name}`, root), small);

// Keep gradients inside the same transformed coordinate system as their shapes.
// The animated component gets these generated fragments, too: no second palette.
const parts = (svg, simplified) => {
  const defs = svg.match(/<defs>(.*?)<\/defs>/s)[1];
  const body = svg.match(/<\/defs>(.*?)<\/svg>/s)[1];
  const paths = body.match(/<path .*?\/>/g);
  return {
    defs,
    tile: paths.slice(0, simplified ? 1 : 3).join(''),
    head: paths.at(-2),
    eyes: paths.at(-1).replace('<path ', '<path class="eye" ') +
      (simplified ? '' : body.match(/<circle .*?\/>/g).join('').replaceAll('<circle ', '<circle class="glint" ')),
  };
};
const art = `// BEGIN GENERATED LOGO ART (logo-src/src/gen.mjs)\n` +
  `const LOGO_ART=${JSON.stringify([parts(big, false), parts(small, true)])};\n` +
  `function logoArt(id,small){return Object.fromEntries(Object.entries(LOGO_ART[small?1:0]).map(([key,value])=>[key,value.replaceAll('id="','id="'+id).replaceAll('url(#','url(#'+id)]))}\n` +
  `// END GENERATED LOGO ART`;
const petFile = new URL('pet.js', brand);
const pet = readFileSync(petFile, 'utf8');
if (!pet.includes('// BEGIN GENERATED LOGO ART')) throw new Error('pet.js: missing generated-art marker');
write(petFile, pet.replace(/\/\/ BEGIN GENERATED LOGO ART[\s\S]*?\/\/ END GENERATED LOGO ART/, () => art));

const canvas = (svg, inset, edge) => svg
  .replace('viewBox="0 0 64 64" width="64" height="64"', `viewBox="0 0 ${edge} ${edge}" width="${edge}" height="${edge}"`)
  .replace('</title>', `</title><g transform="translate(${inset} ${inset}) scale(${(edge - 2 * inset) / 64})">`)
  .replace('</svg>', '</g></svg>');
const mac = canvas(big, 100, 1024);
write(new URL('icon-macos.svg', desktop), mac);
write(new URL('icon-windows.svg', desktop), big);
write(new URL('icon.svg', desktop), big);

const require = createRequire(new URL('apps/desktop/package.json', root));
const sharp = require(process.env.LOGO_SHARP_MODULE || 'sharp');
const png = (svg, edge) => sharp(Buffer.from(svg), { density: 72 * edge / Number(svg.match(/width="(\d+)"/)[1]) })
  .resize(edge, edge).png().toBuffer();
for (const [name, edge, svg] of [
  ['icon-192.png', 192, big], ['icon-512.png', 512, big],
  // Entire square fits in the central safe circle (radius 40%): 70.7% maximum.
  ['icon-maskable-512.png', 512, canvas(big, 96, 512)],
  ['apple-touch-icon.png', 180, big], ['feishu-app-1024.png', 1024, big],
  ['feishu-sidebar-32.png', 32, small],
]) {
  let raster = await png(svg, edge);
  if (name.includes('maskable')) raster = await sharp(raster).flatten({ background: '#170057' }).png().toBuffer();
  write(new URL(name, brand), raster);
}
for (const [name, svg] of [['icon-macos.png', mac], ['icon-windows.png', big], ['icon.png', big]]) {
  write(new URL(name, desktop), await png(svg, 1024));
}
// PNG-compressed ICO frames are supported by Windows Vista and later.
async function ico(sizes) {
  const entries = [];
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [i, size] of sizes.entries()) {
    const frame = await png(size <= 32 ? small : big, size);
    const at = 6 + i * 16;
    header[at] = header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(frame.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += frame.length; entries.push(frame);
  }
  return Buffer.concat([header, ...entries]);
}
write(new URL('icon-windows.ico', desktop), await ico([16, 24, 32, 48, 64, 128, 256]));
write(new URL('tray-windows.ico', desktop), await ico([16, 20, 24, 32, 40, 48, 64]));
console.log('B glass: SVG, PNG, ICO and animated art regenerated');
