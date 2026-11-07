import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PATCHES, patchMarketSettingsIcon } from './plugin-patches.mjs';

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

const packageRoot = process.env.MARKET_ICON_PACKAGE;
const script = fileURLToPath(new URL('plugin-patches.mjs', import.meta.url));

function releasedPackage() {
  assert.ok(packageRoot, 'Set MARKET_ICON_PACKAGE to the extracted official dshmarket@1.73.12 package directory');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'dshmarket');
  assert.equal(metadata.version, '1.73.12');
  return packageRoot;
}

test('every dshmarket patch targets an existing file in the official release', () => {
  const root = releasedPackage();
  const patches = PATCHES.filter(patch => patch.file.startsWith('dshmarket/'));
  assert.ok(patches.length > 0);
  for (const patch of patches) {
    assert.ok(fs.statSync(path.join(root, patch.file.slice('dshmarket/'.length))).isFile(), patch.file);
  }
  const source = fs.readFileSync(path.join(root, 'client/client.js'), 'utf8');
  for (const anchor of ['//#region src/client/settings-nav-icon.ts',
    'installSettingsNavIcon(ctx, () => t("nav"));', 'function MarketLogo(']) {
    assert.equal(source.split(anchor).length - 1, 1, anchor);
  }
});

test('official package and old company-patched copies upgrade twice through the startup CLI', t => {
  const release = releasedPackage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(release, 'client/client.js'), 'utf8');
  const results = [];
  for (const [index, input] of [source, source.replace('[${NAV_ICON_MARKER}] > svg',
    '[${NAV_ICON_MARKER}] > svg, [${NAV_ICON_MARKER}] > [aria-hidden="true"]')].entries()) {
    const modules = path.join(root, String(index), 'node_modules');
    const target = path.join(modules, 'dshmarket');
    fs.cpSync(release, target, { recursive: true });
    const file = path.join(target, 'client/client.js');
    fs.writeFileSync(file, input);
    execFileSync(process.execPath, [script, modules], { stdio: 'pipe' });
    const patched = fs.readFileSync(file, 'utf8');
    assert.ok(patched.includes('name: "settings.section.icon", id: "market"'));
    assert.ok(!patched.includes('data-dsh-market-nav-icon'));
    execFileSync(process.execPath, ['--check', file]);
    execFileSync(process.execPath, [script, modules], { stdio: 'pipe' });
    assert.equal(fs.readFileSync(file, 'utf8'), patched);
    results.push(patched);
  }
  assert.equal(results[0], results[1]);
});

test('missing targets warn for every patch file, including function patches', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-plugin-patches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { status, stderr, signal, error } = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.ifError(error);
  assert.equal(signal, null);
  assert.equal(status, 0);
  for (const file of new Set(PATCHES.map(patch => patch.file))) {
    assert.ok(stderr.includes(`插件修补未命中，目标文件不存在：${file}`), file);
  }
});

test('a package found only in the pnpm store is patched without a missing-target warning', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-plugin-patches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, '.pnpm/dshmarket@1.73.12/node_modules/dshmarket');
  fs.cpSync(releasedPackage(), target, { recursive: true });
  const { status, stderr, signal, error } = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.ifError(error);
  assert.equal(signal, null);
  assert.equal(status, 0);
  assert.ok(!stderr.includes('dshmarket/'), stderr);
  const patched = fs.readFileSync(path.join(target, 'client/client.js'), 'utf8');
  assert.ok(patched.includes('CRYSOUND market settings icon v1'));
});
