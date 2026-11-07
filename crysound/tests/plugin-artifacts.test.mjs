// Node 24; uses an existing yaml installation, with no dependency installation or image build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FEISHU, WEB_SPEC, DESKTOP_WANT, verifyArchive, desktopPlugins, repairProfile } from '../plugin-artifacts.mjs';
import { prepareCompanyWorkspace } from '../../apps/desktop/src/crysound/workspace.ts';

const assets = resolve(import.meta.dirname, '..');
const archive = process.env.PARTNER_FEISHU_ARCHIVE;
let require = createRequire(process.env.DSH_CLI_ENTRY || import.meta.url);
if (!process.env.PARTNER_YAML_PACKAGE) {
  for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
}
const yaml = require(process.env.PARTNER_YAML_PACKAGE || 'yaml');
const plugin = { name: FEISHU.name, spec: WEB_SPEC, want: WEB_SPEC };
function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'partner-artifacts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeYamlResolver(directory) {
  const modules = join(directory, 'node_modules');
  for (const name of ['dsh', 'dsh-base', 'dsh-config-editor']) {
    const packageDir = join(modules, '@deepseek-ai', name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}` }));
  }
  symlinkSync(require.resolve(process.env.PARTNER_YAML_PACKAGE || 'yaml'), join(modules, 'yaml.cjs'));
  mkdirSync(join(modules, 'yaml'));
  writeFileSync(join(modules, 'yaml', 'package.json'), JSON.stringify({ main: '../yaml.cjs' }));
}
const oldFile = 'aiwayds-dsh-feishu-0.17.0-crysound.1.tgz';
const oldRemote = `https://partner-dl.corp.crysound.com/plugins/old-release/${oldFile}`;
function oldLock(spec, integrity = false) {
  const id = `${FEISHU.name}@${spec}`;
  return yaml.stringify({
    lockfileVersion: '9.0',
    importers: { '.': { dependencies: { [FEISHU.name]: { specifier: spec, version: id }, other: { specifier: '1', version: '1' } } } },
    packages: {
      [id]: { resolution: { tarball: spec, ...(integrity ? { integrity: 'sha512-old' } : {}) } },
      unrelated: { resolution: { tarball: 'https://example.test/other.tgz' } },
    },
    snapshots: { [`${id}(peer@1)`]: { dependencies: { other: '1' } }, unrelated: {} },
  });
}

test('rejects incomplete or changed archives', () => {
  assert.throws(() => verifyArchive(Buffer.from('broken')), /checksum mismatch/);
});

for (const want of [WEB_SPEC, DESKTOP_WANT]) for (const spec of [
  `file:/opt/company-plugins/${oldFile}`, `file:company-plugins/${oldFile}`, oldRemote, FEISHU.url,
  'file:/opt/company-plugins/aiwayds-dsh-feishu-0.1.0-crysound.42.tgz',
]) for (const integrity of [true, false]) test(`repairs ${spec} → ${want} (${integrity ? 'with' : 'without'} integrity) without changing other plugins or configuration`, (t) => {
  const directory = temp(t);
  mkdirSync(join(directory, 'node_modules/.pnpm'), { recursive: true });
  const manifest = { dependencies: { [FEISHU.name]: spec, other: '1' }, dsh: { profile: { bundles: [FEISHU.name] } } };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  for (const file of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) writeFileSync(join(directory, file), oldLock(spec, integrity));
  repairProfile(directory, yaml, want);
  const updated = JSON.parse(readFileSync(join(directory, 'package.json')));
  assert.deepEqual(updated, { ...manifest, dependencies: { other: '1' } });
  for (const file of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
    const lock = yaml.parse(readFileSync(join(directory, file), 'utf8'));
    assert.deepEqual(lock.importers['.'].dependencies, { other: { specifier: '1', version: '1' } });
    assert.deepEqual(lock.packages, { unrelated: { resolution: { tarball: 'https://example.test/other.tgz' } } });
    assert.deepEqual(lock.snapshots, { unrelated: {} });
  }
  const files = ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'];
  const first = files.map(file => readFileSync(join(directory, file), 'utf8'));
  repairProfile(directory, yaml, want);
  assert.deepEqual(files.map(file => readFileSync(join(directory, file), 'utf8')), first);
});

for (const spec of [WEB_SPEC, 'https://example.test/aiwayds-dsh-feishu-other.tgz', '1.0.0']) test(`keeps current or non-company dependency ${spec}`, (t) => {
  const directory = temp(t);
  const manifest = JSON.stringify({ dependencies: { [FEISHU.name]: spec } });
  writeFileSync(join(directory, 'package.json'), manifest);
  writeFileSync(join(directory, 'pnpm-lock.yaml'), oldLock(spec));
  repairProfile(directory, yaml);
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), manifest);
  assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), oldLock(spec));
});

