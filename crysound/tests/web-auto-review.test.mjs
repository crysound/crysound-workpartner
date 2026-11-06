// Run against the existing pinned image, with /repo mounted read-only; no install or build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { patchWebAutoReview, patchPermissionHost, patchPermissionClient, patchAutoReviewHost } from '../scripts/patch-web-auto-review.mjs';

const runtime = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';
const require = createRequire(runtime + '/@deepseek-ai/dsh-base/package.json');
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore, Session, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: ProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
const { default: Approval } = await load('@deepseek-ai/dsh-user-approval');
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
const hostFile = runtime + '/@deepseek-ai/dsh-permission-presets/lib/index.js';
const { default: DesktopPermission } = await load('@deepseek-ai/dsh-permission-presets');
const artifacts = [
  ['dsh-permission-presets/lib/index.js', patchPermissionHost],
  ['dsh-client-ui-permission-presets/lib/client.js', patchPermissionClient],
  ['dsh-experimental-auto-review/lib/index.js', patchAutoReviewHost],
].map(([name, patch]) => [fs.readFileSync(runtime + '/@deepseek-ai/' + name, 'utf8'), patch]);

test('pinned artifacts match uniquely, repeat byte-identically, and reject drift', () => {
  for (const [before, patch] of artifacts) {
    const after = patch(before);
    assert.notEqual(after, before);
    assert.equal(patch(after), after);
    assert.throws(() => patch('unsupported version'), /exactly once/);
    assert.throws(() => patch(before + before), /exactly once/);
  }
  const docker = fs.readFileSync(new URL('../web/Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /RUN node \/opt\/partner\/scripts\/patch-web-auto-review.mjs/);
});

patchWebAutoReview(runtime);
const { default: WebPermission } = await import(pathToFileURL(hostFile).href + '?web');
const { apply: autoReview, inject } = await load('@deepseek-ai/dsh-experimental-auto-review');

async function mount(t, Permission = WebPermission, initial) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(ProjectionRegistry);
  await ctx.plugin(Approval, { policy: 'ask' });
  ctx.provide('shell', { sandboxMode: 'workspace-write' });
  ctx.provide('agents', { list: () => [] });
  await ctx.plugin(Loader);
  ctx.loader.builtins.permission = Permission;
  const config = { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }, ...(initial === undefined ? {} : { defaultPreset: initial }) };
  const id = await ctx.loader.create({ id: 'permission', name: 'cordis:permission', config });
  const entry = ctx.loader.resolve(id);
  await entry.fiber.await();
  assert.ok(ctx.permissionPresets);
  const create = seed => {
    const session = Session.create(SessionId('test-' + crypto.randomUUID()), seed);
    ctx.emit('agent/created', { agent: { session } });
    return session;
  };
  return { ctx, create, choose: async value => {
    await entry.update({ config: { ...config, defaultPreset: value } });
    await entry.fiber.await();
  } };
}

function permissionFacts(session) {
  return session.snapshotEvents().filter(e => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(e.type))
    .map(e => [e.type, e.data]);
}

test('unset Web defaults use Auto without a session confirmation; explicit preferences survive', async t => {
  const { ctx, create, choose } = await mount(t);
  let admissions = 0;
  ctx.permissionPresets.registerAuto(() => { admissions++; });
  assert.equal(ctx.permissionPresets.catalog().defaultPreset, 'auto');
  assert.ok(ctx.permissionPresets.catalog().defaultOptions.some(o => o.value === 'auto'));
  assert.deepEqual(permissionFacts(create()), [
    ['permission/preset', { preset: 'auto' }],
    ['sandbox/mode', { mode: 'danger-full-access' }],
    ['approval/policy', { policy: 'ask' }],
  ]);
  assert.equal(admissions, 1);
  for (const name of ['read-only', 'workspace-write', 'danger-full-access', 'auto']) {
    await choose(name);
    const session = create();
    assert.equal(ctx.permissionPresets.current(session), name);
    assert.equal(ctx.permissionPresets.defaultPreset, name);
  }
});

test('missing or failing review admission starts a usable workspace-write session, retaining default intent', async t => {
  const { ctx, create } = await mount(t, WebPermission, 'auto');
  const safe = () => assert.deepEqual(permissionFacts(create()), [
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'ask' }],
  ]);
  safe();
  assert.equal(ctx.permissionPresets.defaultPreset, 'auto');
  ctx.permissionPresets.registerAuto(() => { throw new Error('review plugin failed'); });
  safe();
});

test('restoring an Auto session without its integration confines it before use', async t => {
  const { ctx, create } = await mount(t);
  const source = Session.create(SessionId('previous-auto'));
  source.append('permission/preset', { preset: 'auto' });
  source.append('sandbox/mode', { mode: 'danger-full-access' });
  source.append('approval/policy', { policy: 'ask' });
  const restored = create(source.snapshotEvents());
  assert.equal(ctx.permissionPresets.current(restored), 'workspace-write');
  assert.deepEqual(permissionFacts(restored).slice(-3), [
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'ask' }],
  ]);
});

test('desktop defaults and default options retain upstream behavior', async t => {
  const { ctx, create } = await mount(t, DesktopPermission);
  ctx.permissionPresets.registerAuto(() => {});
  assert.equal(ctx.permissionPresets.current(create()), 'workspace-write');
  assert.ok(!ctx.permissionPresets.catalog().defaultOptions.some(o => o.value === 'auto'));
});

test('removing the real review plugin confines active Auto sessions and future sessions', async t => {
  const { ctx, create } = await mount(t);
  for (const name of ['llm', 'tools', 'workingDirectory']) ctx.provide(name, {});
  const fiber = await ctx.plugin({ name: 'test-review', inject, apply: autoReview });
  const session = create();
  assert.equal(ctx.permissionPresets.current(session), 'auto');
  const originalList = ctx.sessions.list;
  ctx.sessions.list = () => [session];
  await fiber.dispose();
  ctx.sessions.list = originalList;
  assert.equal(ctx.permissionPresets.current(session), 'workspace-write');
  assert.equal(ctx.approval.overrideOf(session), 'ask');
  assert.equal(ctx.permissionPresets.current(create()), 'workspace-write');
});
