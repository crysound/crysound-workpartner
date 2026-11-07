// Run only inside the disposable pinned image; /repo is read-only except explicit fixture capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { patchWebAutoReview } from '../scripts/patch-web-auto-review.mjs';
const runtime = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';
const require = createRequire(runtime + '/@deepseek-ai/dsh-base/package.json');
const WebSocket = require('ws');
const fixtureDir = new URL('./fixtures/web-auto-review/', import.meta.url).pathname;
const scenario = new URL('../../snapshots/web/crysound-default-auto-review/', import.meta.url).pathname;
const baseline = scenario + 'session.v4.jsonl';
function rows(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
const task = rows(baseline).find(e => e.type === 'user/message' && e.data.source.kind === 'user').data.content[0].text;
function world(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map(p => {
    const file = path.join(dir, p), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() || stat.isDirectory(), 'unexpected workspace entry: ' + p);
    return [p, stat.isDirectory() ? { type: 'directory' } : { type: 'file', content: fs.readFileSync(file, 'base64') }];
  }));
}
// Tokens cover only typed identities, runtime paths and clocks; arbitrary model/tool text stays intact.
function normalized(events, cwd, origin) {
  const identities = new Map();
  const counts = new Map();
  function identity(value, kind) {
    if (!identities.has(value)) { const n = (counts.get(kind) ?? 0) + 1; counts.set(kind, n); identities.set(value, `{{${kind}:${n}}}`); }
    return identities.get(value);
  }
  const prompts = [], schemas = [];
  for (const event of events) {
    if (event.type === 'session') { identity(event.id, 'session'); event.createdAt = 0; }
    const data = event.data;
    if (event.type.startsWith('approval/') && data.id) identity(data.id, 'approval');
    if (data?.jobId) identity(data.jobId, 'id');
    const messages = [data?.message, ...(data?.inserted ?? []), ...(event.type === 'user/message' ? [data] : [])].filter(Boolean);
    for (const message of messages) {
      if (message.id) identity(message.id, 'message');
      if (message.source?.rpcId) identity(message.source.rpcId, 'rpc');
    }
    if (event.type === 'user/message' && data.source.kind === 'time-context') {
      const clock = text => text.replace(/(Time sampled while preparing turn \d+, step \d+: )[^\n]+/, '$1{{clock}}');
      for (const block of data.content) if (block.type === 'text') block.text = clock(block.text);
      for (const section of data.source.sections) section.text = clock(section.text);
    }
    if (event.type === 'system/message') {
      prompts.push(data.message.content); data.message.content = [{ type: 'text', text: '{{system}}' }];
    }
    if (event.type === 'request/header') { schemas.push(data.header.tools); data.header.tools = '{{tools}}'; }
  }
  function visit(value) {
    if (typeof value === 'string') return identities.get(value) ?? value.replaceAll(cwd, '{{cwd}}').replaceAll(origin, '{{webOrigin}}');
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !['seq', 'time', 'time0'].includes(k)).map(([k,v]) => [k, ['startedAt','finishedAt'].includes(k) ? 0 : visit(v)]));
  }
  return { session: events.map(e => JSON.stringify(visit(e))).join('\n') + '\n',
    system: visit(prompts).map(blocks => blocks.map(b => b.text).join('\n')).join('\n') + '\n', tools: JSON.stringify(visit(schemas)[0], null, 2) + '\n' };
}
async function until(read, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await delay(25); }
  throw new Error('Timed out: ' + label);
}

