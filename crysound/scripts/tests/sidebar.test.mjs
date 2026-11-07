// Exercise the published browser artifacts; no package installation or build is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { sidebarPanels, sidebarGrouping } from '../sidebar-policy.mjs';
import { patchCompanySidebarRuntime, patchSidebarModule, patchWorkspaceModule } from '../patch-sidebar.mjs';
import { patchMarketSidebar } from '../patch-market-ui.mjs';

const source = process.env.SIDEBAR_RUNTIME_MODULES;
if (!source) throw new Error('SIDEBAR_RUNTIME_MODULES must point to unmodified published 0.2.2-rc.1 node_modules');
const panel = (id, label = id, order = 0, owner = id, pluginName = label) => ({ id, label, order, owner, pluginName });

test('fixed navigation precedes plugins regardless of negative order; 0/1/2/3 threshold', () => {
  const fixed = [panel('plugins'), panel('schedules'), panel('baoyu-design.artifacts')];
  const extras = [panel('notes', '笔记', -100), panel('desk', '工作台', -1000), panel('clock', '闹钟', -999)];
  for (let count = 0; count <= 3; count++) {
    const result = sidebarPanels([...extras.slice(0, count), ...fixed]);
    assert.deepEqual(result.fixed.map(p => p.id), ['baoyu-design.artifacts', 'schedules', 'plugins']);
    assert.equal(result.visible.length, 3 + (count > 2 ? 0 : count));
    assert.equal(result.extras.length, count);
  }
  assert.deepEqual(sidebarPanels([...extras, ...fixed]).extras.map(p => p.label), ['笔记', '工作台', '闹钟']);
});

test('plugin names own the primary sort; same plugin uses order then registration order', () => {
  const entries = [panel('a', 'Z row', 2, 'one', '阿尔法'), panel('b', 'A row', -3, 'one', '阿尔法'), panel('c', 'Z again', 2, 'one', '阿尔法'), panel('d', 'A', -999, 'two', '兆华')];
  assert.deepEqual(sidebarPanels(entries).extras.map(p => p.id), ['b', 'a', 'c', 'd']);
  assert.deepEqual(sidebarPanels([entries[3], ...entries.slice(0, 3)]).extras.map(p => p.id), ['b', 'a', 'c', 'd']);
  const noMeta = entries.slice(0, 3).map(p => ({ ...p, pluginName: undefined }));
  assert.deepEqual(sidebarPanels(noMeta).extras.map(p => p.id), ['b', 'a', 'c']);
  assert.deepEqual(sidebarPanels([panel('plugins')]).fixed.map(p => p.id), ['plugins']);
});

test('workspace counts select a projection without mutating saved grouping or workspace records', () => {
  for (const count of [0, 1, 2]) {
    assert.equal(sidebarGrouping(count, 'workspace'), count <= 1 ? 'flat' : 'workspace');
    for (const saved of ['flat', 'workspace', 'workspace-tree']) {
      assert.equal(sidebarGrouping(count, saved, true), saved);
      assert.equal(sidebarGrouping(count, saved, false), count <= 1 ? 'flat' : 'workspace');
    }
    assert.equal(sidebarGrouping(count, 'flat'), 'flat');
    assert.equal(sidebarGrouping(count, 'workspace-tree'), 'workspace-tree');
  }
});

