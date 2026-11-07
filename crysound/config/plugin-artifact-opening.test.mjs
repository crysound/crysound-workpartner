import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { patchArtifactOpening } from './plugin-patches.mjs';
import { installPreviewClient } from '../web/preview/client.mjs';

const release = process.env.ARTIFACTS_PACKAGE;
assert.ok(release, 'Set ARTIFACTS_PACKAGE to the extracted @crysound/artifacts@1.0.0 package');
const metadata = JSON.parse(fs.readFileSync(path.join(release, 'package.json'), 'utf8'));
assert.equal(metadata.name, '@crysound/artifacts');
assert.equal(metadata.version, '1.0.0');
const original = fs.readFileSync(path.join(release, 'lib/client.js'), 'utf8');
const patched = patchArtifactOpening(original);
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute the whole released module; expose its existing page mount for a fake Host.
function harness({ source = patched, cloud = true, state = 'available', mode = 'sidebar', current = true,
  browser = true, popup = true, fetchError = false, createError = false, restoreError = false,
  restore = true, adapter = true, bodySessionId = 'origin' } = {}) {
  const calls = [], registrations = [], listeners = new Map();
  const list = { phase: state === 'loading' ? 'pending' : 'ready',
    ids: state === 'missing' ? [] : ['origin'], byId: current ? { current: { id: 'current', retainedBy: { mainView: 1 } } } : {} };
  let api, dictionaries;
  const element = () => ({ dataset: {}, remove() {} });
  const document = {
    documentElement: {}, head: { appendChild() {} }, createElement: element, querySelectorAll: () => [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const tab = { opener: {}, location: { replace(url) { calls.push(['navigate', url]); } }, close() { calls.push(['close']); } };
  const jsx = (type, props) => ({ type, props });
  const react = { useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useEffect() {} };
  const sandbox = { console, URL, URLSearchParams, setTimeout, clearTimeout, document,
    MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    window: { open(url) { calls.push(['popup', url]); return popup && cloud ? tab : null; },
      __ModuleLoader__: { load({ factory }) { api = factory(name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : {}); } } },
    fetch: async url => {
      calls.push(['fetch', String(url)]);
      if (fetchError) throw new Error('editor startup failed');
      return { ok: true, json: async () => String(url).includes('.open?')
        ? { url: 'http://127.0.0.1:4710/slides/demo/?q=1#p2', sessionId: bodySessionId }
        : { artifacts: [], skills: [] } };
    },
  };
  vm.createContext(sandbox);
  if (!cloud) sandbox.dshDesktop = { protocolVersion: 1 };
  if (cloud && adapter) vm.runInContext(`(${installPreviewClient.toString()})({previewHost:'preview.example.test',scope:'owner'})`, sandbox);
  vm.runInContext(source.replace('return module.exports;', 'return { mountPage, ToastBar };'), sandbox);
  const workspace = {
    openSession(id) { calls.push(['session', id]); },
    ...(restore ? { async unarchiveSession(id) { calls.push(['restore', id]); if (restoreError) throw new Error('restore refused'); } } : {}),
  };
  const services = {
    configForms: { get(namespace) { assert.equal(namespace, 'ui-chat'); return { getSnapshot: () => ({ value: { linkOpening: mode } }) }; } },
    sessions: { list: { getSnapshot: () => list }, async create() { calls.push(['create']); if (createError) throw new Error('create refused'); return 'created'; } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: state === 'archived' ? ['origin'] : [] }) } },
    uiWorkspace: workspace,
    sidebarRight: { openTabIn(id, kind, { params }) { calls.push(['sidebar', id, kind, params.url]); } },
    sidebarRightTabs: { get: () => browser ? {} : undefined },
  };
  const ctx = { get: key => services[key],
    locale: { register(_namespace, values) { dictionaries = values; return () => {}; },
      bind: () => (key, values) => (dictionaries.zh[key] ?? key).replace('{message}', values?.message ?? '') },
    slots: { inject(_name, fn) { return fn(); }, register(spec, component) { registrations.push({ spec, component }); return () => {}; } },
  };
  const dispose = api.mountPage(ctx);
  const page = registrations.find(item => item.spec.name === 'main').spec.inject();
  const overlay = () => {
    const node = registrations.find(item => item.spec.name === 'shell.overlay')?.component();
    return node?.props.toast;
  };
  return { page, overlay, calls, tab, dispose, api };
}
const view = { root: '/artifacts/demo', sessionId: 'origin', openable: true };
const openedUrl = result => result.calls.find(call => call[0] === 'sidebar')?.[3]
  ?? result.calls.find(call => call[0] === 'navigate')?.[1]
  ?? result.calls.find(call => call[0] === 'popup' && call[1] !== 'about:blank')?.[1];

