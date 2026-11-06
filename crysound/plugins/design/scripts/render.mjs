/** Offline HTML screenshots and measurable design checks using the shared image runtime. */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBrowser } from './browser-runtime.mjs';
import { inspectDocument, prepareDocument } from './inspect-document.mjs';

const [input, output, ...args] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/render.mjs <local.html> <output-dir> [--viewports 1440x900,375x812]');
if (args.length && (args.length !== 2 || args[0] !== '--viewports')) throw new Error('Only --viewports is supported');
const viewports = (args[1] ?? '1440x900,375x812').split(',').map(value => {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error('Viewport must be WIDTHxHEIGHT');
  const [width, height] = match.slice(1).map(Number);
  if (width < 100 || height < 100 || width > 4096 || height > 8192) throw new Error('Viewport outside supported range');
  return { width, height };
});
const source = resolve(input);
if (!(await stat(source)).isFile() || !/\.html?$/i.test(source)) throw new Error('Input must be a local HTML file');
const destination = resolve(output);
await mkdir(destination, { recursive: true });
const results = await withBrowser(async browser => {
  const reports = [];
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    try {
      const errors = [];
      const blocked = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route(/^https?:\/\//, route => { blocked.push(route.request().url()); return route.abort(); });
      await page.routeWebSocket(/.*/, socket => { blocked.push(socket.url()); socket.close(); });
      await page.goto(pathToFileURL(source).href, { waitUntil: 'load', timeout: 30_000 });
      await page.evaluate(prepareDocument);
      const checks = await page.evaluate(inspectDocument);
      const screenshot = join(destination, `${viewport.width}x${viewport.height}.png`);
      await page.screenshot({ path: screenshot, fullPage: true, timeout: 30_000 });
      reports.push({ viewport, screenshot, ...checks, errors, blocked, passed: !checks.horizontalOverflow && !checks.brokenImages.length && !checks.smallText.length && !errors.length && !blocked.length });
    } finally { await page.close(); }
  }
  return reports;
});
await writeFile(join(destination, 'report.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
if (results.some(report => !report.passed)) process.exitCode = 1;
