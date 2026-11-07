// Node 24; exercise the installer's real resource checks without mounting a DMG.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FEISHU } from '../plugin-artifacts.mjs';

const verifier = readFileSync(new URL('../scripts/verify-mac-package.sh', import.meta.url), 'utf8');
const artifactSource = readFileSync(new URL('../plugin-artifacts.mjs', import.meta.url), 'utf8');
const start = verifier.indexOf('for f in brand/');
const end = verifier.indexOf('\nhas "$res/icon.png"', start);
assert.ok(start >= 0 && end > start);
const section = verifier.slice(start, end);
const has = verifier.match(/^has\(\).*$/m)[0];

for (const [declared, supplied, passes] of [
  [FEISHU.file, FEISHU.file, true],
  [FEISHU.file, 'aiwayds-dsh-feishu-0.17.0-crysound.1.tgz', false],
  ['aiwayds-dsh-feishu-future.tgz', 'aiwayds-dsh-feishu-future.tgz', true],
]) test(`installer expects bundled definition ${declared}, supplied ${supplied}`, {
  skip: process.platform === 'win32' ? 'macOS verifier uses bash' : false,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'partner-mac-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, 'app with spaces', 'Contents', 'Resources');
  const company = join(resources, 'crysound');
  // Other company resources are present; only the release archive varies.
  for (const file of verifier.match(/for f in (.*?); do has/)[1].split(' ')) {
    if (file.startsWith('company-plugins/')) continue;
    const target = join(company, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  writeFileSync(join(company, 'plugin-artifacts.mjs'), artifactSource.replaceAll(FEISHU.file, declared));
  mkdirSync(join(company, 'company-plugins'));
  writeFileSync(join(company, 'company-plugins', supplied), 'archive fixture');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nfail=0\n${has}\n${section}\nexit "$fail"`], {
    env: { ...process.env, res: resources, app: dirname(dirname(resources)), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, passes ? 0 : 1, result.stdout + result.stderr);
  if (passes) assert.doesNotMatch(result.stdout, /FAIL/);
  else assert.ok(result.stdout.includes(`FAIL  missing: Contents/Resources/crysound/company-plugins/${declared}`), result.stdout);
});
