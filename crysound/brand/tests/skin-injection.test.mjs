import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const html = '<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>';
function check(document) {
  const head = document.slice(0, document.indexOf('</head>'));
  assert.match(head, /<script src="\.\/skin\.js(?:\?v=[^\"]+)?"><\/script>/);
  assert.ok(head.indexOf('brand.css') < head.indexOf('skin.css'));
  assert.ok(head.indexOf('skin.js') < head.indexOf('brand.js'));
  assert.ok(!/<script src="[^\"]*skin\.js[^\"]*"[^>]*(?:defer|async|type=)/.test(head));
}
test('web brand layer copies and injects both skin assets before application startup', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-skin-inject-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const brand = path.join(fixture, 'brand');
  fs.cpSync(new URL('brand/', root), brand, { recursive: true });
  const dist = path.join(fixture, 'runtime/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"DeepSeek Harness","short_name":"DSH"}');
  const bin = path.join(fixture, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$SKIN_FIXTURE_RUNTIME"\n', { mode: 0o755 });
  const docker = read('web/Dockerfile');
  const start = docker.indexOf('RUN set -e; v=$(find /tmp/brand');
  const end = docker.indexOf('\n# 公司配置', start);
  assert.ok(start > 0 && end > start);
  const command = docker.slice(start + 4, end).replaceAll('/tmp/brand', brand);
  execFileSync('sh', ['-c', command], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, SKIN_FIXTURE_RUNTIME: path.join(fixture, 'runtime') } });
  check(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
  for (const file of ['skin.js', 'skin.css']) assert.equal(fs.readFileSync(path.join(dist, file), 'utf8'), read('brand/' + file));
});
test('desktop transforms the document and serves the shared skin resources', () => {
  const source = fs.readFileSync(new URL('../apps/desktop/src/main.ts', root), 'utf8');
  const expression = source.match(/const brandIndex = \(html: string\): string => ([\s\S]*?)\n\n  protocol\.handle/)[1];
  const document = vm.runInNewContext('(html => ' + expression.trim() + ')')(html);
  check(document);
  const partner = fs.readFileSync(new URL('../apps/desktop/src/crysound/partner.ts', root), 'utf8');
  const files = partner.match(/export const BRAND_FILES[^=]*= new Set\((\[[^\n]+\])\)/)[1];
  const list = vm.runInNewContext(files);
  for (const file of ['/skin.js', '/skin.css']) {
    assert.ok(list.includes(file));
    assert.ok(fs.existsSync(new URL('brand' + file, root)));
  }
});