// Run the published component and its real preference actions with only framework services stubbed.
function workspaceHarness(text) {
  let registration, saved;
  let hookState, hookIndex;
  const document = { querySelector: () => null, head: { appendChild() {} }, createElement: () => ({ dataset: {}, setAttribute() {} }) };
  new vm.Script(text.replace('return module.exports;', 'return { createWorkspaceViewStore, WorkspaceBrowser };')).runInNewContext({ window: { __ModuleLoader__: { load: value => { registration = value; } } }, document, console });
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    '@deepseek-ai/cordis': { Service: class {} },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    react: { useMemo: fn => fn(), useState(value) {
      const index = hookIndex++;
      if (!(index in hookState)) hookState[index] = value;
      const state = hookState;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    }, useRef: value => ({ current: value }), useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@deepseek-ai/dsh-client-store': { defineStore(spec) { return { create() {
      const state = saved === undefined ? spec.init() : JSON.parse(saved);
      return { getSnapshot: () => state, actions: Object.fromEntries(Object.entries(spec.actions).map(([key, action]) => [key, (...args) => { action(state, ...args); saved = JSON.stringify(state); }])) };
    } }; } },
  };
  const module = registration.factory(name => { assert.ok(name in modules, name); return modules[name]; });
  return {
    seed(mode, explicit) { saved = JSON.stringify({ groupBy: mode, groupByExplicit: explicit, orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {} }); },
    // false explicitly clears manual intent while retaining the last selected value.
    clear() { saved = JSON.stringify({ ...JSON.parse(saved), groupByExplicit: false }); },
    mount(count) {
      const mountedHooks = [];
      const store = module.createWorkspaceViewStore().create();
      const state = { items: Array.from({ length: count }, (_, i) => ({ workspaceId: String(i), title: 'Example', path: '/example', sessionIds: [] })), phase: 'ready', state: 'ready', archivedSessionIds: [], pinnedSessionIds: [] };
      const render = () => {
        hookState = mountedHooks;
        hookIndex = 0;
        const nodes = allNodes(module.WorkspaceBrowser({
          wide: true, useHostInfo: pick => pick({ home: '/example' }), useShortcuts: pick => pick([]),
          useWorkspaceShortcuts: pick => pick({ searchRequest: 0, addRequested: false }),
          useSessions: pick => pick({ ids: [], byId: {}, phase: 'ready' }), useWorkspaces: pick => pick(state),
          useDirectoryFlow: () => false, useRemoteAccess: () => true, useWorkspaceActionRequest: () => null,
          useStore: pick => pick(store.getSnapshot()), actions: store.actions, t: key => key, renderSlot: () => null,
        }));
        const menu = nodes.find(node => node.type?.name === 'ViewOptionsMenu');
        const list = nodes.find(node => ['FlatList', 'SessionTree'].includes(node.type?.name));
        assert.ok(menu && list);
        assert.equal(list.type.name, menu.props.groupBy === 'flat' ? 'FlatList' : 'SessionTree');
        if (list.type.name === 'SessionTree') assert.equal(list.props.nestWorkspaces, menu.props.groupBy === 'workspace-tree');
        return menu.props;
      };
      return { render, pick: mode => render().onGroupPick(mode) };
    },
  };
}

