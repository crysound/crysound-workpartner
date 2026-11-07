// Exercise startup against disposable profiles; the CLI adapter replaces package downloads only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePluginPolicy } from '../config/company-plugins.mjs';
import { prepareCompanyWorkspace } from '../../apps/desktop/src/crysound/workspace.ts';

const source = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(source, 'crysound/config/plugins.json'), 'utf8'));
const plugin = config.plugins.find(p => p.name === 'dsh-mnemon');
const old = '@crysound/memory';

for (const platform of ['web', 'desktop']) for (const scenario of ['new', 'upgrade', 'manual']) {
  test(`${platform}: ${scenario} profile enables one Mnemon bundle and keeps settings and old data on repeat`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profile = path.join(root, 'home/profiles', platform), assets = path.join(root, 'assets');
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(path.join(assets, 'config/skills/publish-zhaohua-market'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'feishu'), { recursive: true });
    const file = path.join(profile, 'package.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const save = m => fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    save({ dependencies: { personal: '1.0.0', ...(scenario === 'new' ? {} : { [old]: '0.1.4', 'dsh-slidestudio': '0.2.9' }),
      ...(scenario === 'manual' ? { [plugin.name]: plugin.want } : {}) },
      dsh: { profile: { bundles: ['personal', ...(scenario === 'new' ? [] : [old, 'dsh-slidestudio']), ...(scenario === 'manual' ? [plugin.name] : [])] },
        company: { officialPackages: [old] } } });
    const patch = path.join(profile, 'cordis.patch.yml');
    const settings = scenario === 'manual' ? '- id: mnemon\n  config:\n    idleReviewMs: 45000\n' : '[]\n';
    fs.writeFileSync(patch, settings);
    const data = path.join(root, 'home/crysound-memory');
    fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'facts.json'), 'old memory data');
    if (scenario !== 'new') fs.writeFileSync(path.join(profile, '.zp-retired-market-v1'), '');
    const userData = path.join(root, 'userdata'); fs.mkdirSync(userData);
    if (scenario !== 'new') {
      fs.writeFileSync(path.join(root, 'home/.zp-default-plugins-v1'), '');
      fs.writeFileSync(path.join(userData, '.zp-default-plugins-v1'), '');
    }
    const list = { ...config, plugins: [plugin] };
    fs.writeFileSync(path.join(assets, 'config/plugins.json'), JSON.stringify(list));
    fs.copyFileSync(path.join(source, 'crysound/config/company-plugins.mjs'), path.join(assets, 'config/company-plugins.mjs'));
    // Keep unrelated model, Feishu and lockfile preparation out of these plugin lifecycle cases.
    for (const name of ['config/profile-upgrades.mjs', 'feishu/desktop-setup.mjs', 'plugin-artifacts.mjs']) fs.writeFileSync(path.join(assets, name), '');
    fs.writeFileSync(path.join(assets, 'plugin-artifacts.mjs'), 'export const desktopPlugins = p => p; export const isMarketPlugin = () => false;');
    const calls = path.join(root, 'calls'), cli = path.join(root, 'cli.cjs');
    fs.writeFileSync(cli, `const fs=require('node:fs');
const file=${JSON.stringify(file)}, m=JSON.parse(fs.readFileSync(file)), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args.includes('remove')) { for(const n of args.slice(args.indexOf('remove')+1)) { delete m.dependencies[n]; m.dsh.profile.bundles=m.dsh.profile.bundles.filter(x=>x!==n); } }
else { const spec=args.at(-1), at=spec.lastIndexOf('@'), n=spec.slice(0,at); m.dependencies[n]=spec.slice(at+1); if(!m.dsh.profile.bundles.includes(n)) m.dsh.profile.bundles.push(n); }
fs.writeFileSync(file,JSON.stringify(m,null,2)+'\\n');`);
    const remove = names => {
      const m = read(); for (const n of names) delete m.dependencies[n]; save(m);
    };
    const environment = { ...process.env, DSH_HOME: path.join(root, 'home'), CRYSOUND_LLM_BASE: 'https://partner.example.test/_zp/llm/v1', MAGPIE_API_KEY: '' };
    // A fresh desktop gets this package from the shipped template, without calling plugin add.
    if (platform === 'desktop' && scenario === 'new') {
      fs.mkdirSync(path.join(assets, 'plugin-template/modules'), { recursive: true });
      fs.writeFileSync(path.join(assets, 'plugin-template/package.json'), JSON.stringify({ dependencies: { [plugin.name]: plugin.want } }));
    }
    const run = async () => {
      if (platform === 'desktop') {
        assert.deepEqual((await prepareCompanyWorkspace({ assets, profile, userData, cliEntry: cli, execPath: process.execPath, environment })).missing, []);
      } else {
        const entrypoint = fs.readFileSync(path.join(source, 'crysound/web/entrypoint.sh'), 'utf8');
        const loop = entrypoint.slice(entrypoint.indexOf("node -e '\nconst fs=require"), entrypoint.indexOf('# One-time preinstall'));
        const wrapper = path.join(root, 'dsh');
        fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
        const r = spawnSync('sh', ['-c', loop], { env: { ...environment, CONFIG: path.join(assets, 'config'), PATH: `${root}:${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        preparePluginPolicy(profile, list, remove);
        const defaults = entrypoint.slice(entrypoint.indexOf('DEFAULTS_MARK='), entrypoint.indexOf('# 首次写默认值'));
        const enabled = spawnSync('sh', ['-c', defaults], { env: { ...environment, CONFIG: path.join(assets, 'config'), PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' });
        assert.equal(enabled.status, 0, enabled.stderr);
      }
    };
    await run();
    const first = fs.readFileSync(file, 'utf8');
    const firstCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    await run();
    assert.equal(fs.readFileSync(file, 'utf8'), first);
    assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', firstCalls);
    assert.equal(read().dependencies[plugin.name], '0.5.42');
    assert.equal(read().dsh.profile.bundles.filter(n => n === plugin.name).length, 1);
    assert.equal(read().dependencies[old], undefined);
    assert.ok(!read().dsh.profile.bundles.includes(old));
    assert.ok(!read().dsh.company.officialPackages.includes(old));
    assert.equal(read().dependencies.personal, '1.0.0');
    if (scenario !== 'new') assert.equal(read().dependencies['dsh-slidestudio'], '0.2.9');
    assert.equal(fs.readFileSync(patch, 'utf8'), settings);
    assert.equal(fs.readFileSync(path.join(data, 'facts.json'), 'utf8'), 'old memory data');
    if (scenario === 'manual') assert.ok(!firstCalls.includes('"add"'));
  });
}

test('failed scoped retirement retries without writing its completion marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ dependencies: { [old]: '0.1.4' } }));
  fs.writeFileSync(path.join(root, '.zp-retired-market-v1'), '');
  const marker = path.join(root, '.zp-retired-mnemon-v1');
  assert.throws(() => preparePluginPolicy(root, config, () => { throw new Error('offline'); }), /offline/);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => preparePluginPolicy(root, config, () => {}), /尚未移出/);
  preparePluginPolicy(root, config, names => {
    assert.deepEqual(names, [old]);
    const m = JSON.parse(fs.readFileSync(file, 'utf8')); delete m.dependencies[old];
    fs.writeFileSync(file, JSON.stringify(m));
  });
  assert.equal(fs.existsSync(marker), true);
});
