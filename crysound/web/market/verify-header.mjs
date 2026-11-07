// Check the published plugin-manager CSS in a dedicated blank persistent-browser tab.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { marketCardCss } from '../../scripts/patch-market-cards.mjs';

assert.ok(process.env.CDP_TAB, 'CDP_TAB must identify a dedicated blank tab');
assert.ok(process.env.MARKET_RUNTIME_MODULES, 'MARKET_RUNTIME_MODULES must name the pinned release modules');
assert.ok(process.env.CDP_ENTRY, 'CDP_ENTRY must name the configured persistent-browser cdp.mjs');
const source = fs.readFileSync(path.join(process.env.MARKET_RUNTIME_MODULES,
  '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js'), 'utf8');
const start = source.indexOf('/PluginManagerPage.module.css.mjs');
assert.ok(start >= 0, 'Published plugin-manager stylesheet must exist');
const nativeCss = JSON.parse(source.slice(start).match(/const css = ("(?:[^"\\]|\\.)*");/u)[1]);
const classes = JSON.parse(source.match(/var PluginManagerPage_module_css_default = (\{[\s\S]*?\n\t\t\});/u)[1]);
const expression = `(() => {
  if (location.href !== 'about:blank') throw new Error('Use a dedicated blank test tab');
  const classes = ${JSON.stringify(classes)};
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(nativeCss + '\n' + marketCardCss)};
  document.head.append(style);
  const page = document.createElement('section');
  page.className = classes.page;
  page.setAttribute('data-plugin-panel', '');
  const bar = document.createElement('div');
  bar.className = classes.pageBar;
  bar.setAttribute('data-plugin-bar', '');
  const head = document.createElement('header');
  head.className = classes.pageHead;
  bar.append(head); page.append(bar); document.body.append(page);
  document.documentElement.style.setProperty('--dsh-frame-top-clearance', '32px');
  const rows = [];
  for (const platform of ['web', 'darwin', 'win32']) {
    if (platform === 'web') document.documentElement.removeAttribute('data-platform');
    else document.documentElement.setAttribute('data-platform', platform);
    for (const collapsed of [false, true]) {
      document.body.toggleAttribute('data-sidebar-collapsed', collapsed);
      for (const mode of ['rest', 'compact', 'natural']) {
        bar.toggleAttribute('data-compact', mode !== 'rest');
        bar.toggleAttribute('data-natural', mode === 'natural');
        rows.push({platform, collapsed, mode, paddingTop:parseFloat(getComputedStyle(head).paddingTop)});
      }
    }
  }
  page.remove(); style.remove();
  document.documentElement.removeAttribute('data-platform');
  document.documentElement.style.removeProperty('--dsh-frame-top-clearance');
  document.body.removeAttribute('data-sidebar-collapsed');
  return rows;
})()`;
const rows = JSON.parse(execFileSync(process.execPath, [process.env.CDP_ENTRY, 'eval', expression], {
  encoding: 'utf8', env: process.env, timeout: 30000,
}));
const results = rows.map(row => ({...row, expected: row.platform !== 'darwin' ? 16
  : row.mode === 'compact' ? row.collapsed ? 40 : 16 : 48}));
console.log(JSON.stringify(results, null, 2));
for (const row of results) assert.equal(row.paddingTop, row.expected,
  `${row.platform}, sidebar collapsed=${row.collapsed}, header=${row.mode}`);
