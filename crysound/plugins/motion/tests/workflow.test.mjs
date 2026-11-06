import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { apply } from '../index.mjs';
import { runJob } from '../cli/job.mjs';

const cli = fileURLToPath(new URL('../cli/om.mjs', import.meta.url));
const sandbox = fileURLToPath(new URL('./workspace-sandbox.py', import.meta.url));
const temporary = () => mkdtempSync(join(tmpdir(), 'motion-behavior-'));
const command = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });

test('workspace-write permits first use with read-only HOME and falls back when system temp is read-only', (t) => {
  const root = temporary();
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o500 });
  t.after(() => { chmodSync(home, 0o700); rmSync(root, { recursive: true, force: true }); });
  for (const systemTempWritable of [true, false]) {
    const cwd = join(root, systemTempWritable ? 'normal' : 'fallback');
    mkdirSync(cwd);
    const allowed = systemTempWritable ? [cwd, '/tmp'] : [cwd];
    const run = (argv) => {
      const result = spawnSync('python3', [sandbox, JSON.stringify(allowed), process.execPath, ...argv],
        { cwd, encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home,
          TMPDIR: home, OM_HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home } });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    };
    const denied = run(['-e', "require('node:fs').writeFileSync(process.env.HOME + '/probe', '')"]);
    assert.equal(denied.status, 1, 'HOME is genuinely read-only');
    if (!systemTempWritable) {
      assert.equal(run(['-e', "require('node:fs').writeFileSync('/tmp/motion-denied-' + process.pid, '')"]).status, 1);
    }
    for (const args of [['new', 'proj', '--template', 'company'], ['check', 'proj', '--source'], ['--version']]) {
      const result = run([cli, ...args]);
      assert.equal(result.status, 0, result.stderr);
      if (args[0] === '--version') assert.equal(result.stdout.trim(), '0.1.1');
    }
    assert.ok(existsSync(join(cwd, 'proj/assets/fonts/NotoSansSC-500.woff')));
    // The history writer is exercised in the real worker environment, without rendering a full soundtrack.
    const probe = join(cwd, 'history.mjs');
    writeFileSync(probe, `import { remember } from ${JSON.stringify(new URL('../cli/lib/soundprint.js', import.meta.url).href)};
import { writeFileSync } from 'node:fs';
remember(process.cwd(), { band: ['piano'] });
writeFileSync(process.argv[2], JSON.stringify({ home: process.env.OM_HOME, temp: process.env.TMPDIR,
  cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME }));\n`);
    const environment = spawnSync('python3', [sandbox, JSON.stringify(allowed), process.execPath,
      '--input-type=module', '-e', `import { runJob } from ${JSON.stringify(new URL('../cli/job.mjs', import.meta.url).href)};
process.exitCode = await runJob(${JSON.stringify(probe)}, ['paths.json']);`],
      { cwd, encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, TMPDIR: cwd, OM_HOME: home } });
    assert.ifError(environment.error);
    assert.equal(environment.signal, null);
    assert.equal(environment.status, 0, environment.stderr);
    assert.ok(existsSync(join(cwd, '.crysound-motion/soundtracks.jsonl')));
    const paths = JSON.parse(readFileSync(join(cwd, 'paths.json'), 'utf8'));
    for (const key of ['home', 'temp', 'cache', 'config']) assert.ok(paths[key].startsWith(cwd + '/'), key);
  }
});

