// Run seed in the old image, then upgrade in the candidate image, sharing only a throwaway /test.
// Both images mount this checkout at /src. Seed requires the crysound.1 archive at /opt/company-plugins.
// node /src/crysound/tests/plugin-install-smoke.mjs seed|upgrade
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FEISHU, WEB_SPEC, DESKTOP_WANT, verifyArchive, desktopPlugins } from '../plugin-artifacts.mjs';

const cli = process.env.DSH_CLI_ENTRY || '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
let require = createRequire(cli);
for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
const yaml = require('yaml');
const root = process.env.PARTNER_TEST_ROOT;
assert.ok(root, 'set PARTNER_TEST_ROOT to an isolated, disposable directory shared by both images');
const oldFile = 'aiwayds-dsh-feishu-0.17.0-crysound.1.tgz';
const oldWeb = `file:/opt/company-plugins/${oldFile}`;
const oldDesktop = `file:company-plugins/${oldFile}`;
const oldRemote = `https://partner-dl.corp.crysound.com/plugins/oqheD9rnauk8nFF3/${oldFile}`;
const cases = ['web-file', 'web-remote-integrity', 'web-remote-no-integrity', 'desktop-file'];
function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function boot(profileName, env, home) {
  const child = spawn('dsh', ['--profile', profileName, '--no-open', '--host', '127.0.0.1', '--port', '3080'], {
    env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', closed = false;
  const finished = new Promise(resolve => {
    child.once('error', error => { output += String(error); closed = true; resolve(); });
    child.once('close', () => { closed = true; resolve(); });
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const deadline = Date.now() + 60_000;
    while (!closed && Date.now() < deadline) {
      if (output.includes('dsh web:') && /dsh-feishu: no Lark credentials/.test(output)) break;
      await delay(100);
    }
    assert.equal(closed, false, output);
    assert.match(output, /dsh web:/);
    // This log is emitted inside plugin apply, after registering the configuration skill.
    // No credentials are supplied, so it loads without opening a real bot connection.
    assert.match(output, /dsh-feishu: no Lark credentials/);
    assert.doesNotMatch(output, /dsh-feishu: (?:startup failed|invalid config)/);
    assert.equal((await fetch('http://127.0.0.1:3080/')).status, 200);
  } finally {
    if (!closed) process.kill(-child.pid, 'SIGTERM');
    await Promise.race([finished, delay(5000)]);
    if (!closed) { process.kill(-child.pid, 'SIGKILL'); await finished; }
    writeFileSync(join(home, 'boot.log'), output);
  }
}
for (const name of cases) {
  // The image CLI reserves desktop for Electron; a custom profile uses the same pnpm path rules.
  const desktop = name.startsWith('desktop'), profileName = desktop ? 'desktop-upgrade' : 'web';
  const home = join(root, name), profile = join(home, 'profiles', profileName), config = join(home, 'config');
  const env = { ...process.env, NODE_OPTIONS: '', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  const dsh = (...args) => run('dsh', args, env);
  if (process.argv[2] === 'seed') {
    mkdirSync(config, { recursive: true });
    dsh('--profile', 'web', '--dump-config');
    if (desktop) {
      cpSync(join(home, 'profiles/web'), profile, { recursive: true });
      mkdirSync(join(profile, 'company-plugins'));
      cpSync(`/opt/company-plugins/${oldFile}`, join(profile, 'company-plugins', oldFile));
    }
    dsh('plugin', '--profile', profileName, 'add', desktop ? oldDesktop : oldWeb);
    // Keep a real unrelated dependency and the plugin's saved selection throughout migration.
    dsh('plugin', '--profile', profileName, 'add', 'is-number@7.0.0');
    assert.equal(JSON.parse(readFileSync(join(profile, 'node_modules', FEISHU.name, 'package.json'))).version, '0.17.0-crysound.1');
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
    writeFileSync(join(home, 'selection.json'), JSON.stringify(manifest.dsh));
    if (name.includes('remote')) {
      for (const file of ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
        const path = join(profile, file);
        const text = readFileSync(path, 'utf8').replaceAll(oldWeb, oldRemote);
        if (file.endsWith('.yaml')) {
          const lock = yaml.parseDocument(text);
          for (const { value } of lock.get('packages', true).items) {
            if (yaml.isMap(value) && value.getIn(['resolution', 'tarball']) === oldRemote && name.endsWith('no-integrity')) value.get('resolution', true).delete('integrity');
          }
          writeFileSync(path, String(lock));
        } else writeFileSync(path, text);
      }
    }
    console.log(`PASS seed: ${name} really installed crysound.1`);
    continue;
  }
  assert.equal(process.argv[2], 'upgrade');
  assert.ok(!existsSync(oldWeb.slice(5)), 'candidate image must not contain crysound.1');
  const want = desktop ? DESKTOP_WANT : WEB_SPEC;
  verifyArchive(readFileSync(WEB_SPEC.slice(5)));
  if (desktop) {
    desktopPlugins([{ name: FEISHU.name, spec: WEB_SPEC, want: WEB_SPEC }], '/opt/company-plugins', profile);
    // Also cover a profile whose old archive was removed during packaging/cleanup.
    rmSync(join(profile, 'company-plugins', oldFile), { force: true });
  }
  writeFileSync(join(config, 'plugins.json'), JSON.stringify({ plugins: [{ name: FEISHU.name, spec: WEB_SPEC, want: WEB_SPEC }] }));
  const entrypoint = readFileSync(new URL('../web/entrypoint.sh', import.meta.url), 'utf8');
  const installSection = entrypoint.slice(entrypoint.indexOf('# 旧远程'), entrypoint.indexOf('# 第三方'));
  const installScript = join(home, 'install.sh');
  writeFileSync(installScript, installSection);
  for (let repeat = 0; repeat < 2; repeat++) {
    if (desktop) {
      run(process.execPath, ['/opt/partner/plugin-artifacts.mjs', 'repair', profile, cli, want], env);
      if (JSON.parse(readFileSync(join(profile, 'package.json'))).dependencies[FEISHU.name] !== want) dsh('plugin', '--profile', profileName, 'add', want);
    } else {
      assert.doesNotMatch(run('sh', [installScript], { ...env, CONFIG: config }), /安装失败/);
    }
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
    assert.equal(manifest.dependencies[FEISHU.name], want);
    assert.equal(manifest.dependencies['is-number'], '7.0.0');
    assert.deepEqual(manifest.dsh, JSON.parse(readFileSync(join(home, 'selection.json'))));
    assert.equal(JSON.parse(readFileSync(join(profile, 'node_modules', FEISHU.name, 'package.json'))).version, '0.17.0-crysound.2');
    for (const file of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
      const text = readFileSync(join(profile, file), 'utf8');
      assert.ok(!text.includes(oldFile));
      const entries = Object.values(yaml.parse(text).packages).filter(pkg => pkg.resolution?.tarball?.endsWith(FEISHU.file));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].resolution.integrity, FEISHU.integrity);
    }
    // Config composition retains the selected Feishu bundle.
    const dump = dsh('--profile', profileName, '--dump-config');
    assert.match(dump, /aiwayds\/dsh-feishu/);
  }
  await boot(profileName, env, home);
  dsh('plugin', '--profile', profileName, 'add', 'is-odd@3.0.1');
  dsh('plugin', '--profile', profileName, 'remove', 'is-odd');
  console.log(`PASS upgrade: ${name} → crysound.2, locks/config/other plugin retained, composition twice, real plugin apply + HTTP ready, subsequent add/remove`);
}
