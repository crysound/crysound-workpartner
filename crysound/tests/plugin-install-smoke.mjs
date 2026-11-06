// Delivery-only: run with the rebuilt image's dsh/pnpm, never against a live user's profile.
// node crysound/tests/plugin-install-smoke.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FEISHU, WEB_SPEC, verifyArchive } from '../plugin-artifacts.mjs';

const cli = process.env.DSH_CLI_ENTRY || '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
let require = createRequire(cli);
for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
const yaml = require('yaml');
const root = mkdtempSync(join(tmpdir(), 'partner-plugin-install-'));
verifyArchive(readFileSync(WEB_SPEC.slice(5)));
const entrypoint = readFileSync(new URL('../web/entrypoint.sh', import.meta.url), 'utf8');
const installSection = entrypoint.slice(entrypoint.indexOf('# 旧远程'), entrypoint.indexOf('# 第三方'));
const installScript = join(root, 'install.sh');
writeFileSync(installScript, installSection);
function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  for (const hadIntegrity of [true, false]) {
    const home = join(root, String(hadIntegrity)), profile = join(home, 'profiles/web'), config = join(home, 'config');
    const env = { ...process.env, NODE_OPTIONS: '', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'plugins.json'), JSON.stringify({ plugins: [{ name: FEISHU.name, spec: WEB_SPEC, want: WEB_SPEC }] }));
    const dsh = (...args) => run('dsh', args, env);
    dsh('--profile', 'web', '--dump-config');
    dsh('plugin', '--profile', 'web', 'add', WEB_SPEC);
    // Recreate the old remote release in both pnpm locks, keeping the real resolved dependency graph.
    for (const file of ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
      const path = join(profile, file);
      let text;
      try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT' && file.startsWith('node_modules/')) continue; throw error; }
      text = text.replaceAll(WEB_SPEC, FEISHU.url);
      if (file.endsWith('.yaml')) {
        const document = yaml.parseDocument(text);
        const packages = document.get('packages', true);
        if (yaml.isMap(packages)) for (const { value } of packages.items) {
          if (!yaml.isMap(value)) continue;
          const resolution = value.get('resolution', true);
          if (yaml.isMap(resolution) && resolution.get('tarball') === FEISHU.url) {
            if (hadIntegrity) resolution.set('integrity', FEISHU.integrity);
            else resolution.delete('integrity');
          }
        }
        text = String(document);
      }
      writeFileSync(path, text);
    }
    const check = () => {
      assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'))).dependencies[FEISHU.name], WEB_SPEC);
      const text = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8');
      assert.ok(!text.includes(FEISHU.url), 'remote release is gone');
      const lock = yaml.parse(text);
      const entries = Object.values(lock.packages).filter(pkg => pkg.resolution?.tarball === WEB_SPEC);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].resolution.integrity, FEISHU.integrity);
    };
    // Execute the exact entrypoint migration and install loop twice.
    for (let repeat = 0; repeat < 2; repeat++) {
      const output = run('sh', [installScript], { ...env, CONFIG: config });
      assert.doesNotMatch(output, /安装失败/);
      check();
    }
    dsh('plugin', '--profile', 'web', 'add', 'is-number@7.0.0'); check();
    dsh('plugin', '--profile', 'web', 'add', 'is-odd@3.0.1'); check();
    dsh('plugin', '--profile', 'web', 'remove', 'is-odd'); check();
    console.log(`PASS: old lock ${hadIntegrity ? 'with' : 'without'} integrity → entrypoint twice → add → add → remove; local integrity retained`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