test('invalid YAML in the second lock leaves every profile file untouched', (t) => {
  const directory = temp(t);
  mkdirSync(join(directory, 'node_modules/.pnpm'), { recursive: true });
  const files = ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'];
  const contents = [JSON.stringify({ dependencies: { [FEISHU.name]: oldRemote } }), oldLock(oldRemote), 'packages: ['];
  files.forEach((file, i) => writeFileSync(join(directory, file), contents[i]));
  assert.throws(() => repairProfile(directory, yaml));
  assert.deepEqual(files.map(file => readFileSync(join(directory, file), 'utf8')), contents);
});

test('web plugin startup repairs both locks before replacing the remote dependency', { skip: process.platform === 'win32' ? 'container entrypoint uses a POSIX shell' : false }, (t) => {
  const directory = join(temp(t), "web install 'quoted'"), profile = join(directory, 'profiles/web');
  mkdirSync(join(profile, 'node_modules/.pnpm'), { recursive: true });
  const config = join(directory, 'config'), bin = join(directory, 'bin');
  mkdirSync(config); mkdirSync(bin);
  cpSync(join(assets, 'config/company-plugins.mjs'), join(config, 'company-plugins.mjs'));
  writeFileSync(join(config, 'plugins.json'), JSON.stringify({ plugins: [plugin] }));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [FEISHU.name]: FEISHU.url } }));
  for (const lock of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) writeFileSync(join(profile, lock), oldLock(oldRemote));
  // The installer only checks call order; real dsh/pnpm add/remove is covered by plugin-install-smoke.mjs.
  const cli = join(bin, 'dsh');
  writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';
    const p = process.env.DSH_HOME + '/profiles/web';
    for (const lock of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
      if (fs.readFileSync(p + '/' + lock, 'utf8').includes(${JSON.stringify(oldRemote)})) process.exit(4);
    }
    if (process.argv.at(-1) !== ${JSON.stringify(WEB_SPEC)}) process.exit(5);
    fs.writeFileSync(p + '/package.json', JSON.stringify({dependencies:{${JSON.stringify(FEISHU.name)}:${JSON.stringify(WEB_SPEC)}}}, null, 2));
    fs.appendFileSync(p + '/calls', 'add\\n');`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  fakeYamlResolver(bin);
  const helper = join(directory, 'plugin-artifacts.mjs');
  cpSync(join(assets, 'plugin-artifacts.mjs'), helper);
  const entrypoint = readFileSync(join(assets, 'web/entrypoint.sh'), 'utf8');
  const section = entrypoint.slice(entrypoint.indexOf('# 旧远程'), entrypoint.indexOf('# 第三方'))
    .replace('/opt/partner/plugin-artifacts.mjs', '"$PARTNER_TEST_ARTIFACTS"');
  const script = join(directory, 'install.sh');
  writeFileSync(script, section);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: directory, CONFIG: config, PARTNER_TEST_ARTIFACTS: helper };
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('sh', [script], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /安装失败/);
  }
  assert.equal(readFileSync(join(profile, 'calls'), 'utf8'), 'add\n');
});

test('desktop stages a verified local archive for web and legacy gateway specs; repeat staging keeps the same dependency', { skip: !archive }, (t) => {
  const directory = temp(t), resources = join(directory, 'resources'), profile = join(directory, 'profile with spaces');
  mkdirSync(resources); cpSync(archive, join(resources, FEISHU.file));
  for (const spec of [WEB_SPEC, FEISHU.url]) {
    const [resolved] = desktopPlugins([{ ...plugin, spec, want: spec }], resources, profile);
    assert.equal(resolved.want, DESKTOP_WANT);
    assert.equal(resolved.spec, DESKTOP_WANT);
    verifyArchive(readFileSync(join(profile, resolved.want.slice(5))));
    assert.deepEqual(desktopPlugins([{ ...plugin, spec, want: spec }], resources, profile), [resolved]);
  }
  const other = { name: 'another-plugin', spec: 'another-plugin@1', want: '1' };
  assert.deepEqual(desktopPlugins([other], resources, profile), [other]);
});

test('desktop refuses a damaged bundled archive before changing the profile copy', { skip: !archive }, (t) => {
  const directory = temp(t), resources = join(directory, 'resources'), profile = join(directory, 'profile');
  mkdirSync(resources); cpSync(archive, join(resources, FEISHU.file));
  desktopPlugins([plugin], resources, profile);
  const target = join(profile, 'company-plugins', FEISHU.file), before = readFileSync(target);
  writeFileSync(join(resources, FEISHU.file), 'truncated archive');
  assert.throws(() => desktopPlugins([plugin], resources, profile), /checksum mismatch/);
  assert.deepEqual(readFileSync(target), before);
});

for (const [template, emitted] of [[false, false], [true, false], [true, true]]) test(`desktop preparation ${emitted ? 'from the emitted directory ' : ''}${template ? 'copies the offline template' : 'installs from its local archive'} and repeats without reinstalling`, { skip: !archive }, async (t) => {
  const directory = temp(t), packaged = join(directory, 'packaged'), profile = join(directory, 'home/profiles/desktop'), userData = join(directory, 'userData');
  mkdirSync(join(packaged, 'config/skills/publish-zhaohua-market'), { recursive: true });
  mkdirSync(join(packaged, 'feishu')); mkdirSync(join(packaged, 'company-plugins')); mkdirSync(profile, { recursive: true });
  cpSync(archive, join(packaged, 'company-plugins', FEISHU.file));
  cpSync(join(assets, 'plugin-artifacts.mjs'), join(packaged, 'plugin-artifacts.mjs'));
  cpSync(join(assets, 'config/company-plugins.mjs'), join(packaged, 'config/company-plugins.mjs'));
  writeFileSync(join(packaged, 'config/plugins.json'), JSON.stringify({ plugins: [plugin], defaultBundles: [] }));
  writeFileSync(join(packaged, 'config/skills/publish-zhaohua-market/SKILL.md'), '# test\n');
  for (const script of ['config/profile-upgrades.mjs', 'feishu/desktop-setup.mjs']) writeFileSync(join(packaged, script), 'process.exit(0)\n');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: template ? {} : { [FEISHU.name]: FEISHU.url } }));
  const cli = join(directory, 'cli.cjs'), calls = join(directory, 'calls');
  fakeYamlResolver(directory);
  writeFileSync(cli, `const fs = require('node:fs');
    const p=${JSON.stringify(profile)}, spec=process.argv.at(-1);
    if (spec !== ${JSON.stringify(DESKTOP_WANT)}) process.exit(3);
    if (!fs.existsSync(p + '/' + spec.slice(5))) process.exit(4);
    fs.writeFileSync(p + '/package.json', JSON.stringify({dependencies:{${JSON.stringify(FEISHU.name)}:${JSON.stringify(DESKTOP_WANT)}}}));
    fs.appendFileSync(${JSON.stringify(calls)}, 'add\\n');`);
  if (template) {
    const base = join(packaged, 'plugin-template');
    mkdirSync(join(base, 'modules', FEISHU.name), { recursive: true });
    writeFileSync(join(base, 'modules', FEISHU.name, 'package.json'), '{}');
    writeFileSync(join(base, 'package.json'), JSON.stringify({ dependencies: { [FEISHU.name]: DESKTOP_WANT } }));
    writeFileSync(join(base, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# ${DESKTOP_WANT}\n`);
  }
  let prepare = prepareCompanyWorkspace;
  if (emitted) {
    const output = join(directory, 'apps/desktop/lib/types/crysound');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const file of ['workspace', 'company-config']) {
      const source = readFileSync(new URL(`../../apps/desktop/src/crysound/${file}.ts`, import.meta.url), 'utf8');
      const javascript = stripTypeScriptTypes(source).replace("'./company-config.ts'", "'./company-config.js'");
      writeFileSync(join(output, `${file}.js`), javascript);
    }
    prepare = (await import(pathToFileURL(join(output, 'workspace.js')).href)).prepareCompanyWorkspace;
  }
  const options = { assets: packaged, profile, userData, cliEntry: cli, execPath: process.execPath,
    environment: { ...process.env, CRYSOUND_LLM_BASE: 'https://partner.example.test/v1', MAGPIE_API_KEY: '' } };
  assert.deepEqual(await prepare(options), { missing: [] });
  assert.deepEqual(await prepare(options), { missing: [] });
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'))).dependencies[FEISHU.name], DESKTOP_WANT);
  assert.equal(existsSync(calls), !template);
  if (!template) assert.equal(readFileSync(calls, 'utf8'), 'add\n');
  verifyArchive(readFileSync(join(profile, 'company-plugins', FEISHU.file)));
});
