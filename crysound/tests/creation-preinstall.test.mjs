// Run the shipped web install loop in a disposable profile, without downloading packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'crysound/config/plugins.json'), 'utf8'));
const creation = config.plugins.filter(p => p.missingOnly);

test('web fills six missing creation plugins, preserves installed versions and files, and retries only failures', t => {
  assert.equal(creation.length, 6);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-web-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profiles/web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ plugins: creation }));
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
  fs.writeFileSync(path.join(profile, 'work.txt'), 'existing work');
  const installer = path.join(dir, 'dsh');
  fs.writeFileSync(installer, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const spec=process.argv.at(-1), cut=spec.lastIndexOf('@'), name=spec.slice(0,cut);
fs.appendFileSync(path.join(process.env.DSH_HOME,'calls'),name+'\\n');
if(name==='@crysound/motion'&&!fs.existsSync(path.join(process.env.DSH_HOME,'allow')))process.exit(1);
const file=path.join(process.env.DSH_HOME,'profiles/web/package.json'),m=JSON.parse(fs.readFileSync(file));
m.dependencies[name]=spec.slice(cut+1); fs.writeFileSync(file,JSON.stringify(m));
`, { mode: 0o700 });
  const entry = fs.readFileSync(path.join(root, 'crysound/web/entrypoint.sh'), 'utf8');
  const loop = entry.slice(entry.indexOf('# Pinned plugins'), entry.indexOf('# One-time preinstall'));
  const run = () => {
    const result = spawnSync('sh', ['-c', loop], { encoding: 'utf8', env: { ...process.env, CONFIG: dir, DSH_HOME: dir, PATH: `${dir}:${path.dirname(process.execPath)}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
  };
  run();
  const read = () => JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(Object.keys(read().dependencies).length, 5);
  const m = read(); m.dependencies['@crysound/design'] = '9.0.0'; m.dependencies['@crysound/slides'] = '0.0.1';
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'allow'), '');
  run();
  assert.equal(Object.keys(read().dependencies).length, 6);
  assert.equal(read().dependencies['@crysound/design'], '9.0.0');
  assert.equal(read().dependencies['@crysound/slides'], '0.0.1');
  assert.deepEqual(read().dsh.profile.bundles, []);
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8');
  run();
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), calls);
  assert.equal(calls.trim().split('\n').length, 7);
  assert.equal(fs.readFileSync(path.join(profile, 'work.txt'), 'utf8'), 'existing work');
});

test('published artifacts client page copy is patched completely and idempotently without changing storage or market metadata', t => {
  const source = process.env.ARTIFACTS_CLIENT;
  assert.ok(source, 'ARTIFACTS_CLIENT must point to published @crysound/artifacts 1.0.0 lib/client.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, '@crysound/artifacts');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  const before = fs.readFileSync(source, 'utf8');
  assert.ok(before.includes('兆华作品'));
  fs.writeFileSync(path.join(plugin, 'lib/client.js'), before);
  const market = JSON.stringify({ displayName: '兆华作品' });
  fs.writeFileSync(path.join(plugin, 'package.json'), market);
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(root, 'crysound/config/plugin-patches.mjs'), dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  };
  run();
  const after = fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8');
  assert.equal(after, before.replaceAll('兆华作品', '作品'));
  assert.ok(!after.includes('兆华作品'));
  new vm.Script(after);
  run();
  assert.equal(fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8'), after);
  assert.equal(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'), market);
});