for (const cloud of [true, false]) for (const state of ['available', 'archived', 'missing', 'loading']) {
  for (const mode of ['sidebar', 'new-tab']) for (const current of [true, false]) {
    test(`${cloud ? 'web' : 'desktop'} / ${state} / ${mode} / ${current ? 'current' : 'no current'}`, async () => {
      const h = harness({ cloud, state, mode, current });
      h.page.openArtifact(view);
      await tick();
      const url = openedUrl(h);
      assert.ok(url, JSON.stringify(h.calls));
      if (cloud) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://preview.example.test');
        assert.equal(parsed.searchParams.get('port'), '4710');
        assert.equal(parsed.searchParams.get('path'), '/slides/demo/?q=1#p2');
      } else assert.equal(url, 'http://127.0.0.1:4710/slides/demo/?q=1#p2');
      if (mode === 'sidebar') {
        assert.ok(!h.calls.some(call => call[0] === 'popup'));
        assert.equal(h.calls.find(call => call[0] === 'sidebar')[1], state === 'available' ? 'origin' : current ? 'current' : 'created');
        assert.equal(h.calls.filter(call => call[0] === 'create').length, state !== 'available' && !current ? 1 : 0);
      } else {
        if (cloud) assert.deepEqual(h.calls.slice(0, 2).map(call => call[0]), ['popup', 'fetch']);
        else assert.equal(h.calls.find(call => call[0] === 'popup')[1], url);
        assert.ok(!h.calls.some(call => ['session', 'sidebar', 'create'].includes(call[0])));
        if (cloud) assert.equal(h.tab.opener, null);
      }
      assert.equal(h.page.artifactsStore.getSnapshot().opening, null);
      assert.equal(h.overlay()?.message, state === 'archived' ? '作品所在的对话已归档' : undefined);
      if (state === 'archived') {
        const notice = h.overlay();
        assert.equal(notice.action.label, '恢复对话');
        const tree = h.api.ToastBar({ toast: notice, t: x => x, onClose() {} });
        assert.ok(tree.props.children.some(child => child?.type === 'button' && child.props.children === '恢复对话'));
        notice.action.run(); await tick();
        assert.deepEqual(h.calls.filter(call => ['restore', 'session'].includes(call[0])).slice(-2), [['restore', 'origin'], ['session', 'origin']]);
      }
      h.dispose();
    });
  }
}

test('unpatched release reproduces archived loopback leak', async () => {
  const h = harness({ source: original, state: 'archived' });
  h.page.openArtifact(view); await tick();
  assert.deepEqual(h.calls.find(call => call[0] === 'popup'), ['popup', 'http://127.0.0.1:4710/slides/demo/?q=1#p2']);
  h.dispose();
});

test('absent restore capability gives only the archive message', async () => {
  const h = harness({ state: 'archived', restore: false });
  h.page.openArtifact(view); await tick();
  assert.equal(h.overlay().message, '作品所在的对话已归档');
  assert.equal(h.overlay().action, undefined);
  h.dispose();
});

for (const options of [{ browser: false }, { adapter: false }, { current: false, state: 'missing', createError: true },
  { mode: 'new-tab', fetchError: true }]) {
  test(`failure is visible without unsafe window fallback: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    h.page.openArtifact(view); await tick();
    assert.equal(h.overlay().kind, 'error');
    assert.equal(h.page.artifactsStore.getSnapshot().opening, null);
    assert.equal(openedUrl(h), undefined);
    if (options.mode === 'new-tab') assert.ok(h.calls.some(call => call[0] === 'close'));
    else assert.ok(!h.calls.some(call => call[0] === 'popup'));
    h.dispose();
  });
}

test('blocked popups leave page usable without starting an editor', async () => {
  const h = harness({ mode: 'new-tab', popup: false });
  h.page.openArtifact(view); await tick();
  assert.ok(!h.calls.some(call => call[0] === 'fetch'));
  assert.match(h.page.artifactsStore.getSnapshot().toast.message, /允许浏览器/);
  h.dispose();
});

test('restore failure remains visible after sidebar navigation', async () => {
  const h = harness({ state: 'archived', restoreError: true });
  h.page.openArtifact(view); await tick();
  h.overlay().action.run(); await tick();
  assert.match(h.overlay().message, /restore refused/);
  assert.equal(h.overlay().kind, 'error');
  h.dispose();
});

test('patch runs twice on plain and title-patched packages, including pnpm hard links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-opening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const untouched = path.join(root, 'store-client.js');
  fs.writeFileSync(untouched, original);
  for (const [index, source] of [original, original.replaceAll('兆华作品', '作品')].entries()) {
    const modules = path.join(root, String(index));
    const target = path.join(modules, '.pnpm/artifacts/node_modules/@crysound/artifacts/lib/client.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!index) fs.linkSync(untouched, target); else fs.writeFileSync(target, source);
    const script = new URL('./plugin-patches.mjs', import.meta.url).pathname;
    execFileSync(process.execPath, [script, modules], { stdio: 'pipe' });
    const first = fs.readFileSync(target, 'utf8');
    execFileSync(process.execPath, ['--check', target]);
    execFileSync(process.execPath, [script, modules], { stdio: 'pipe' });
    assert.equal(fs.readFileSync(target, 'utf8'), first);
    assert.ok(first.includes('CRYSOUND artifact opening v1'));
  }
  assert.equal(fs.readFileSync(untouched, 'utf8'), original);
  assert.equal(patchArtifactOpening(patched), patched);
  assert.throws(() => patchArtifactOpening(original.replace('var PAGE_VERSION = 6;', 'var PAGE_VERSION = 8;')), /未唯一命中/);
});
