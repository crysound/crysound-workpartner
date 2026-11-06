/** Real-browser fixture check; run in an environment with the existing shared runtime. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowser } from '../scripts/browser-runtime.mjs';
import { inspectDocument, prepareDocument } from '../scripts/inspect-document.mjs';

const output = await mkdtemp(join(tmpdir(), 'crysound-design-browser-'));
await withBrowser(async browser => {
  const page = await browser.newPage();
  try {
    const good = [];
    await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>设计体检演示</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;font:16px system-ui;background:white;color:#170057}main{max-width:700px;margin:auto}button{min-height:44px;padding:8px 24px;background:#170057;color:white;border:0}button:focus-visible{outline:3px solid #ffb020}h1{font-size:32px}p{line-height:1.6}</style><main><h1>设计体检演示</h1><p>演示数据，只验证离线页面检查。</p><button onclick="document.querySelector(\'#result\').textContent=\'已完成演示\'">查看详情</button><p id="result" role="status"></p></main></html>');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 812 });
      await page.evaluate(prepareDocument);
      const report = await page.evaluate(inspectDocument);
      assert.equal(report.horizontalOverflow, false);
      assert.deepEqual(report.brokenImages, []);
      assert.deepEqual(report.smallText, []);
      good.push(report);
      await page.screenshot({ path: join(output, `${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: '查看详情' }).click();
    assert.equal(await page.locator('#result').innerText(), '已完成演示');
    await page.setContent('<html><title>bad</title><p style="font-size:8px">too small</p><div style="width:2000px">overflow</div><img src="file:///missing-fixture.png"></html>');
    await page.evaluate(prepareDocument);
    const bad = await page.evaluate(inspectDocument);
    assert.equal(bad.horizontalOverflow, true);
    assert.deepEqual(bad.brokenImages, ['file:///missing-fixture.png']);
    assert.deepEqual(bad.smallText, ['too small']);
    let imageRequests = 0;
    await page.route('https://design-fixture.invalid/**', async route => {
      imageRequests++;
      if (route.request().url().endsWith('/good.svg')) {
        await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="purple"/></svg>' });
      } else {
        await route.fulfill({ status: 404, body: 'Missing fixture' });
      }
    });
    await page.setContent('<!doctype html><title>Deferred image fixture</title><div style="height:15000px">演示</div><img loading="lazy" src="https://design-fixture.invalid/good.svg"><img loading="lazy" src="https://design-fixture.invalid/missing.svg">');
    const before = await page.evaluate(inspectDocument);
    assert.ok(before.brokenImages.includes('https://design-fixture.invalid/good.svg'));
    await page.evaluate(prepareDocument);
    const deferred = await page.evaluate(inspectDocument);
    assert.deepEqual(deferred.brokenImages, ['https://design-fixture.invalid/missing.svg']);
    assert.equal(imageRequests, 2);
    console.log(JSON.stringify({ good, bad, deferred, output }, null, 2));
  } finally { await page.close(); }
});
