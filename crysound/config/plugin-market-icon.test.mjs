import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchMarketSettingsIcon } from './plugin-patches.mjs';

const client = `function MarketLogo() { return 'existing market glyph'; }
//#region src/client/settings-nav-icon.ts
const NAV_ICON_MARKER = 'data-dsh-market-nav-icon';
function installSettingsNavIcon() { throw new Error('Legacy CSS adapter must not run'); }
//#endregion
function mountMarket(ctx) { installSettingsNavIcon(ctx, () => t("nav")); }`;

test('market registers its existing glyph by section id and returns the slot disposer', () => {
  const patched = patchMarketSettingsIcon(client);
  assert.ok(!patched.includes('NAV_ICON_MARKER'));
  assert.ok(!patched.includes('installSettingsNavIcon'));
  const disposed = () => {};
  const slots = {
    inject(name, register) {
      assert.equal(name, 'settings.section.icon');
      assert.equal(register(), disposed);
    },
    register(options, component) {
      assert.equal(options.name, 'settings.section.icon');
      assert.equal(options.id, 'market');
      assert.equal(component(), 'existing market glyph');
      return disposed;
    },
  };
  vm.runInNewContext(patched + ';mountMarket(ctx);', { ctx: { slots } });
  assert.equal(patchMarketSettingsIcon(patched), patched);
});

test('changed or duplicate module anchors are rejected before patching', () => {
  for (const source of [client.replace('() => t("nav")', '() => t("renamed")'), client + client,
    client.replace('src/client/settings-nav-icon.ts', 'src/client/changed.ts'), client.replace('function MarketLogo(', 'function NewLogo(')]) {
    assert.throws(() => patchMarketSettingsIcon(source), /未唯一命中/);
  }
});

test('released market client and old company-patched copies upgrade twice without duplicate changes',
  { skip: !process.env.MARKET_ICON_CLIENT }, t => {
    const source = fs.readFileSync(process.env.MARKET_ICON_CLIENT, 'utf8');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-icon-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'dshmarket/lib/client.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const script = fileURLToPath(new URL('plugin-patches.mjs', import.meta.url));
    const results = [];
    for (const input of [source, source.replace('[${NAV_ICON_MARKER}] > svg',
      '[${NAV_ICON_MARKER}] > svg, [${NAV_ICON_MARKER}] > [aria-hidden="true"]')]) {
      fs.writeFileSync(file, input);
      execFileSync(process.execPath, [script, root]);
      const patched = fs.readFileSync(file, 'utf8');
      assert.ok(patched.includes('name: "settings.section.icon", id: "market"'));
      assert.ok(!patched.includes('data-dsh-market-nav-icon'));
      execFileSync(process.execPath, ['--check', file]);
      execFileSync(process.execPath, [script, root]);
      assert.equal(fs.readFileSync(file, 'utf8'), patched);
      results.push(patched);
    }
    assert.equal(results[0], results[1]);
  });
