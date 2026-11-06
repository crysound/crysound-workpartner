// Node 24; uses an existing yaml installation, with no dependency installation or image build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { FEISHU, WEB_SPEC, DESKTOP_WANT, verifyArchive, desktopPlugins, repairLockfile } from '../plugin-artifacts.mjs';
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
function oldLock(integrity) {
  return yaml.stringify({
    lockfileVersion: '9.0',
    packages: {
      [FEISHU.url]: { resolution: { tarball: FEISHU.url, ...(integrity ? { integrity: FEISHU.integrity } : {}) } },
      unrelated: { resolution: { tarball: 'https://example.test/other.tgz' } },
    },
  });
}

test('rejects incomplete or changed archives', () => {
  assert.throws(() => verifyArchive(Buffer.from('broken')), /checksum mismatch/);
});

for (const integrity of [true, false]) test(`old remote lock (${integrity ? 'with' : 'without'} integrity) is repaired once without changing other packages`, (t) => {
  const directory = temp(t), file = join(directory, 'pnpm-lock.yaml');
  writeFileSync(file, oldLock(integrity));
  repairLockfile(file, yaml);
  const first = readFileSync(file, 'utf8'), packages = yaml.parse(first).packages;
  assert.equal(packages[FEISHU.url].resolution.integrity, FEISHU.integrity);
  assert.deepEqual(packages.unrelated.resolution, { tarball: 'https://example.test/other.tgz' });
  if (integrity) assert.equal(first, oldLock(true));
  repairLockfile(file, yaml);
  assert.equal(readFileSync(file, 'utf8'), first);
});

test('invalid YAML and unexpected checksums leave the old lock untouched', (t) => {
  const directory = temp(t), file = join(directory, 'pnpm-lock.yaml');
  for (const text of [`packages: [\n# ${FEISHU.url}\n`, oldLock(true).replace(FEISHU.integrity, 'sha512-unexpected')]) {
    writeFileSync(file, text);
    assert.throws(() => repairLockfile(file, yaml));
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('web plugin startup repairs both locks before replacing the remote dependency', { skip: process.platform === 'win32' ? 'container entrypoint uses a POSIX shell' : false }, (t) => {
  const directory = temp(t), profile = join(directory, 'profiles/web');
  mkdirSync(join(profile, 'node_modules/.pnpm'), { recursive: true });
  const config = join(directory, 'config'), bin = join(directory, 'bin');
  mkdirSync(config); mkdirSync(bin);
  writeFileSync(join(config, 'plugins.json'), JSON.stringify({ plugins: [plugin] }));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [FEISHU.name]: FEISHU.url } }));
  for (const lock of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) writeFileSync(join(profile, lock), oldLock(false));
  // The installer only checks call order; real dsh/pnpm add/remove is covered by plugin-install-smoke.mjs.
  const cli = join(bin, 'cli.mjs');
  writeFileSync(cli, `import fs from 'node:fs';
    const p = process.env.DSH_HOME + '/profiles/web';
    for (const lock of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
      if (!fs.readFileSync(p + '/' + lock, 'utf8').includes(${JSON.stringify(FEISHU.integrity)})) process.exit(4);
    }
    if (process.argv.at(-1) !== ${JSON.stringify(WEB_SPEC)}) process.exit(5);
    fs.writeFileSync(p + '/package.json', JSON.stringify({dependencies:{${JSON.stringify(FEISHU.name)}:${JSON.stringify(WEB_SPEC)}}}, null, 2));
    fs.appendFileSync(p + '/calls', 'add\\n');`);
  writeFileSync(join(bin, 'dsh'), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
  const modules = join(bin, 'node_modules');
  for (const name of ['dsh', 'dsh-base', 'dsh-config-editor']) {
    const packageDir = join(modules, '@deepseek-ai', name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}` }));
  }
  symlinkSync(require.resolve(process.env.PARTNER_YAML_PACKAGE || 'yaml'), join(modules, 'yaml.cjs'));
  // Let the repair CLI use this test's existing YAML package through a local package link.
  mkdirSync(join(modules, 'yaml'));
  writeFileSync(join(modules, 'yaml', 'package.json'), JSON.stringify({ main: '../yaml.cjs' }));
  const entrypoint = readFileSync(join(assets, 'web/entrypoint.sh'), 'utf8');
  const section = entrypoint.slice(entrypoint.indexOf('# 旧远程'), entrypoint.indexOf('# 第三方'))
    .replace('/opt/partner/plugin-artifacts.mjs', join(assets, 'plugin-artifacts.mjs'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: directory };
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('sh', ['-c', `CONFIG='${config}'\n${section}`], { env, encoding: 'utf8', timeout: 10000 });
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

for (const template of [false, true]) test(`desktop preparation ${template ? 'copies the offline template' : 'installs from its local archive'} and repeats without reinstalling`, { skip: !archive }, async (t) => {
  const directory = temp(t), packaged = join(directory, 'packaged'), profile = join(directory, 'home/profiles/desktop'), userData = join(directory, 'userData');
  mkdirSync(join(packaged, 'config/skills/publish-zhaohua-market'), { recursive: true });
  mkdirSync(join(packaged, 'feishu')); mkdirSync(join(packaged, 'company-plugins')); mkdirSync(profile, { recursive: true });
  cpSync(archive, join(packaged, 'company-plugins', FEISHU.file));
  cpSync(join(assets, 'plugin-artifacts.mjs'), join(packaged, 'plugin-artifacts.mjs'));
  writeFileSync(join(packaged, 'config/plugins.json'), JSON.stringify({ plugins: [plugin], defaultBundles: [] }));
  writeFileSync(join(packaged, 'config/skills/publish-zhaohua-market/SKILL.md'), '# test\n');
  for (const script of ['config/profile-upgrades.mjs', 'feishu/desktop-setup.mjs']) writeFileSync(join(packaged, script), 'process.exit(0)\n');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: template ? {} : { [FEISHU.name]: FEISHU.url } }));
  const cli = join(directory, 'cli.cjs'), calls = join(directory, 'calls');
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
  const options = { assets: packaged, profile, userData, cliEntry: cli, execPath: process.execPath,
    environment: { ...process.env, CRYSOUND_LLM_BASE: 'https://partner.example.test/v1', MAGPIE_API_KEY: '' } };
  assert.deepEqual(await prepareCompanyWorkspace(options), { missing: [] });
  assert.deepEqual(await prepareCompanyWorkspace(options), { missing: [] });
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'))).dependencies[FEISHU.name], DESKTOP_WANT);
  assert.equal(existsSync(calls), !template);
  if (!template) assert.equal(readFileSync(calls, 'utf8'), 'add\n');
  verifyArchive(readFileSync(join(profile, 'company-plugins', FEISHU.file)));
});
