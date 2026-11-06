// Node 24, --experimental-vm-modules; no dependency installation or desktop build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { prepareCompanyWorkspace } from '../../apps/desktop/src/crysound/workspace.ts';
import { writeMarketNpmrc } from '../../apps/desktop/src/crysound/npmrc.ts';
import { isMarketPlugin } from '../plugin-artifacts.mjs';

const source = resolve(import.meta.dirname, '../..');
const publicPlugin = { name: 'public-plugin', spec: 'public-plugin@1.0.0', want: '1.0.0' };
const memory = { name: '@crysound/memory', spec: '@crysound/memory@0.1.0', want: '0.1.0' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-market-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets'), profile = join(root, 'home/profiles/desktop');
  await mkdir(join(assets, 'config/skills/publish-zhaohua-market'), { recursive: true });
  await mkdir(join(assets, 'feishu'), { recursive: true });
  await mkdir(profile, { recursive: true });
  await cp(join(source, 'crysound/plugin-artifacts.mjs'), join(assets, 'plugin-artifacts.mjs'));
  await cp(join(source, 'crysound/config/company-plugins.mjs'), join(assets, 'config/company-plugins.mjs'));
  await writeFile(join(assets, 'config/plugins.json'), JSON.stringify({ plugins: [publicPlugin, memory], defaultBundles: ['test-bundle'] }));
  await writeFile(join(assets, 'config/profile-upgrades.mjs'), 'process.exit(0)');
  await writeFile(join(assets, 'feishu/desktop-setup.mjs'), 'process.exit(0)');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }));
  const template = join(assets, 'plugin-template');
  await mkdir(join(template, 'modules/public-plugin'), { recursive: true });
  await writeFile(join(template, 'modules/public-plugin/index.js'), 'bundled public plugin');
  await writeFile(join(template, 'package.json'), JSON.stringify({ dependencies: { [publicPlugin.name]: publicPlugin.want } }));
  await writeFile(join(template, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  return { root, assets, profile, userData: join(root, 'userdata') };
}

for (const plugins of [[publicPlugin, memory], [memory]]) test(`packaging leaves private market plugins out of a ${plugins.length}-plugin template`, async (t) => {
  const { root } = await fixture(t);
  const script = join(source, 'apps/desktop/scripts/prepare-plugin-template.ts');
  const specs = [];
  let buildProfile;
  const context = createContext({ console, Buffer, URL, process: { env: {}, platform: 'darwin', arch: 'arm64' } });
  const module = new SourceTextModule(stripTypeScriptTypes(await readFile(script, 'utf8')), {
    context, initializeImportMeta: meta => { meta.dirname = join(source, 'apps/desktop/scripts'); },
  });
  const fs = await import('node:fs');
  const overrides = {
    'node:fs': { ...fs, readFileSync: (file, ...args) => file === join(source, 'crysound/config/plugins.json')
      ? JSON.stringify({ plugins }) : fs.readFileSync(file, ...args) },
    '@deepseek-ai/dsh-app-boot': { initProfile: (profile) => {
      buildProfile = profile;
      t.after(() => rm(resolve(profile, '../..'), { recursive: true, force: true }));
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }));
    } },
    '@deepseek-ai/dsh-official-bundles': { PROFILE_TEMPLATES: { web: { bundles: [] } } },
    './desktop-build-paths.mjs': {
      resolveDesktopTargetBuildPaths: () => ({ root, electron: root, dsh: root, runtime: root }),
      desktopTargetPlatform: () => ({ platform: 'darwin', arch: 'arm64' }), resolveDesktopBuildTarget: () => ({}),
    },
    'node:child_process': { spawn: (_command, args) => {
      const child = new EventEmitter(), spec = args.at(-1);
      specs.push(spec);
      queueMicrotask(() => {
        if (spec === publicPlugin.spec) {
          fs.mkdirSync(join(buildProfile, 'node_modules'), { recursive: true });
          fs.writeFileSync(join(buildProfile, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
          fs.writeFileSync(join(buildProfile, 'package.json'), JSON.stringify({ dependencies: { [publicPlugin.name]: publicPlugin.want } }));
          child.emit('close', 0);
        } else child.emit('close', 1);
      });
      return child;
    } },
  };
  await module.link(async (name) => {
    const exports = overrides[name] ?? await import(name.startsWith('../') ? new URL(name, `file://${script}`).href : name);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  assert.deepEqual(specs, plugins.includes(publicPlugin) ? [publicPlugin.spec] : []);
  const bundled = JSON.parse(await readFile(join(root, 'plugin-template/package.json'), 'utf8'));
  assert.deepEqual(bundled.dependencies, plugins.includes(publicPlugin) ? { [publicPlugin.name]: publicPlugin.want } : {});
});

test('only company registry specs require login; local archives and public packages remain bundleable', () => {
  assert.equal(isMarketPlugin(memory), true);
  assert.equal(isMarketPlugin({ ...memory, spec: memory.name }), true);
  for (const plugin of [publicPlugin, { ...memory, spec: 'file:memory.tgz' }, { ...memory, spec: 'https://example.test/memory.tgz' }]) {
    assert.equal(isMarketPlugin(plugin), false);
  }
});

test('a template missing a public plugin still falls back to installation and reports failures without aborting startup', async (t) => {
  const { root, assets, profile, userData } = await fixture(t);
  await writeFile(join(assets, 'plugin-template/package.json'), JSON.stringify({ dependencies: {} }));
  const cliEntry = join(root, 'cli.cjs');
  await writeFile(cliEntry, 'process.exit(1)');
  const result = await prepareCompanyWorkspace({ assets, profile, userData, cliEntry, execPath: process.execPath,
    environment: { ...process.env, CRYSOUND_LLM_BASE: 'https://partner.example.test/_zp/llm/v1', MAGPIE_API_KEY: '' } });
  assert.deepEqual(result.missing, [publicPlugin.name, memory.name]);
  assert.equal(await readFile(join(userData, '.zp-seed-v1'), 'utf8'), '');
});

test('a market-only list starts with an empty template and no bundled lockfile', async (t) => {
  const { root, assets, profile, userData } = await fixture(t);
  await writeFile(join(assets, 'config/plugins.json'), JSON.stringify({ plugins: [memory], defaultBundles: [] }));
  await writeFile(join(assets, 'plugin-template/package.json'), JSON.stringify({ dependencies: {} }));
  await rm(join(assets, 'plugin-template/modules/public-plugin'), { recursive: true });
  await rm(join(assets, 'plugin-template/pnpm-lock.yaml'));
  const cliEntry = join(root, 'cli.cjs');
  await writeFile(cliEntry, 'process.exit(1)');
  const result = await prepareCompanyWorkspace({ assets, profile, userData, cliEntry, execPath: process.execPath,
    environment: { ...process.env, CRYSOUND_LLM_BASE: 'https://partner.example.test/_zp/llm/v1', MAGPIE_API_KEY: '' } });
  assert.deepEqual(result.missing, [memory.name]);
  assert.equal(await readFile(join(userData, '.zp-seed-v1'), 'utf8'), '');
});

test('startup copies the public template, retries a failed market install, and follows a config version update', async (t) => {
  const { root, assets, profile, userData } = await fixture(t);
  const cliEntry = join(root, 'cli.cjs'), calls = join(root, 'calls.jsonl'), allow = join(root, 'allow');
  await writeMarketNpmrc(profile, 'https://partner.example.test', 'test-desktop-token');
  await writeFile(cliEntry, `const fs = require('node:fs'), path = require('node:path');
    const profile = path.join(process.env.DSH_HOME, 'profiles/desktop'), spec = process.argv.at(-1);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(spec) + '\\n');
    if (!spec.startsWith('@crysound/')) process.exit(2);
    const npmrc = fs.readFileSync(path.join(profile, '.npmrc'), 'utf8');
    if (!npmrc.includes('//partner.example.test/_zp/npm/:_authToken=test-desktop-token')) process.exit(3);
    if (!fs.existsSync(${JSON.stringify(allow)})) process.exit(1);
    const manifest = path.join(profile, 'package.json'), m = JSON.parse(fs.readFileSync(manifest));
    m.dependencies['@crysound/memory'] = spec.split('@').at(-1);
    fs.writeFileSync(manifest, JSON.stringify(m));
    process.exit(1); // pnpm may report blocked build scripts after recording the installed version.
  `);
  const options = { assets, profile, userData, cliEntry, execPath: process.execPath,
    environment: { ...process.env, DSH_HOME: join(root, 'home'), CRYSOUND_LLM_BASE: 'https://partner.example.test/_zp/llm/v1', MAGPIE_API_KEY: '' } };
  const first = await prepareCompanyWorkspace(options);
  assert.deepEqual(first.missing, [memory.name]);
  assert.equal(await readFile(join(profile, 'node_modules/public-plugin/index.js'), 'utf8'), 'bundled public plugin');
  assert.equal(await readFile(join(userData, '.zp-seed-v1'), 'utf8'), '');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [memory.spec]);
  await writeFile(allow, '');
  assert.deepEqual((await prepareCompanyWorkspace(options)).missing, []);
  const before = await readFile(calls, 'utf8');
  assert.deepEqual((await prepareCompanyWorkspace(options)).missing, []);
  assert.equal(await readFile(calls, 'utf8'), before, 'already installed versions must not be installed again');
  await writeFile(join(assets, 'config/plugins.json'), JSON.stringify({ plugins: [publicPlugin, { ...memory, spec: '@crysound/memory@0.2.0', want: '0.2.0' }], defaultBundles: ['test-bundle'] }));
  assert.deepEqual((await prepareCompanyWorkspace(options)).missing, []);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[memory.name], '0.2.0');
  assert.deepEqual(manifest.dsh.profile.bundles, ['test-bundle']);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [memory.spec, memory.spec, '@crysound/memory@0.2.0']);
});
