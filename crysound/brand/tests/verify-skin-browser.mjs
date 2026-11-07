/** Preview branch assets in an owned tab of the configured persistent browser.
 * Requires CDP_TAB, APP_ORIGIN, PLAYWRIGHT_MODULE and EVIDENCE_DIR. No server changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.CDP_TAB && process.env.APP_ORIGIN && process.env.EVIDENCE_DIR);
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page;
for (const candidate of context.pages()) {
  const cdp = await context.newCDPSession(candidate);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  if (targetInfo.targetId === process.env.CDP_TAB) { page = candidate; break; }
}
assert.ok(page, 'Owned tab must exist');
page.setDefaultTimeout(15000);
const origin = process.env.APP_ORIGIN;
const output = process.env.EVIDENCE_DIR;
fs.mkdirSync(output, { recursive: true });
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const css = read('../skin.css');
const boot = read('../skin.js');
const client = read('../../feishu/native/client.js');
const original = await page.evaluate(() => ({ value: localStorage.getItem('zp-interface-style'), url: location.href }));
const errors = [];
const report = { screenshots: [], checks: [], errors };
page.on('pageerror', error => errors.push(error.message));
const routeHandler = async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.continue();
  if (url.pathname === '/skin.js') return route.fulfill({ body: boot, contentType: 'text/javascript' });
  if (url.pathname === '/skin.css') return route.fulfill({ body: css, contentType: 'text/css' });
  if (url.pathname === '/brand.css') return route.fulfill({ body: read('../brand.css'), contentType: 'text/css' });
  if (url.pathname === '/brand.js') return route.fulfill({ body: read('../brand.js'), contentType: 'text/javascript' });
  if (route.request().isNavigationRequest() && route.request().resourceType() === 'document') {
    const response = await route.fetch();
    let body = await response.text();
    if (!body.includes('</head>')) return route.fulfill({ response, body });
    body = body.replace('</head>', '<script src="/skin.js"></script><script>window.__zpSkinHead=document.documentElement.dataset.zpSkin</script><link rel="stylesheet" href="/skin.css"></head>');
    return route.fulfill({ response, body });
  }
  if (url.pathname.startsWith('/plugins/') && url.href.includes('/client.js')) {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes('@crysound/feishu-settings')) {
      const prefix = client.replace('window.__ModuleLoader__.load(', 'window.__zpSkinDefinition = (');
      body = prefix + `\n;(() => { const load = window.__ModuleLoader__.load;
        window.__ModuleLoader__.load = function(reg) {
          return load.call(this, reg.id === '@crysound/feishu-settings' ? window.__zpSkinDefinition : reg);
        }; })();\n` + body;
    }
    return route.fulfill({ response, body });
  }
  return route.continue();
};
await page.route('**/*', routeHandler);
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  report.screenshots.push(name);
}
const settings = page.locator('[data-shortcut-modal="settings"]');
async function openSettings() {
  await page.locator('button[data-signed-out]').click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '兆华柔和', exact: true }).waitFor();
}
async function dark(value) {
  // Theme CSS preview only: do not write the account's persisted light/dark preference.
  await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), value);
}
async function skin(value) {
  assert.equal(await page.evaluate(value => window.zpSkin.set(value), value), true);
  assert.equal(await page.locator('html').getAttribute('data-zp-skin'), value);
}
async function pair(name, isDark) {
  await dark(isDark);
  const before = await page.locator('[class*="_panelRow"]').allTextContents();
  for (const value of ['default', 'soft']) {
    await skin(value);
    await screenshot(`${name}-${isDark ? 'dark' : 'light'}-${value}`);
    assert.deepEqual(await page.locator('[class*="_panelRow"]').allTextContents(), before);
  }
}
try {
  await page.evaluate(() => localStorage.removeItem('zp-interface-style'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => window.__zpSkinHead), 'default');
  report.checks.push('new device resolves default in the head before application modules execute');
  if (await page.getByRole('button', { name: '打开侧边栏', exact: true }).count()) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await openSettings();
  const labels = await settings.innerText();
  assert.ok(labels.indexOf('外观') < labels.indexOf('界面风格') && labels.indexOf('界面风格') < labels.indexOf('字号大小'));
  await page.getByRole('button', { name: '兆华柔和', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-zp-skin'), 'soft');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => window.__zpSkinHead), 'soft');
  assert.equal(await page.locator('html').getAttribute('data-zp-skin'), 'soft');
  report.checks.push('native setting is after Appearance; click applies immediately; reload resolves soft in head');
  await openSettings();
  await page.getByRole('button', { name: '默认', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-zp-skin'), 'default');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => window.__zpSkinHead), 'default');
  report.checks.push('return to default persists across reload');
  await openSettings();
  for (const d of [false, true]) await pair('settings', d);
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  // Existing conversation, read only. No messages are sent.
  await page.getByText(process.env.CONVERSATION_TITLE || '问候', { exact: true }).first().click();
  await page.locator('[data-slot="conversation.hero.brand.mark"]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '复制', exact: true }).first().waitFor();
  for (const d of [false, true]) {
    await pair('conversation', d);
    const button = page.locator('[data-composer-card] button[class*="_primary"]');
    if (await button.count()) {
      const color = await button.evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
      assert.equal(color.fill, d ? 'rgb(238, 238, 238)' : 'rgb(60, 63, 67)');
      assert.equal(color.ink, d ? 'rgb(21, 21, 21)' : 'rgb(252, 252, 252)');
      report.checks.push(`send colors ${d ? 'dark' : 'light'}: ${JSON.stringify(color)}`);
    }
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).last().click();
  await page.locator('[data-slot="conversation.hero.brand.mark"]').waitFor();
  for (const d of [false, true]) await pair('home', d);
  await dark(false); await skin('soft');
  // The default skin must leave all loaded default colors unchanged.
  await skin('default');
  const base = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base'));
  await page.evaluate(() => { document.querySelector('link[href="/skin.css"]').disabled = true; });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')), base);
  await page.evaluate(() => { document.querySelector('link[href="/skin.css"]').disabled = false; });
  report.checks.push('disabled skin matches the original page background with its stylesheet disabled');
  await skin('soft');
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await screenshot('home-collapsed-soft');
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  for (const label of ['市场', '作品']) {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    if (label === '市场') await page.getByText('兆华看板', { exact: true }).first().waitFor({ timeout: 45000 });
    else await page.getByText('设计系统', { exact: true }).first().waitFor();
    for (const d of [false, true]) await pair(label === '市场' ? 'market' : 'artifacts', d);
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).last().click();
  await dark(false); await skin('soft');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('home-mobile-soft');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  report.checks.push('390px mobile viewport has no horizontal document overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const platform of ['darwin', 'win32', 'web']) {
    await page.evaluate(p => { if (p === 'web') delete document.documentElement.dataset.platform; else document.documentElement.dataset.platform = p; }, platform);
    await dark(false);
    const fill = await page.locator('[class*="_sidebarCol"]').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(fill, platform === 'darwin' ? 'rgba(238, 238, 233, 0.85)' : 'rgb(238, 238, 233)');
    report.checks.push(`${platform} sidebar CSS fill: ${fill}`);
  }
  assert.deepEqual(errors, []);
  report.completed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.completed = false;
  report.failure = error.message;
  throw error;
} finally {
  await page.unroute('**/*', routeHandler);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(value => { if (value === null) localStorage.removeItem('zp-interface-style'); else localStorage.setItem('zp-interface-style', value); }, original.value);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
