// Use only an explicitly owned tab in the configured persistent browser.
// Real native settings and controls; every memory/reminder request uses temporary data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../plugins/memory/store.mjs';
import { registerPanel } from '../plugins/memory/panel.mjs';
import { createDailyCheck, createDailyCheckHandler } from '../daily-check/service.mjs';

if (!process.env.CDP_TAB || !process.env.APP_ORIGIN) throw new Error('Set CDP_TAB and APP_ORIGIN');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222');
let page;
for (const candidate of browser.contexts()[0].pages()) {
  const cdp = await browser.contexts()[0].newCDPSession(candidate);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  if (targetInfo.targetId === process.env.CDP_TAB) { page = candidate; break; }
}
if (!page) { await browser.close(); throw new Error('Owned tab missing'); }
page.setDefaultTimeout(15000);
const origin = new URL(process.env.APP_ORIGIN).origin;
const output = process.env.SETTINGS_EVIDENCE || fileURLToPath(new URL('../settings-evidence/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-pages-'));
const store = new MemoryStore(path.join(directory, 'memory'));
const memoryRoutes = new Map();
registerPanel({ effect: work => work(), webStartup: { trustedHosts: [] },
  webServer: { host: '127.0.0.1', register: route => { memoryRoutes.set(route.path, route.handler); return () => memoryRoutes.delete(route.path); } },
}, store);
const user = { unionId: 'settings-preview', slug: 'preview' };
const dailyDirectory = path.join(directory, 'daily');
let reads = 0;
const daily = createDailyCheck({ directory: dailyDirectory, users: () => [user], available: () => true, connected: () => true,
  now: () => Date.parse('2026-11-09T11:00:00+08:00'), collect: async () => { reads++; return []; },
  summarize: async () => { throw new Error('Empty data must not use a model'); },
});
daily.configure(user, { enabled: true, time: '10:45' });
await daily.run(user, true);
const savedFile = path.join(dailyDirectory, fs.readdirSync(dailyDirectory)[0]);
const savedDaily = fs.readFileSync(savedFile, 'utf8');
const dailyBefore = daily.status(user);
let dailyHandler;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const memory = memoryRoutes.get(url.pathname);
  if (memory) return memory(req, res);
  if (await dailyHandler(req, res, url)) return;
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const backend = `http://127.0.0.1:${server.address().port}`;
dailyHandler = createDailyCheckHandler({ service: daily, identify: () => user, origin: backend });
const source = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const memory = source('../plugins/memory/client.js').replace('window.__ModuleLoader__.load(', 'window.__zpMemoryPreview = (');
const feishu = source('../feishu/native/client.js').replace('window.__ModuleLoader__.load(', 'window.__zpFeishuPreview = (');
const skinFile = process.env.PREVIEW_SKIN_CSS || fileURLToPath(new URL('../brand/skin.css', import.meta.url));
const skin = fs.readFileSync(skinFile, 'utf8');
function attach() {
  const load = window.__ModuleLoader__.load;
  window.__ModuleLoader__.load = registration => load.call(window.__ModuleLoader__,
    registration.id === '@crysound/memory' ? window.__zpMemoryPreview :
    registration.id === '@crysound/feishu-settings' ? window.__zpFeishuPreview : registration);
}
const errors = [], requests = [], measurements = [];
const marketControl = process.env.SETTINGS_MARKET_CONTROL === '1';
const pageError = error => errors.push(error.message);
page.on('pageerror', pageError);
let attached = false, marketPatched = false;
const patchRoot = path.join(directory, 'runtime');
const marketFile = path.join(patchRoot, 'dshmarket/client/client.js');
fs.mkdirSync(path.dirname(marketFile), { recursive: true });
const patcher = fileURLToPath(new URL('../config/plugin-patches.mjs', import.meta.url));
await page.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== origin) return route.continue();
  if (url.pathname.startsWith('/crysound-memory/api/') || url.pathname.startsWith('/_zp/daily-check/')) {
    requests.push({ route: url.pathname, method: req.method() });
    const response = await fetch(backend + url.pathname, { method: req.method(), headers: { origin: backend, 'content-type': 'application/json' },
      ...(req.method() === 'POST' ? { body: req.postData() } : {}),
    });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  }
  if (url.pathname.startsWith('/_zp/feishu/')) {
    return route.fulfill({ status: req.method() === 'GET' ? 200 : 409,
      json: req.method() === 'GET' ? { enabled: true, connected: true } : { error: 'Preview cannot change authorization' } });
  }
  if (!url.pathname.startsWith('/plugins/') || !url.href.includes('/client.js')) return route.continue();
  const response = await route.fetch(); let text = await response.text();
  if (!marketControl && text.includes('id: "dshmarket"')) {
    fs.writeFileSync(marketFile, text);
    execFileSync(process.execPath, [patcher, patchRoot]);
    text = fs.readFileSync(marketFile, 'utf8');
    assert.ok(text.includes('name: "settings.section.icon", id: "market"'));
    assert.ok(!text.includes('data-dsh-market-nav-icon'));
    execFileSync(process.execPath, [patcher, patchRoot]);
    assert.equal(fs.readFileSync(marketFile, 'utf8'), text, 'Market patch is idempotent');
    marketPatched = true;
  }
  // The loader changes from bootstrap queue to live module system between bundles.
  if (text.includes('@deepseek-ai/dsh-client-ui-settings-general') || text.includes("id: '@crysound/memory'") || text.includes("id: '@crysound/feishu-settings'")) {
    text = memory + '\n' + feishu + '\n;(' + attach.toString() + ')();\n' + text;
    attached = true;
  }
  return route.fulfill({ response, body: text });
});
const panel = page.locator('[data-shortcut-modal="settings"]');
const memoryPanel = panel.locator('.zp-memory');
const reminderPanel = panel.locator('.zp-daily');
const nav = label => panel.locator('nav button').filter({ hasText: new RegExp('^' + label + '$') });
async function screenshot(name) { await panel.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
async function navigationIcons() {
  const icons = await panel.locator('nav').evaluate(el => [...el.querySelectorAll('button')].map(button => {
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none';
    };
    const svgs = [...button.querySelectorAll('svg')].filter(visible);
    const pseudo = [...button.querySelectorAll('*'), button].flatMap(node => ['::before', '::after'].flatMap(part => {
      const style = getComputedStyle(node, part);
      return visible(node) && !['none', 'normal'].includes(style.content) && style.display !== 'none' &&
        parseFloat(style.width) > 0 && parseFloat(style.height) > 0 ? [{ part, content: style.content }] : [];
    }));
    return {
      label: button.innerText, visibleSvg: svgs.map(svg => svg.getAttribute('data-icon')),
      pseudo, count: svgs.length + pseudo.length, x: svgs[0]?.getBoundingClientRect().x,
      slot: !!button.querySelector('[aria-hidden="true"] [data-slot="settings.section.icon"] svg'),
      marketRects: button.querySelectorAll('[data-slot="settings.section.icon"] svg rect').length,
    };
  }));
  const expected = {
    '通用设置': 'dsw-icon-settings-outline-medium', '模型': 'dsw-icon-data-outline-medium',
    '内置插件': 'dsw-icon-personalization-outline-medium', 'Agent 预设': 'dsw-icon-agent-preset-outline-medium',
    '飞书授权': 'dsw-icon-link-outline-medium', '主动提醒': 'crysound-reminder-bell', '记忆': 'crysound-memory-bookmark',
  };
  for (const [label, icon] of Object.entries(expected)) {
    assert.deepEqual(icons.find(row => row.label === label)?.visibleSvg, [icon], `${label} retains its glyph`);
  }
  for (const row of icons) {
    assert.equal(row.count, 1, `${row.label}: exactly one visible icon`);
    assert.equal(row.slot, true, `${row.label}: real shell wraps the SVG in its icon slot`);
    assert.ok(Math.abs(row.x - icons[0].x) < 0.5, `${row.label}: icons align`);
  }
  const market = icons.find(row => row.label === '插件市场');
  assert.ok(market.marketRects > 1, 'Market uses its existing block glyph');
  assert.deepEqual(market.visibleSvg, [null], 'No settings gear remains in the market row');
  return icons;
}
async function add(title) {
  await memoryPanel.getByRole('button', { name: '添加一条', exact: true }).click();
  await memoryPanel.getByLabel('标题', { exact: true }).fill(title);
  await memoryPanel.getByLabel('内容', { exact: true }).fill('这是隔离测试中的合成偏好。');
  await memoryPanel.getByRole('button', { name: '保存', exact: true }).click();
  await memoryPanel.getByRole('heading', { name: title, exact: true }).waitFor();
}
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/?zp-settings=feishu', { waitUntil: 'domcontentloaded' });
  await panel.getByRole('heading', { name: '飞书授权', exact: true }).waitFor();
  await page.addStyleTag({ content: skin });
  assert.equal(attached, true); assert.equal(marketPatched, !marketControl);
  if (process.env.SETTINGS_ICONS_ONLY === '1') {
    await nav('主动提醒').click();
    await reminderPanel.getByRole('heading', { name: '主动提醒', exact: true }).waitFor();
    for (const appearance of ['default', 'soft']) for (const mode of ['light', 'dark']) {
      await page.evaluate(({ appearance, mode }) => {
        document.documentElement.dataset.zpSkin = appearance;
        document.body.toggleAttribute('data-ds-dark-theme', mode === 'dark');
        document.documentElement.style.colorScheme = mode;
      }, { appearance, mode });
      const icons = await navigationIcons();
      measurements.push({ appearance, mode, icons });
      await screenshot(`${appearance}-${mode}-market-icon`);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'market-icons.json'), JSON.stringify({
      measurements, errors, marketPatchIdempotent: true, shell: 'Unmodified live settings module with nested settings.section.icon slots',
      unverified: ['Production deployment', 'Desktop installed package'],
    }, null, 2) + '\n');
    console.log('PASS: four appearances, real nested settings icon slots, exactly one aligned market glyph, all other navigation glyphs unchanged.');
  } else {
  await nav('记忆').click();
  await memoryPanel.getByRole('switch', { name: '使用记忆' }).waitFor();
  assert.equal(await memoryPanel.getByText('删除后，', { exact: false }).count(), 0);
  assert.equal(await memoryPanel.getByRole('button', { name: '清空全部', exact: true }).count(), 0);
  await memoryPanel.getByText('还没有个人记忆。聊到你的工作或偏好时，伙伴会主动记下。', { exact: true }).waitFor();
  const toggle = memoryPanel.getByRole('switch', { name: '使用记忆' });
  await toggle.click(); await memoryPanel.getByText('已关闭。', { exact: false }).waitFor();
  assert.equal(store.snapshot().enabled, false);
  await toggle.click(); await page.waitForFunction(() => document.querySelector('.zp-memory [role=switch]')?.getAttribute('aria-checked') === 'true');
  assert.equal(store.snapshot().enabled, true);
  for (const appearance of ['default', 'soft']) for (const mode of ['light', 'dark']) {
    await page.evaluate(({ appearance, mode }) => {
      document.documentElement.dataset.zpSkin = appearance;
      document.body.toggleAttribute('data-ds-dark-theme', mode === 'dark');
      document.documentElement.style.colorScheme = mode;
    }, { appearance, mode });
    await screenshot(`${appearance}-${mode}-memory-empty`);
    await add('测试报告偏好');
    const style = await memoryPanel.evaluate(el => ({
      titleSize: getComputedStyle(el.querySelector('h2')).fontSize,
      text: getComputedStyle(el).color,
      secondary: getComputedStyle(el.querySelector('.zp-memory-muted')).color,
      danger: getComputedStyle(el.querySelector('.zp-memory-danger')).color,
      dangerToken: getComputedStyle(el).getPropertyValue('--dsw-alias-state-error-primary').trim(),
      fieldOverflow: el.scrollWidth > el.clientWidth,
    }));
    assert.equal(style.titleSize, '16px'); assert.ok(style.dangerToken); assert.equal(style.fieldOverflow, false);
    await screenshot(`${appearance}-${mode}-memory`);
    const row = memoryPanel.locator('[data-memory-id]').first();
    await row.getByRole('button', { name: '编辑：测试报告偏好', exact: true }).click();
    await memoryPanel.getByLabel('内容', { exact: true }).fill('改用简洁的要点列表。');
    await memoryPanel.getByRole('button', { name: '保存', exact: true }).click();
    await row.getByText('改用简洁的要点列表。', { exact: true }).waitFor();
    assert.equal(store.snapshot().facts[0].content, '改用简洁的要点列表。');
    await row.getByRole('button', { name: '删除：测试报告偏好', exact: true }).click();
    assert.equal(store.snapshot().facts.length, 1, 'Opening deletion confirmation cannot delete');
    await row.getByRole('button', { name: '取消', exact: true }).click();
    await row.getByRole('button', { name: '删除：测试报告偏好', exact: true }).click();
    await row.getByRole('button', { name: '确认删除', exact: true }).click();
    await memoryPanel.locator('.zp-memory-empty').waitFor(); assert.equal(store.snapshot().facts.length, 0);
    await add('测试保留条目'); await add('测试清空条目');
    await memoryPanel.getByRole('button', { name: '清空全部', exact: true }).click();
    assert.equal(store.snapshot().facts.length, 2, 'Opening clear confirmation cannot delete');
    await screenshot(`${appearance}-${mode}-memory-clear`);
    const confirmation = memoryPanel.getByRole('group', { name: '确认清空全部个人记忆' });
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(store.snapshot().facts.length, 2);
    await memoryPanel.getByRole('button', { name: '清空全部', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认清空全部个人记忆', exact: true }).click();
    await memoryPanel.locator('.zp-memory-empty').waitFor(); assert.equal(store.snapshot().facts.length, 0);
    await nav('主动提醒').click();
    await reminderPanel.getByText('2026-11-09 · 没有新事，未发消息', { exact: true }).waitFor();
    assert.equal(await reminderPanel.getByRole('switch', { name: '主动提醒' }).isChecked(), true);
    assert.equal(await reminderPanel.locator('input[type=time]').inputValue(), '10:45');
    assert.deepEqual(daily.status(user), dailyBefore);
    assert.equal(fs.readFileSync(savedFile, 'utf8'), savedDaily, 'Renamed UI must not rewrite existing state');
    const dailyTitleSize = await reminderPanel.locator('h2').evaluate(el => getComputedStyle(el).fontSize);
    assert.equal(dailyTitleSize, style.titleSize);
    const icons = await navigationIcons();
    measurements.push({ appearance, mode, ...style, dailyTitleSize, icons });
    await screenshot(`${appearance}-${mode}-reminders`);
    await nav('记忆').click();
  }
  await nav('主动提醒').click();
  const reminderToggle = reminderPanel.getByRole('switch', { name: '主动提醒' });
  await reminderToggle.click(); await reminderPanel.getByText('默认关闭', { exact: true }).waitFor();
  assert.equal(daily.status(user).enabled, false);
  await reminderToggle.click(); await reminderPanel.getByText('已打开', { exact: true }).waitFor();
  const time = reminderPanel.locator('input[type=time]');
  for (const value of ['10:30', '10:45']) {
    await time.fill(value);
    await reminderPanel.getByRole('button', { name: '保存时间', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.zp-daily input[type=time]')?.disabled === false);
    assert.equal(daily.status(user).time, value);
  }
  assert.equal(fs.readFileSync(savedFile, 'utf8'), savedDaily, 'Toggling and time edits retain prior history');
  await nav('记忆').click();
  await add('窄屏测试条目');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('narrow-memory');
  assert.equal(await memoryPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(reads, 1, 'Viewing settings never runs the reminder');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({
    backend: 'Temporary real SQLite memory store + real HTTP handlers; synthetic saved reminder state',
    skinSha256: createHash('sha256').update(skin).digest('hex'),
    measurements, requests, errors, reminderFileUnchanged: true, marketPatchIdempotent: true,
    unverified: ['Production deployment and real user data', 'Desktop installed package'],
  }, null, 2) + '\n');
  console.log('PASS: four appearances, native controls, memory enable/add/edit/delete/clear confirmations, narrow layout, distinct icons, one market glyph, existing reminder state byte-for-byte unchanged. Synthetic data only.');
  }
} catch (error) {
  console.error(JSON.stringify({ errors, requests, panel: await panel.innerText().catch(() => '') }));
  throw error;
} finally {
  await page.unrouteAll({ behavior: 'wait' });
  page.off('pageerror', pageError);
  // Leave no injected UI in the authenticated tab after removing request isolation.
  await page.goto('about:blank');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
  await browser.close();
}