test('manual grouping survives fresh mounts, legacy preferences work, and clearing intent restores auto', () => {
  const original = fs.readFileSync(path.join(source, '@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8');
  const ui = workspaceHarness(patchWorkspaceModule(original));
  for (const count of [2, 1, 0]) {
    for (const choice of ['flat', 'workspace', 'workspace-tree']) {
      ui.seed('workspace');
      const first = ui.mount(count);
      assert.equal(first.render().groupBy, count <= 1 ? 'flat' : 'workspace');
      first.pick(choice);
      assert.equal(first.render().groupBy, choice);
      assert.equal(ui.mount(count).render().groupBy, choice);
      assert.equal(ui.mount(count === 2 ? 1 : 2).render().groupBy, choice);
      ui.clear();
      assert.equal(ui.mount(count).render().groupBy, count <= 1 ? 'flat' : 'workspace');
    }
    for (const legacy of ['flat', 'workspace-tree']) {
      ui.seed(legacy);
      assert.equal(ui.mount(count).render().groupBy, legacy);
    }
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-sidebar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['ui-sidebar', 'ui-workspace'].map(name => {
    const relative = '@deepseek-ai/dsh-client-' + name;
    fs.cpSync(path.join(source, relative), path.join(root, relative), { recursive: true });
    return path.join(root, relative, 'lib/client.js');
  });
  return { root, files };
}

test('pinned browser modules parse, preserve hard links and mode, and are idempotent after market patch', t => {
  const { root, files } = fixture(t);
  fs.writeFileSync(files[0], patchMarketSidebar(fs.readFileSync(files[0], 'utf8')));
  const original = fs.readFileSync(files[0], 'utf8');
  fs.chmodSync(files[0], 0o640);
  const linked = path.join(root, 'original.js');
  fs.linkSync(files[0], linked);
  patchCompanySidebarRuntime(root);
  const first = files.map(file => fs.readFileSync(file, 'utf8'));
  first.forEach(text => new vm.Script(text));
  patchCompanySidebarRuntime(root);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), first);
  assert.equal(fs.readFileSync(linked, 'utf8'), original);
  assert.equal(fs.statSync(files[0]).mode & 0o777, 0o640);
});

test('version mismatch or workspace miss rejects the complete operation before any writes', t => {
  const { root, files } = fixture(t);
  const manifest = path.join(path.dirname(path.dirname(files[1])), 'package.json');
  const originalManifest = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(manifest, originalManifest.replace('0.2.2-rc.1', '0.2.2-rc.2'));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  assert.throws(() => patchCompanySidebarRuntime(root), /unsupported/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  fs.writeFileSync(manifest, originalManifest);
  fs.writeFileSync(files[1], before[1].replace('const SESSION_WATERMARK_BASE = 5;', 'const SESSION_WATERMARK_BASE = 6;'));
  const drift = files.map(file => fs.readFileSync(file, 'utf8'));
  assert.throws(() => patchCompanySidebarRuntime(root), /expected one match/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), drift);
});

test('navigation rejects an unrecognized upstream module', () => {
  assert.throws(() => patchSidebarModule('window.__ModuleLoader__.load({})'), /expected one match/);
});

function loadSidebar(text, desktop = false) {
  let registration;
  const document = { querySelector: () => null, documentElement: { hasAttribute: key => key === "data-platform" && desktop }, head: { appendChild() {} }, createElement: () => ({ dataset: {}, setAttribute() {} }) };
  new vm.Script(text).runInNewContext({ window: { __ModuleLoader__: { load: value => { registration = value; } } }, document, Intl, console, setTimeout, clearTimeout, process: { env: {} } });
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const hooks = { useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect() {}, useLayoutEffect() {} };
  const primitives = new Proxy({ isDarwinDesktop: () => false, useModalLayer() {} }, { get: (obj, key) => obj[key] ?? key });
  const modules = {
    '@deepseek-ai/dsh-client-store': { createSnapshotStore(initial) { let state = initial; return { getSnapshot: () => state, set: value => { state = value; }, subscribe: () => () => {} }; } },
    '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: label => typeof label === 'function' ? label() : label },
    'react/jsx-runtime': { jsx, jsxs: jsx }, react: hooks,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  };
  return registration.factory(name => { assert.ok(name in modules, 'unexpected dependency: ' + name); return modules[name]; });
}

function allNodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(allNodes);
  return [tree, ...allNodes(tree.props?.children), ...allNodes(tree.props?.anchor)];
}

