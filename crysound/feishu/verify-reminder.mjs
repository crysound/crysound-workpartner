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
page.setDefaultTimeout(15000);
// Change only this preview tab's browser language; keep account preferences intact.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN'] });
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' });
});
const origin = process.env.APP_ORIGIN;
if (!origin) throw new Error('Set APP_ORIGIN to the existing authenticated app origin.');
const output = fileURLToPath(new URL('./reminder-evidence/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
const original = fs.readFileSync(new URL('./native/client.js', import.meta.url), 'utf8');
let mode = 'web', connected = false, unavailable = false, fail = false, projectRequests = 0, statusRequests = 0, authorizations = 0, blocked = false, onboarding = false;
let testDate = '2026-11-06T15:30:00Z';
const errors = [];
page.on('pageerror', error => errors.push(error.message));
if (process.env.REMINDER_TRACE) {
  page.on('request', request => console.log('request', new URL(request.url()).pathname));
  page.on('response', response => console.log('response', response.status(), new URL(response.url()).pathname));
  page.on('requestfailed', request => console.log('failed', new URL(request.url()).pathname, request.failure()));
}
if (new URL(page.url()).origin !== origin) await page.goto(origin + '/', { waitUntil: 'commit' });
const dayKey = 'zp-feishu-reminder-day';
const savedDay = await page.evaluate(key => localStorage.getItem(key), dayKey);
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  try {
  if (url.origin !== origin) return route.continue();
  if (url.pathname === '/manifest.webmanifest') return route.fulfill({ json: { name: 'Settings preview', start_url: '/' } });
  if (url.pathname.startsWith('/_zp/feishu/')) {
    if (url.pathname.includes('/project/')) { projectRequests++; return route.fulfill({ json: { connected: false } }); }
    if (url.pathname.endsWith('/status')) {
      statusRequests++;
      return route.fulfill({ status: fail ? 503 : 200, json: fail ? { message: '测试：暂时无法核实' } : { enabled: true, connected, revoking: unavailable } });
    }
    if (url.pathname.endsWith('/authorize')) { authorizations++; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname.endsWith('/connect')) {
      assert.equal(url.searchParams.get('display'), 'redirect');
      assert.equal(url.searchParams.get('return'), 'settings');
      connected = true;
      return route.fulfill({ contentType: 'text/html', body: "<script>sessionStorage.setItem('zp-feishu-return','1');location.replace('/?zp-settings=feishu')</script>" });
    }
    throw new Error('Unexpected authorization route: ' + url.pathname);
  }
  if (url.pathname === '/brand.js') return route.fulfill({ body: fs.readFileSync(new URL('../brand/brand.js', import.meta.url), 'utf8'), contentType: 'text/javascript' });
  if (url.pathname === '/welcome.js') return route.fulfill({ body: fs.readFileSync(new URL('../brand/welcome.js', import.meta.url), 'utf8'), contentType: 'text/javascript' });
  if (!url.pathname.startsWith('/plugins/') || !url.href.includes('/client.js')) {
    return ['document', 'script', 'stylesheet'].includes(route.request().resourceType())
      ? route.fulfill({ response: await route.fetch() }) : route.continue();
  }
  const response = await route.fetch();
  let text = await response.text();
  if (!text.includes('@deepseek-ai/dsh-client-ui-settings-general')) return route.fulfill({ response, body: text });
  text = text.replace('const onboardingStep = requestedOnboarding !== void 0', 'const onboardingStep = open && activeId !== void 0 ? void 0 : requestedOnboarding !== void 0');
  // The real shell supplies React and native controls; the branch module registers through its actual apply().
  // Desktop/embedded previews select only client branches. They do not emulate a native window/provider.
  const source = original.replace("const desktop = location.protocol === 'dsh-app:';", `const desktop = ${mode === 'desktop-preview'};`)
    .replace('const embedded = /Lark|Feishu/i.test(navigator.userAgent);', `const embedded = ${mode === 'embedded-preview'};`)
    .replace('window.__ModuleLoader__.load(', 'window.__zpFeishuReminderDefinition = (');
  const prefix = `(()=>{const Date=class extends globalThis.Date{constructor(...args){super(...(args.length?args:[${JSON.stringify(testDate)}]));}};${source}})();
(()=>{const previous=window.__ModuleLoader__.load;window.__ModuleLoader__.load=function(reg){if(reg.id==='@deepseek-ai/dsh-client-ui-settings-general'){const factory=reg.factory;reg={...reg,factory(require){const settings=factory(require);return {...settings,apply(ctx){settings.apply(ctx);${onboarding ? "document.getElementById('root').inert=true;" : ''}window.__zpFeishuReminderDefinition.factory(require).apply(ctx);}}}};}return previous.call(this,reg)}})();\n`;
  return route.fulfill({ response, body: prefix + text });
  } catch (error) {
    // Playwright's raw request errors include session cookies; keep diagnostics to the path.
    errors.push(`Preview request failed: ${url.pathname} (${error.name})`);
    await route.abort('failed');
  }
});
const banner = page.locator('.zp-feishu-banner');
const button = banner.getByRole('button', { name: '连接飞书', exact: true });
const dialog = page.getByRole('dialog', { name: '连接飞书，让助理帮你办事', exact: true });
const timezone = await context.newCDPSession(page);
async function focus() {
  const before = statusRequests;
  const response = page.waitForResponse(response => response.url().endsWith('/_zp/feishu/status'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await response;
  assert.ok(statusRequests > before);
}
async function state(value) {
  connected = value;
  await focus();
  if (value && !unavailable && !fail) await banner.waitFor({ state: 'detached' });
  else await banner.waitFor({ state: 'visible' });
}
async function shot(name) {
  await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled', mask: [page.locator('[data-slot="sidebar"] > *')], maskColor: '#e9e9ef' });
}
try {
  await timezone.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
  // The local calendar day differs from UTC, so UTC-based suppression fails this check.
  // Only the branch module's Date constructor is replaced; application/network timers stay real.
  await page.evaluate(key => localStorage.removeItem(key), dayKey);
  for (mode of ['web', 'embedded-preview', 'desktop-preview', 'popup-blocked']) {
    connected = false; unavailable = false; fail = false; blocked = mode === 'popup-blocked';
    await page.evaluate(key => localStorage.removeItem(key), dayKey);
    await page.setViewportSize(mode === 'embedded-preview' ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await button.waitFor();
    await dialog.waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), dayKey), '2026-11-7');
    assert.equal(projectRequests, 0, 'Home reminder must not query Feishu Project');
    // The branch owns only this tab. Stub the provider popup to avoid changing any real authorization.
    await page.evaluate(blocked => { window.open = () => blocked ? null : (window.__reminderPopup = { closed: false, location: { replace(url) { window.__reminderTarget = url; } }, close() { this.closed = true; } }); }, blocked);
    if (mode === 'web') {
      await shot('web-light-daily-dialog');
      await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; });
      await shot('web-dark-daily-dialog');
      await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light'; });
      await page.setViewportSize({ width: 390, height: 844 });
      const modalBox = await dialog.boundingBox();
      assert.ok(modalBox.x >= 0 && modalBox.x + modalBox.width <= 390);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot('web-narrow-daily-dialog');
      await dialog.getByRole('button', { name: '稍后', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await banner.waitFor();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await button.waitFor();
      assert.equal(await dialog.count(), 0, 'Second opening on the same local day must not show a dialog');
      testDate = '2026-11-07T15:30:00Z';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dialog.waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), dayKey), '2026-11-8');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await button.waitFor();
      assert.equal(await dialog.count(), 0, 'Closing the dialog also suppresses it for today');
      connected = true;
      await page.evaluate(key => localStorage.removeItem(key), dayKey);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await focus();
      assert.equal(await dialog.count(), 0, 'Already connected users must never get the daily dialog');
      assert.equal(await banner.count(), 0);
      connected = false; onboarding = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await banner.waitFor();
      assert.equal(await dialog.count(), 0, 'Onboarding must keep priority');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), dayKey), null, 'Onboarding must not consume the daily reminder');
      onboarding = false;
      await page.evaluate(() => { document.getElementById('root').inert = false; });
      await dialog.waitFor();
      // An onboarding stage appearing later also suspends the reminder until it ends.
      await page.evaluate(() => { document.getElementById('root').inert = true; });
      await dialog.waitFor({ state: 'detached' });
      await page.evaluate(() => { document.getElementById('root').inert = false; });
      await dialog.waitFor();
      await state(true);
      await dialog.waitFor({ state: 'detached' });
      await page.evaluate(({ key }) => localStorage.setItem(key, '2026-11-8'), { key: dayKey });
      await state(false);
      console.log('PASS daily first/same-day/next-day/connected/local-date/onboarding');
      await shot('web-light-disconnected');
      await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; });
      await shot('web-dark-disconnected');
      await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light'; });
      await page.setViewportSize({ width: 390, height: 844 });
      const box = await banner.boundingBox();
      const input = page.locator('[contenteditable="true"]').first();
      const inputBox = await input.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390 && inputBox.y >= box.y + box.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot('web-narrow-disconnected');
      await input.fill('提示条保留时仍能输入');
      assert.equal(await input.innerText(), '提示条保留时仍能输入');
      await input.fill('');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await state(true); // Project remains disconnected; no reminder.
      await shot('web-connected-project-disconnected');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await focus();
      assert.equal(await banner.count(), 0);
      await state(false); // Expired/revoked response from the same main status route.
      fail = true; await state(false);
      await banner.getByText('暂时无法核实飞书连接，请重新检查。').waitFor();
      fail = false;
      await banner.getByRole('button', { name: '重新检查' }).click();
      await button.waitFor();
      unavailable = true; await state(false);
      assert.equal(await button.isDisabled(), true);
      unavailable = false; await state(false);
      await page.evaluate(() => { window.open = () => (window.__reminderPopup = { closed:false, location:{replace(url){window.__reminderTarget=url;}}, close(){} }); });
    }
    if (mode === 'desktop-preview') await shot('desktop-preview-daily-dialog');
    const returnedStatus = mode === 'embedded-preview' || mode === 'popup-blocked'
      ? page.waitForResponse(response => response.url().endsWith('/_zp/feishu/status')) : null;
    if (mode === 'web') await button.click();
    else await dialog.getByRole('button', { name: '连接飞书', exact: true }).click();
    if (mode === 'embedded-preview' || mode === 'popup-blocked') {
      await returnedStatus;
      await page.waitForFunction(() => document.getElementById('root') && !sessionStorage.getItem('zp-feishu-return'));
      await banner.waitFor({ state: 'detached' });
      assert.equal(await page.locator('[data-shortcut-modal="settings"]').count(), 0);
      assert.equal(new URL(page.url()).search, '');
    } else if (mode === 'desktop-preview') {
      await banner.getByText('等待你完成授权').waitFor();
      await shot('desktop-preview-disconnected');
      assert.equal(authorizations, 1);
      await state(true);
    } else {
      assert.match(await page.evaluate(() => window.__reminderTarget), /connect\?return=settings&display=popup/);
      // The same popup and origin are required before re-reading actual status.
      connected = true;
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { type:'crysound.feishu.connected' } })));
      assert.equal(await banner.count(), 1, 'Unrelated window cannot complete authorization');
      // Polling also covers native windows that cannot post back to this renderer.
      await banner.waitFor({ state:'detached', timeout:6000 });
      assert.equal(new URL(page.url()).pathname, '/');
    }
    console.log('PASS', mode);
    testDate = '2026-11-06T15:30:00Z';
  }
  assert.equal(projectRequests, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: daily first/same-day/next-day/connected, local date, onboarding priority/resumption, later/close/connect, disconnected/connected/project-only/expired/unknown/revoking, popup and polling, fixed same-page returns, native authorize, narrow input, themes; fixture screenshots only.');
} finally {
  if (errors.length) console.error('Page errors:', errors);
  if (savedDay !== undefined) await page.evaluate(({ key, value }) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value), { key: dayKey, value: savedDay });
  await timezone.send('Emulation.setTimezoneOverride', { timezoneId: '' });
  await timezone.detach();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close();
}