test('unwritable system temp and workspace report an actionable Chinese error', (t) => {
  const cwd = temporary();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync('python3', [sandbox, '[]', process.execPath, cli, 'new', 'proj'],
    { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /系统临时目录和当前工作区均不可写或不安全/);
  assert.ok(!existsSync(join(cwd, 'proj')));
});

test('registers the complete workflow for model and slash-command invocation', () => {
  let skill;
  apply({ skills: { register(value) { skill = value; } } });
  assert.equal(skill.name, 'crysound-motion');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.match(skill.content, /HyperFrames/);
  assert.match(skill.content, /om still/);
  assert.match(skill.content, /OM_CHROME/);
  assert.ok(!skill.content.startsWith('---'));
  const paths = JSON.parse(skill.content.slice(skill.content.lastIndexOf('\n') + 1));
  assert.equal(paths.om, cli);
  assert.equal(paths.node, process.execPath);
});

test('new projects contain local licensed resources, pass source checks and never overwrite existing work', (t) => {
  const cwd = temporary();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(command(cwd, 'new', '中文 产品').status, 0);
  const html = readFileSync(join(cwd, '中文 产品/index.html'), 'utf8');
  assert.match(html, /data-om-signature="off"/);
  assert.match(html, /Noto Sans SC/);
  assert.equal(command(cwd, 'check', '中文 产品', '--source').status, 0);
  assert.notEqual(command(cwd, 'new', '中文 产品').status, 0);
  assert.equal(readFileSync(join(cwd, '中文 产品/index.html'), 'utf8'), html);
  for (const asset of ['assets/fonts/OFL.txt', 'vendor/GSAP-LICENSE.html', 'vendor/om.js', 'assets/zp-mark.svg']) {
    assert.ok(readFileSync(join(cwd, '中文 产品', asset)).length > 0);
  }
});

test('unsupported servers, downloads, options and excessive render loads fail before opening a browser', (t) => {
  const cwd = temporary();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(command(cwd, 'new', 'film').status, 0);
  for (const cmd of ['studio', 'demo', 'voice', 'samples', 'grab', 'share']) assert.notEqual(command(cwd, cmd).status, 0, cmd);
  for (const args of [ ['render', 'film', '--workers', '3'], ['render', 'film', '--workers', 'NaN'],
    ['render', 'film', '--fps', '60'], ['render', 'film', '--blur', '8'], ['render', 'film', '--engine', 'hyperframes'],
    ['still', 'film', '--at', 'Infinity'], ['still', 'film', '--at', '31'], ['render', 'film', '--format', 'mov'] ]) {
    const result = command(cwd, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.doesNotMatch(result.stderr, /no Chrome/);
  }
});

test('project creation and explicit output cannot escape through a parent or symlink', (t) => {
  const cwd = temporary();
  const outside = temporary();
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  symlinkSync(outside, join(cwd, 'linked'), 'dir');
  assert.equal(command(cwd, 'new', 'linked/escape').status, 1);
  assert.equal(command(cwd, 'new', '../escape').status, 1);
  assert.equal(command(cwd, 'new', 'film').status, 0);
  assert.equal(command(cwd, 'still', 'film', '--out', 'linked/frame.png').status, 1);
});

test('deadline interrupts synchronous work and kills inherited helpers; secrets are not inherited', async (t) => {
  const cwd = temporary();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const entry = join(cwd, 'busy.mjs');
  const pidFile = join(cwd, 'helper.pid');
  writeFileSync(entry, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.env.EXAMPLE_API_KEY || process.env.EXAMPLE_TOKEN) process.exit(99);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(child.pid));
while (true) {}\n`);
  const status = await runJob(entry, [pidFile], { timeoutMs: 500, stdio: 'ignore',
    env: { ...process.env, EXAMPLE_API_KEY: 'test-value', EXAMPLE_TOKEN: 'test-value' } });
  assert.equal(status, 124);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // An exited orphan can briefly remain a zombie until init reaps it; it cannot perform work.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `helper ${pid} still running: ${state}`);
});

test('two real CLI jobs share the lock across workspaces and TMPDIR values; cancellation stops helpers and releases it', async (t) => {
  const cwd = temporary();
  let child, other;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    rmSync(cwd, { recursive: true, force: true });
    if (other) rmSync(other, { recursive: true, force: true });
  });
  assert.equal(command(cwd, 'new', 'film').status, 0);
  const browser = join(cwd, 'fake-browser');
  const pidFile = join(cwd, 'browser.pid');
  writeFileSync(browser, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';
writeFileSync(process.env.MOTION_TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n`);
  chmodSync(browser, 0o700);
  child = spawn(process.execPath, [cli, 'still', 'film'], {
    cwd, stdio: 'ignore', env: { ...process.env, OM_CHROME: browser, MOTION_TEST_PID_FILE: pidFile },
  });
  for (let i = 0; !existsSync(pidFile) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(pidFile), 'browser child started');
  other = temporary();
  const conflict = spawnSync(process.execPath, [cli, 'new', 'proj'], { cwd: other,
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, TMPDIR: other, HOME: other } });
  assert.ifError(conflict.error);
  assert.equal(conflict.signal, null);
  assert.equal(conflict.status, 75);
  assert.match(conflict.stderr, /另一项任务正在运行/);
  assert.ok(!existsSync(join(other, 'proj')));
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  assert.equal(await closed, 143);
  const state = spawnSync('ps', ['-o', 'stat=', '-p', readFileSync(pidFile, 'utf8')], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `browser still running: ${state}`);
  assert.equal(command(other, 'new', 'proj').status, 0);
});

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

for (const order of ['single then multiple', 'multiple then single']) {
  test(`default still output remains a directory: ${order}`, { skip: !process.env.OM_CHROME }, (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'motion-still-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 45_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null, args.join(' '));
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
      return result;
    };
    const png = (path) => assert.deepEqual(readFileSync(join(cwd, path)).subarray(0, 8), pngHeader);
    run('new', '产品片');
    const times = order === 'single then multiple' ? ['4.5', '0,4.5'] : ['0,4.5', '4.5'];
    for (const at of times) {
      run('still', '产品片', '--at', at);
      assert.ok(statSync(join(cwd, '产品片/out/stills')).isDirectory());
      png('产品片/out/stills/index-4.50s.png');
    }
    png('产品片/out/stills/index-0.00s.png');
    run('still', '产品片');
    png('产品片/out/stills/index-0.00s.png');
    run('still', '产品片', '--at', '4.5', '--out', 'review/frame.png');
    png('review/frame.png');
    const before = readFileSync(join(cwd, 'review/frame.png'));
    const duplicate = spawnSync(process.execPath, [cli, 'still', '产品片', '--out', 'review/frame.png'],
      { cwd, encoding: 'utf8', timeout: 45_000 });
    assert.ifError(duplicate.error);
    assert.equal(duplicate.signal, null);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /new .png file/);
    assert.deepEqual(readFileSync(join(cwd, 'review/frame.png')), before);
  });
}
