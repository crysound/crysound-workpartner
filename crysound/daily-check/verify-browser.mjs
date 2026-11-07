// Run only in your own tab of the configured persistent browser.
// Real native app/React/controls + this branch module + isolated HTTP handler.
// All daily-check and Feishu requests in this tab are intercepted; no real
// authorization, personal settings, model quota or production session is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDailyCheck, createDailyCheckHandler } from './service.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (!process.env.CDP_TAB || !process.env.APP_ORIGIN) throw new Error('Set CDP_TAB and APP_ORIGIN');
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page;
for (const candidate of context.pages()) {
  const cdp = await context.newCDPSession(candidate);
  const { targetInfo } = await cdp.send('Target.getTargetInfo'); await cdp.detach();
  if (targetInfo.targetId === process.env.CDP_TAB) { page = candidate; break; }
}
if (!page) throw new Error('Owned tab missing');
const origin = process.env.APP_ORIGIN;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-check-browser-'));
const user = { unionId: 'preview-only', slug: 'preview' };
let connection = true, clock = Date.parse('2026-11-09T09:00:00+08:00'), reads = 0, summaries = 0;
const service = createDailyCheck({ directory, users: () => [user], connected: () => connection, available: () => true, now: () => clock,
  collect: async () => { reads++; return []; }, summarize: async () => { summaries++; throw new Error('Empty data must not reach model'); } });
const handler = createDailyCheckHandler({ service, identify: () => user, origin });
const server = http.createServer(async (req, res) => { await handler(req, res, new URL(req.url, origin)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const backend = `http://127.0.0.1:${server.address().port}`;
const output = fileURLToPath(new URL('./evidence/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
const english = process.env.PREVIEW_LANGUAGE === 'en';
// Only this tab's injected module uses the preview dictionary; saved app language is untouched.
const original = fs.readFileSync(new URL('../feishu/native/client.js', import.meta.url), 'utf8')
  .replace("ctx.locale.register(namespace, 'zh', zh)", english ? "ctx.locale.register(namespace, 'zh', en)" : "ctx.locale.register(namespace, 'zh', zh)");
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] });
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });
});
function attach() {
  const previous = window.__ModuleLoader__.load;
  window.__ModuleLoader__.load = registration => {
    if (registration.id === '@deepseek-ai/dsh-client-ui-settings-general') {
      const factory = registration.factory;
      registration = { ...registration, factory(require) {
        const settings = factory(require);
        return { ...settings, apply(ctx) { settings.apply(ctx); window.__zpDailyPreview.factory(require).apply(ctx); } };
      } };
    }
    return previous.call(window.__ModuleLoader__, registration);
  };
}
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.continue();
  if (url.pathname.startsWith('/_zp/daily-check/')) {
    requests.push(url.pathname);
    const req = route.request();
    const response = await fetch(backend + url.pathname, { method: req.method(), headers: { origin }, ...(req.method() === 'POST' ? { body: req.postData() } : {}) });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  }
  if (url.pathname.startsWith('/_zp/feishu/')) {
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { enabled: true, connected: connection } });
    return route.fulfill({ status: 409, json: { message: '预览不会修改实际飞书授权' } });
  }
  if (!url.pathname.startsWith('/plugins/') || !url.href.includes('/client.js')) return route.continue();
  const response = await route.fetch(); let text = await response.text();
  if (!text.includes('@deepseek-ai/dsh-client-ui-settings-general')) return route.fulfill({ response, body: text });
  text = text.replace('const onboardingStep = requestedOnboarding !== void 0', 'const onboardingStep = open && activeId !== void 0 ? void 0 : requestedOnboarding !== void 0');
  const source = original.replace('window.__ModuleLoader__.load(', 'window.__zpDailyPreview = (');
  return route.fulfill({ response, body: source + '\n;(' + attach.toString() + ')();\n' + text });
});
const panel = page.locator('[data-shortcut-modal="settings"]');
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/?zp-settings=feishu', { waitUntil: 'domcontentloaded' });
  if (english) {
    await panel.getByRole('heading', { name: 'Feishu authorization', exact: true }).waitFor();
    await panel.locator('nav button').filter({ hasText: /^Proactive reminders$/ }).click();
    const toggle = panel.getByRole('switch', { name: 'Proactive reminders' });
    await panel.getByText('Off by default', { exact: true }).waitFor();
    await panel.getByText(/Summaries use your model credits/).waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.click(); await panel.getByText('On', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Check now', exact: true }).click();
    await panel.getByText('2026-11-09 · No new items; no message sent', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Check now', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: /already attempted today/ }).waitFor();
    assert.doesNotMatch(await panel.locator('.zp-daily').innerText(), /[\u4e00-\u9fff]/u);
    assert.equal(reads, 1); assert.equal(summaries, 0); assert.deepEqual(errors, []);
    await panel.screenshot({ path: output + '/settings-english-quiet.png', animations: 'disabled' });
    console.log('PASS: native English daily-check navigation, disclosure, controls, quiet outcome and duplicate-run error. Tab-local dictionary preview; saved language unchanged.');
  } else {
  await panel.getByRole('heading', { name: '飞书授权', exact: true }).waitFor();
  await panel.locator('nav button').filter({ hasText: /^主动提醒$/ }).click();
  const toggle = panel.getByRole('switch', { name: '主动提醒' });
  await panel.getByText('默认关闭', { exact: true }).waitFor(); assert.equal(await toggle.isChecked(), false);
  await panel.getByText(/生成摘要会使用模型额度/).waitFor();
  await panel.screenshot({ path: output + '/settings-light-off.png', animations: 'disabled' });
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; });
  await panel.screenshot({ path: output + '/settings-dark-off.png', animations: 'disabled' });
  await toggle.click(); await panel.getByText('已打开', { exact: true }).waitFor();
  assert.equal(service.status(user).enabled, true);
  await panel.getByRole('button', { name: '现在查一次', exact: true }).click();
  await panel.getByText('2026-11-09 · 没有新事，未发消息', { exact: true }).waitFor();
  assert.equal(reads, 1); assert.equal(summaries, 0); assert.deepEqual(service.pending(user), []);
  await panel.screenshot({ path: output + '/settings-dark-quiet.png', animations: 'disabled' });
  await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light'; });
  await panel.screenshot({ path: output + '/settings-light-quiet.png', animations: 'disabled' });
  await panel.getByRole('button', { name: '现在查一次', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: /今天已经/ }).waitFor(); assert.equal(reads, 1);
  await toggle.click(); await panel.getByText('默认关闭', { exact: true }).waitFor();
  const time = panel.locator('input[type=time]'); await time.fill('10:30');
  await panel.getByRole('button', { name: '保存时间', exact: true }).click();
  await panel.getByRole('button', { name: '保存时间', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.zp-daily input[type=time]')?.disabled === false);
  assert.equal(service.status(user).time, '10:30');
  connection = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel.getByText('尚未连接飞书，检查不会运行。', { exact: false }).waitFor();
  assert.equal(await toggle.isDisabled(), true);
  assert.equal(await panel.getByRole('link', { name: '去连接飞书' }).getAttribute('href'), '/?zp-settings=feishu');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.screenshot({ path: output + '/settings-narrow-disconnected.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  assert.ok(requests.some(route => route.endsWith('/run')));
  console.log('PASS: native settings, default-off disclosure, enable/disable, quiet run without model/message, duplicate suppression, time save, disconnected link, light/dark and narrow screenshots. Fixture backend; production account run and real Host delivery remain unverified.');
  }
} finally {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
  await browser.close();
}
