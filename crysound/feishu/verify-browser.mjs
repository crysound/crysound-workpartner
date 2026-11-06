/** Screenshot/state verification in an owned tab of the configured persistent browser.
 * Run with CDP_TAB, CDP_ENDPOINT, APP_ORIGIN and PLAYWRIGHT_MODULE (an existing installation).
 * This uses fixture authorization responses. It never changes real user authorization.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (!process.env.CDP_TAB) throw new Error('Set CDP_TAB to an owned browser tab.');
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page;
for (const candidate of context.pages()) {
  const cdp = await context.newCDPSession(candidate);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  if (targetInfo.targetId === process.env.CDP_TAB) { page = candidate; break; }
}
if (!page) throw new Error('Owned tab is no longer available.');
const origin = process.env.APP_ORIGIN;
if (!origin) throw new Error('Set APP_ORIGIN to the existing authenticated app origin.');
const output = fileURLToPath(new URL('./evidence/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
const original = fs.readFileSync(new URL('./native/client.js', import.meta.url), 'utf8');
let mode = 'web', connected = false;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.continue();
  if (url.pathname === '/manifest.webmanifest') return route.fulfill({ json: { name: 'Settings preview', start_url: '/' } });
  if (url.pathname.startsWith('/_zp/feishu/')) {
    if (url.pathname.endsWith('/disconnect')) { connected = false; return route.fulfill({ json: { connected: false } }); }
    if (url.pathname.endsWith('/project/status')) return route.fulfill({ json: { connected } });
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { enabled: true, connected, name: connected ? '测试同事' : undefined, authorizedAt: connected ? '2026-11-07T00:00:00Z' : undefined } });
    return route.fulfill({ status: 409, json: { message: '测试预览不发起真实授权' } });
  }
  if (url.pathname === '/brand.js') return route.fulfill({ body: fs.readFileSync(new URL('../brand/brand.js', import.meta.url), 'utf8'), contentType: 'text/javascript' });
  if (!url.pathname.startsWith('/plugins/') || !url.href.includes('/client.js')) return route.continue();
  const response = await route.fetch();
  let text = await response.text();
  if (!text.includes('@deepseek-ai/dsh-client-ui-settings-general')) return route.fulfill({ response, body: text });
  text = text.replace('const onboardingStep = requestedOnboarding !== void 0', 'const onboardingStep = open && activeId !== void 0 ? void 0 : requestedOnboarding !== void 0');
  console.log('return patch', text.includes('const onboardingStep = open && activeId'));
  // The real shell supplies React and native controls; the branch module registers through its actual apply().
  // Desktop/embedded previews select only client branches. They do not emulate a native window/provider.
  const source = original.replace("const desktop = location.protocol === 'dsh-app:';", `const desktop = ${mode === 'desktop-preview'};`)
    .replace('const embedded = /Lark|Feishu/i.test(navigator.userAgent);', `const embedded = ${mode === 'embedded-preview'};`)
    .replace('window.__ModuleLoader__.load(', 'register(');
  const prefix = `(()=>{const previous=window.__ModuleLoader__.load;window.__ModuleLoader__.load=function(reg){if(reg.id==='@deepseek-ai/dsh-client-ui-settings-general'){const original=reg.factory;reg={...reg,factory(require){const api=original(require);return {...api,apply(ctx){api.apply(ctx);let native;new Function('register',${JSON.stringify(source)})(reg=>{native=reg});native.factory(require).apply(ctx);}}}};}return previous.call(this,reg)}})();\n`;
  new Function(prefix);
  return route.fulfill({ response, body: prefix + text });
});
const panel = page.locator('[data-shortcut-modal="settings"]');
async function status(value) {
  connected = value;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel.getByText(value ? /已连接 · 测试同事/ : '未连接', { exact: !value }).first().waitFor();
}
async function shot(name) { console.log('capture', name); await panel.screenshot({ path: `${output}/${name}.png`, timeout: 15000, animations: 'disabled' }); }
try {
  for (mode of ['web', 'embedded-preview', 'desktop-preview']) {
    console.log('mode', mode); connected = false;
    await page.setViewportSize(mode === 'embedded-preview' ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.evaluate(() => sessionStorage.setItem('zp-feishu-return', '1'));
    await page.goto(origin + '/?zp-settings=feishu', { waitUntil: 'domcontentloaded' });
    console.log('loaded',mode);
    await panel.getByRole('heading', { name: '飞书授权', exact: true }).waitFor();
    console.log('heading',mode); await status(false); console.log('status',mode);
    assert.equal(await panel.locator('nav a').count(), 0);
    const nav = panel.locator('nav button').filter({ hasText: /^飞书授权$/ });
    assert.equal(await nav.getAttribute('aria-current'), 'true');
    assert.equal(await nav.locator('svg').count(), 1);
    await shot(mode + (mode === 'web' ? '-wide' : '') + '-disconnected');
    await status(true);
    await shot(mode + (mode === 'web' ? '-wide' : '') + '-connected');
    if (mode !== 'web') continue;
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('web-narrow-connected'); await status(false); await shot('web-narrow-disconnected');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; });
    await shot('web-dark-disconnected'); await status(true); await shot('web-dark-connected');
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light'; });
    // Observe the real click handler while preventing all provider navigation.
    await page.evaluate(() => { window.open = () => ({ closed: false, location: { replace(url) { window.__previewTarget = url; } }, close() {} }); });
    const feishu = panel.locator('.zp-feishu-row').first();
    await feishu.getByRole('button', { name: '重新授权', exact: true }).click();
    assert.match(await page.evaluate(() => window.__previewTarget), /connect\?return=settings&display=popup/);
    assert.equal(new URL(page.url()).pathname, '/');
    await feishu.getByRole('button', { name: '断开', exact: true }).click();
    await feishu.getByText('断开后，伙伴将无法继续使用这项授权。确认断开？').waitFor();
    await feishu.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await feishu.getByText(/已连接 · 测试同事/).count(), 1);
    await feishu.getByRole('button', { name: '断开', exact: true }).click();
    await feishu.getByRole('button', { name: '断开', exact: true }).click();
    await feishu.getByText('未连接', { exact: true }).waitFor();
    await panel.locator('nav button').first().click();
    assert.equal(await nav.getAttribute('aria-current'), null);
    await shot('navigation-unselected');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: native navigation, icon, fixed popup target, focus refresh, disconnect confirmation/cancel, theme and 11 fixture screenshots.');
} finally {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close();
}