test('assembled Web default Auto reviews tools and holds denied execution until a real client decision', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-review-'));
  // The container owns the temporary root; teardown removes it after process exit.
  const cwd = root + '/workspace', home = root + '/home';
  fs.cpSync(scenario + 'workspace', cwd, { recursive: true });
  const observed = root + '/review.jsonl';
  const env = { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    AUTO_REVIEW_REPLAY: baseline, AUTO_REVIEW_VERDICTS: scenario + 'replay.override.json', AUTO_REVIEW_OBSERVED: observed };
  if (!process.env.AUTO_REVIEW_UNPATCHED) patchWebAutoReview(runtime);
  execFileSync('dsh', ['--profile', 'web', '--dump-config'], { cwd, env, stdio: 'ignore' });
  const profile = home + '/profiles/web';
  const manifest = JSON.parse(fs.readFileSync(profile + '/package.json'));
  manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-auto-review');
  fs.writeFileSync(profile + '/package.json', JSON.stringify(manifest));
  const patch = root + '/scenario.yml';
  fs.writeFileSync(patch, `
- id: agent-default-model
  config:
    provider: recorded
    model: recorded
- id: session-persistence-jsonl
  config:
    root: ${home}/sessions
    compression: none
- id: session-title-llm
  disabled: true
- insert:
    - id: recorded-model
      name: ${fixtureDir}replay.mjs
`);
  const child = spawn('dsh', ['--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd, env });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = await until(() => {
    if (child.exitCode !== null) throw new Error(output);
    return output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
  }, 'Web URL: ' + output);
  const url = new URL(target), origin = url.origin;
  const exchange = await fetch(target, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Web authentication must issue a cookie');
  async function rpc(endpoint, args) {
    const res = await fetch(origin + '/api/' + endpoint, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }) });
    const body = await res.json();
    assert.equal(body.result.ok, true, JSON.stringify(body));
    return body.result.value;
  }
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie } });
  const frames = [];
  socket.on('message', b => frames.push(JSON.parse(b)));
  t.after(async () => { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, 'close'); socket.terminate(); await closed; });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
  const ready = await until(() => frames.find(f => f.value?.type === 'ready')?.value, 'event readiness');
  const created = await rpc('session/create', { request: { cwd } });
  assert.ok(!output.includes('did not activate'), output);
  const sessionId = created.sessionId;
  await until(() => fs.readdirSync(home + '/sessions', { recursive: true }).some(p => String(p).endsWith('.jsonl')), 'created Session log');
  const logs = fs.readdirSync(home + '/sessions', { recursive: true }).filter(p => String(p).endsWith('.jsonl'));
  assert.equal(logs.length, 1);
  const logPath = home + '/sessions/' + logs[0];
  await until(() => rows(logPath).some(e => e.type === 'permission/preset'), 'initial permission');
  assert.equal(rows(logPath).find(e => e.type === 'permission/preset').data.preset, 'auto');
  await rpc('session/prompt', { request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: task }] } });
  const approval = await until(() => frames.find(f => f.value?.event === 'approval/request')?.value, 'denied approval');
  assert.equal(fs.readFileSync(cwd + '/allowed.txt', 'utf8'), 'allowed');
  assert.equal(fs.readFileSync(cwd + '/protected/original.txt', 'utf8'), 'preserve\n');
  const reviews = rows(observed);
  assert.deepEqual(reviews.map(r => r.verdict), JSON.parse(fs.readFileSync(scenario + 'replay.override.json')));
  assert.match(JSON.stringify(reviews[0].messages), /printf allowed/);
  assert.match(JSON.stringify(reviews[1].messages), /rm -rf protected/);
  await until(() => rows(logPath).some(e => e.type === 'approval/asked'), 'persisted pending approval');
  const pending = rows(logPath);
  assert.equal(pending.filter(e => e.type === 'approval/asked').length, 1);
  assert.ok(!pending.some(e => e.type === 'approval/decided'));
  assert.equal(pending.find(e => e.type === 'permission/preset').data.preset, 'auto');
  await rpc('$events/result', { clientId: ready.clientId, eventId: approval.eventId, outcome: { kind: 'result', value: 'rejected' } });
  await until(() => fs.readFileSync(logPath, 'utf8').includes('turn/end'), 'completed turn');
  const log = fs.readFileSync(logPath, 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.type === 'approval/decided').map(e => e.data.outcome), ['rejected']);
  assert.equal(events.filter(e => e.type === 'job/registered').length, 1, 'denied bash must never start a job');
  const actual = normalized(events, cwd, origin);
  if (process.env.AUTO_REVIEW_CAPTURE) {
    for (const [name, content] of Object.entries(actual)) fs.writeFileSync(process.env.AUTO_REVIEW_CAPTURE + '/' + name + '.txt', content);
  } else {
    assert.equal(actual.session, fs.readFileSync(baseline, 'utf8'));
    assert.equal(actual.system, fs.readFileSync(scenario + 'system-prompt.expected.md', 'utf8'));
    assert.equal(actual.tools, fs.readFileSync(scenario + 'tool-schemas.expected.json', 'utf8'));
  }
  assert.deepEqual(world(cwd), world(scenario + 'workspace.expected'));
  assert.equal(fs.readFileSync(cwd + '/protected/original.txt', 'utf8'), 'preserve\n');
});
