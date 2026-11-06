import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { apply } from '../index.mjs';

const render = fileURLToPath(new URL('../scripts/render.mjs', import.meta.url));

function run(args, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, output }));
  return { child, done };
}

test('skill tool and slash catalog expose the same bundled workflow and real resources', async () => {
  let provider;
  apply({ skills: { registerProvider(create) { provider = create(); } } });
  const [entry] = await provider.list();
  assert.equal(entry.name, 'design');
  assert.deepEqual(entry.invocation, { modelInvocable: true, userInvocable: true });
  const definition = await provider.get(entry, {});
  const raw = await readFile(join(entry.resourceBase.path, 'SKILL.md'), 'utf8');
  assert.equal(entry.description, /^description: (.+)$/m.exec(raw)[1]);
  assert.equal(definition.content, raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, ''));
  for (const resource of ['DESIGN.md', 'assets/zp-mark.svg', 'references/frontend-design.md', 'scripts/render.mjs']) assert.ok((await readFile(join(entry.resourceBase.path, resource))).length);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.get(entry, { signal: controller.signal }), { name: 'AbortError' });
});

test('missing shared runtime fails explicitly without installing a browser', async () => {
  const result = await run(['--input-type=module', '-e', `import { withBrowser } from ${JSON.stringify(new URL('../scripts/browser-runtime.mjs', import.meta.url).href)}; await withBrowser(() => {});`], { SLIDESTUDIO_PLAYWRIGHT_RUNTIME: '' }).done;
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /勿安装或下载浏览器/);
});

test('independent commands share two browser slots and release them after action failures', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crysound-design-test-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(({ done }) => done));
    await rm(directory, { recursive: true, force: true });
  });
  const events = join(directory, 'events.jsonl');
  const fake = join(directory, 'runtime.mjs');
  // Each acquisition announces readiness and blocks on explicit IPC release.
  await writeFile(fake, `import { appendFileSync } from 'node:fs';
export async function launchPinnedChromium() {
 appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind:'open',pid:process.pid})+'\\n');
 process.send({kind:'ready'});
 return {async close(){appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'close',pid:process.pid})+'\\n');}};
}`);
  const worker = join(directory, 'worker.mjs');
  await writeFile(worker, `import {withBrowser} from ${JSON.stringify(new URL('../scripts/browser-runtime.mjs', import.meta.url).href)};
try { await withBrowser(async () => { await new Promise(resolve => process.once('message', resolve)); if(process.env.FAIL_ACTION==='yes') throw new Error('action failed'); }); }
finally { process.disconnect(); }`);
  const ready = [];
  for (let i = 0; i < 5; i++) {
    const child = spawn(process.execPath, [worker], { env: { ...process.env, SLIDESTUDIO_PLAYWRIGHT_RUNTIME: fake, FAIL_ACTION: i === 0 ? 'yes' : '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    ready.push(once(child, 'message').then(() => child));
    children.push({ child, done: once(child, 'close').then(([code, signal]) => ({ code, signal, output })) });
  }
  // Wait for two acquisitions, then release each ready worker. The first two must overlap.
  const first = await Promise.race(ready);
  const second = await Promise.race(ready.filter((_, i) => children[i].child !== first));
  assert.notEqual(first.pid, second.pid);
  const finish = ready.map(async promise => { (await promise).send({ kind: 'release' }); });
  await Promise.all(finish);
  const results = await Promise.all(children.map(({ done }) => done));
  assert.equal(results.filter(result => result.code !== 0).length, 1);
  assert.ok(results.every(result => result.signal === null));
  assert.match(results[0].output, /action failed/);
  let live = 0;
  let peak = 0;
  const log = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const event of log) { live += event.kind === 'open' ? 1 : -1; peak = Math.max(peak, live); assert.ok(live >= 0 && live <= 2); }
  assert.equal(peak, 2);
  assert.equal(live, 0);
  assert.equal(log.filter(event => event.kind === 'open').length, 5);
});

test('render rejects unsupported input and viewport ranges before opening a browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crysound-design-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.html');
  await writeFile(file, '<!doctype html><title>演示</title><p>演示数据</p>');
  const result = await run([render, file, join(directory, 'out'), '--viewports', '99999x10']).done;
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Viewport outside supported range/);
});
