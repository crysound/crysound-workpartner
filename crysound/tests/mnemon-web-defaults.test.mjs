// Run with the pinned DSH runtime, published Mnemon fixtures and bundled native CLI; no model requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refreshProfile, initializeWebMemory } from '../config/profile-upgrades.mjs';

const runtime = process.env.DSH_CLI_ENTRY || '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
let require = createRequire(runtime);
for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
const yaml = require('yaml');
const seed = path.resolve(import.meta.dirname, '../config/partner.patch.yml');
const modules = process.env.MNEMON_TEST_MODULES;
const cli = process.env.MNEMON_TEST_CLI;
const load = specifier => import(pathToFileURL(createRequire(path.join(modules, '../package.json')).resolve(specifier)).href);

function fixture(t, text = '[]\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-web-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-mnemon'] } } }));
  if (modules) fs.symlinkSync(modules, path.join(profile, 'node_modules'), 'dir');
  const file = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(file, text);
  const data = path.join(root, 'memory');
  const env = { PATH: cli ? path.dirname(cli) : '', HOME: root, MNEMON_DATA_DIR: data };
  return { root, profile, file, data, env };
}

test('Web refresh grants trusted management with an override and preserves personal settings on repeat', t => {
  for (const text of ['[]\n', '- id: mnemon\n  config:\n    remoteAccess: read-only\n    idleReviewMs: 60000\n    idleReview:\n      agentTeams: pause\n']) {
    const f = fixture(t, text);
    refreshProfile(f.file, seed, yaml, false, true);
    const first = fs.readFileSync(f.file, 'utf8');
    const rows = yaml.parse(first, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    const row = rows.findLast(row => row.id === 'mnemon');
    assert.equal(row.config.remoteAccess, 'trusted-host');
    assert.equal(row.name, undefined);
    assert.ok(!rows.some(row => row.insert?.some(entry => entry.id?.startsWith('mnemon'))));
    if (text !== '[]\n') {
      assert.equal(row.config.idleReviewMs, 60000);
      assert.equal(row.config.idleReview.agentTeams, 'pause');
    } else assert.equal(row.config.idleReview, undefined);
    refreshProfile(f.file, seed, yaml, false, true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), first);
  }
});

test('desktop refresh leaves memory access and idle review choices unchanged', t => {
  for (const text of ['[]\n', '- id: mnemon\n  config:\n    remoteAccess: read-only\n    idleReview:\n      agentTeams: scoped\n']) {
    const f = fixture(t, text);
    refreshProfile(f.file, seed, yaml, true, false);
    const rows = yaml.parse(fs.readFileSync(f.file, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    assert.deepEqual(rows.find(row => row.id === 'mnemon'), yaml.parse(text)[0]);
    assert.ok(!fs.existsSync(path.join(f.profile, '.zp-personal-memory-v1')));
  }
});

test('startup creates one Native space, real Source discovers it active and a new Source recalls its fact', { skip: !modules || !cli }, async t => {
  const f = fixture(t);
  await initializeWebMemory(f.file, yaml, f.env);
  const db = path.join(f.data, 'data/personal/mnemon.db');
  assert.ok(fs.existsSync(db));
  const before = fs.statSync(db).mtimeMs;
  await initializeWebMemory(f.file, yaml, f.env);
  assert.equal(fs.statSync(db).mtimeMs, before);

  const { MemoryCompositionRunner } = await load('dsh-mnemon/testing');
  const spaces = await load('dsh-mnemon-source-memory-spaces');
  const strategy = await load('dsh-mnemon-strategy-default-three-tier');
  async function open() {
    const runner = new MemoryCompositionRunner({ sourceConfiguration: () => ({ dataDir: f.data, cliPath: cli }) });
    t.after(() => runner.dispose());
    await runner.mount(spaces, { instanceId: 'spaces', config: { dataDir: f.data, cliPath: cli, providers: [{ use: 'dsh-mnemon-provider-mnemon-native', instanceId: 'mnemon-native' }] } });
    await runner.mount(strategy, { instanceId: 'layered' });
    const catalog = await runner.managementCatalog();
    const source = catalog.sources.find(source => source.sourceTypeId === 'memory-spaces');
    return { runner, client: await runner.managementClient(source.sourceInstanceKey) };
  }
  const first = await open();
  const catalog = (await first.client.read('bodies')).value;
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].id, 'personal');
  assert.equal(catalog.items[0].active, true);
  assert.equal(catalog.items[0].provider.id, 'mnemon-native');
  await first.client.mutate('remember', { memoryBodyId: 'personal', content: 'BootstrapAlbatross prefers green tea', category: 'fact' }, { confirmed: true });
  await first.runner.dispose();
  const second = await open();
  const recalled = await second.client.read('search', { query: 'BootstrapAlbatross', memoryBodyId: 'personal' });
  assert.match(JSON.stringify(recalled.value), /BootstrapAlbatross prefers green tea/);
  const turn = await second.runner.beginTurn();
  try {
    const recall = turn.view.routes.find(route => route.sourceRouteId === 'recall');
    assert.ok(recall, 'the active personal space offers recall to the model View');
    const evidence = await turn.executeRoute(recall.id, { query: 'BootstrapAlbatross', mode: 'basic' });
    assert.match(JSON.stringify(evidence), /BootstrapAlbatross prefers green tea/);
  } finally { turn.release(); }
  await second.runner.dispose();
  // A person deleting the default later must not have it recreated at every restart.
  fs.rmSync(path.join(f.data, 'data/personal'), { recursive: true });
  await initializeWebMemory(f.file, yaml, f.env);
  assert.ok(!fs.existsSync(db));
});

