// Compare the shipped palette to the pinned Apache-2.0 source, without installing or building.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const source = process.argv[2];
if (!source) throw new Error('Usage: node verify-cindy-palette.mjs <Cindy checkout> [skin.css]');
const css = fs.readFileSync(process.argv[3] || new URL('../skin.css', import.meta.url), 'utf8');
let count = 0;
for (const theme of ['light', 'dark']) {
  const original = fs.readFileSync(path.join(source, `apps/desktop/src/renderer/themes/builtin/cindy-${theme}.ts`), 'utf8');
  const tokens = Object.fromEntries([...original.matchAll(/"([^"\n]+)": "([^"\n]+)"/g)].map(match => [match[1], match[2]]));
  const selector = ':root[data-zp-skin="soft"] > body' + (theme === 'dark' ? '[data-ds-dark-theme]' : '') + ' {';
  const start = css.indexOf(selector);
  assert.ok(start >= 0, selector);
  const block = css.slice(start + selector.length, css.indexOf('}', start));
  const declarations = [...block.matchAll(/(--[\w-]+): ([^;]+); \/\* ([\w-]+) \*\//g)];
  assert.ok(declarations.length >= 60, 'The palette must expose source tokens for its mapped colors');
  for (const [, variable, actual, token] of declarations) {
    assert.ok(token in tokens, `${theme}: unknown source token ${token}`);
    let expected = tokens[token];
    if (token === 'sidebar-item-active' || token === 'sidebar-item-hover') expected = `hsl(${expected})`;
    if (token === 'switch-thumb-on' && theme === 'light') expected = tokens.surface;
    assert.equal(actual, expected, `${theme} ${variable} from ${token}`);
    count++;
  }
}
const backdrop = fs.readFileSync(path.join(source, 'apps/desktop/src/shared/windowBackdrop.ts'), 'utf8');
for (const value of ['238, 238, 233, 0.85', '5, 5, 5, 0.85']) {
  assert.ok(backdrop.includes(`rgba(${value})`));
  assert.ok(css.includes(`rgb(${value.replaceAll(', ', ' ').replace(' 0.85', ' / 0.85')})`));
}
assert.doesNotMatch(css, /#(?:170057|5733e6|3a16b4|eeebf8)\b/i, 'Skin colors exclude product logo colors');
console.log(`${count} mapped colors match the Cindy source; both Mac backings match; no brand purple in the skin`);