test('published sidebar activates with declared dependencies, resolves inventory names, and renders real panel/menu callbacks', async () => {
  const original = fs.readFileSync(path.join(source, '@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'), 'utf8');
  const module = loadSidebar(patchSidebarModule(original), true);
  const entries = [panel('plugins', '市场'), panel('schedules', '自动化任务'), panel('baoyu-design.artifacts', '作品'), panel('p1', 'A row', 0, 'plugin1'), panel('p2', 'Z row', 1, 'plugin1'), panel('p3', 'A', 0, 'plugin2')];
  const warnings = [], slots = new Map(), dictionaries = {}, listeners = [];
  let selected, invoked;
  const ctx = {
    locale: { register(ns, dicts) { dictionaries[ns] = dicts.zh; return () => {}; }, subscribe: () => () => {}, resolveText: text => { assert.notEqual(text, undefined, 'resolveText requires registered text'); return typeof text === 'object' ? text.zh ?? text.en : text; } },
    slots: {
      entriesOfSlot: key => key === 'sidebar.panellist' ? entries.map(p => ({ options: { id: p.id, label: p.label, order: p.order }, registrant: p.owner })) : [],
      subscribe: (key, fn) => { listeners.push(fn); return () => {}; },
      inject: (key, fn) => fn(), register: (options, component) => { slots.set(options.name, { options, component }); return () => {}; },
    },
    effect: fn => fn(),
    get: name => name === 'uiWorkspace' ? { startSession() {}, requestSearch() { invoked = 'session.search'; } } : undefined,
    layout: { selectPanel: id => { selected = id; }, toggleSidebar() {} },
    shortcuts: { catalog: {} },
    remoteAccess: { whenAccess(action, fn) { assert.equal(action, 'pluginInventory/list'); for (const effect of fn()) assert.equal(typeof effect, 'function'); } },
    remote: { pluginInventory: { list: async () => ({ ok: true, value: { entries: [{ moduleName: 'plugin1', meta: { title: { zh: '阿尔法' } } }, { moduleName: 'plugin2', meta: { title: '兆华' } }] } }) }, $on: () => () => {} },
    logger: { warn: value => warnings.push(value) },
  };
  const guarded = new Proxy(ctx, { get(obj, name) { if (['remote', 'remoteAccess'].includes(name)) assert.ok(module.inject.includes(name), `${name} must be declared`); return obj[name]; } });
  module.apply(guarded);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warnings, []);
  const { options, component } = slots.get('sidebar');
  const injected = options.inject();
  injected.searchSessions();
  assert.equal(invoked, 'session.search');
  const leading = slots.get('shell.leading').component({ ...injected, useRemoteAccess: () => true, useShortcuts: pick => pick([]), t: key => dictionaries.sidebar[key] ?? key });
  const headerSearch = allNodes(leading).find(n => n.type === 'button' && n.props['data-zp-sidebar-search']);
  assert.ok(headerSearch, 'hidden desktop sidebar retains search in window chrome');
  invoked = undefined; headerSearch.props.onClick(); assert.equal(invoked, 'session.search');
  const props = { ...injected, collapsed: false, width: 280, drawer: false, useRemoteAccess: () => true, usePanels: pick => pick(injected.hooks.panels.getSnapshot()), useEntryPins: pick => pick([]), useEntryActions: pick => pick(false), useShortcuts: pick => pick([]), usePanelInfo: pick => pick({ activePanelId: 'p2' }), t: key => dictionaries.sidebar[key] ?? key, renderSlot: () => null };
  const nodes = allNodes(component(props));
  const rows = nodes.filter(n => n.type?.name === 'PanelRow');
  assert.deepEqual(rows.map(n => n.props.id), ['baoyu-design.artifacts', 'schedules', 'plugins']);
  assert.equal(rows[1].props.label, '自动化');
  const more = nodes.find(n => n.type?.name === 'PanelMoreMenu');
  assert.deepEqual(more.props.entries.map(p => p.id), ['p1', 'p2', 'p3']);
  const menu = more.type(more.props);
  menu.props.onSelect('p2');
  assert.equal(selected, 'p2');
  const visibleRows = rows.map(n => n.type(n.props));
  const market = allNodes(visibleRows[2]).find(n => n.type === 'button');
  assert.equal(market.props['aria-label'], '市场 · 插件·技能');
  const denied = allNodes(component({ ...props, useRemoteAccess: () => false }));
  assert.ok(!denied.some(n => n.type === 'button' && n.props['aria-label'] === '新对话'));
});