test('startup preserves existing spaces, personal scopes and failed creation for retry', { skip: !modules || !cli }, async t => {
  const configs = ['- id: mnemon\n  config:\n    storageScope: workspace\n', '- id: mnemon\n  config:\n    dataDir: /personal/memory\n', '- id: mnemon\n  disabled: true\n', '- id: mnemon\n  config:\n    storageScope: !!js process.env.MY_SCOPE\n'];
  for (const config of configs) {
    const f = fixture(t, config);
    await initializeWebMemory(f.file, yaml, f.env);
    assert.ok(!fs.existsSync(f.data));
  }
  for (const [relative, value] of [
    ['data/.dsh-memory-bodies.json', { version: 1, bodies: [{ id: 'mine', active: false }] }],
    ['state/memory-providers.json', { version: 4, services: {}, bodies: [{ id: 'remote', providerId: 'mem0', active: false }] }],
  ]) {
    const f = fixture(t);
    const file = path.join(f.data, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = JSON.stringify(value);
    fs.writeFileSync(file, before);
    await initializeWebMemory(f.file, yaml, f.env);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(f.data, 'data/personal')));
  }
  const malformed = fixture(t);
  fs.mkdirSync(path.join(malformed.data, 'data'), { recursive: true });
  fs.writeFileSync(path.join(malformed.data, 'data/.dsh-memory-bodies.json'), '{"version":99,"bodies":[]}');
  await assert.rejects(initializeWebMemory(malformed.file, yaml, malformed.env), /无法识别/);
  assert.ok(!fs.existsSync(path.join(malformed.data, 'data/personal')));
  const f = fixture(t);
  await assert.rejects(initializeWebMemory(f.file, yaml, { ...f.env, PATH: '' }));
  assert.ok(!fs.existsSync(path.join(f.profile, '.zp-personal-memory-v1')));
  await initializeWebMemory(f.file, yaml, f.env);
  assert.ok(fs.existsSync(path.join(f.data, 'data/personal/mnemon.db')));
});

test('the Web entrypoint refresh command initializes before Host launch and is repeatable', { skip: !modules || !cli }, t => {
  const f = fixture(t);
  const command = path.resolve(import.meta.dirname, '../config/profile-upgrades.mjs');
  const run = () => spawnSync(process.execPath, [command, f.file, seed, runtime, '--web-preview'], {
    env: { ...f.env, PATH: `${path.dirname(cli)}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.ok(fs.existsSync(path.join(f.data, 'data/personal/mnemon.db')));
  assert.equal(fs.readFileSync(path.join(f.profile, '.zp-personal-memory-v1'), 'utf8'), 'created\n');
  const before = fs.readFileSync(f.file, 'utf8');
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
