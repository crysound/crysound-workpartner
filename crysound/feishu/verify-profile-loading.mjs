/** Check fresh/legacy profiles against an existing published dsh installation.
 * Usage: node verify-profile-loading.mjs /path/to/dsh/package.json
 * No installs, builds, credentials, running profiles or network requests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareSkillProfile } from './setup.mjs';

if (!process.argv[2]) throw new Error('Pass the existing dsh package.json path.');
const anchor = path.resolve(process.argv[2]);
const require = createRequire(anchor);
const { initProfile, loadProfileDirectory, composeEntries } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const { PROFILE_TEMPLATES } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-official-bundles')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-profile-loading-'));
const flatten = rows => rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config) : []]);
try {
  for (const kind of ['fresh', 'upgrade']) {
    const dir = path.join(root, kind);
    initProfile(dir, PROFILE_TEMPLATES.web.bundles);
    const patch = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(patch, kind === 'fresh' ? '[]\n' : "- id: company-feishu-settings\n  name: '@crysound/feishu-settings'\n- id: company-feishu-skills\n  name: '@deepseek-ai/dsh-skill-filesystem'\n");
    const compose = () => {
      const profile = loadProfileDirectory('dsh', dir, anchor);
      assert.deepEqual(profile.skippedBundles, []);
      const warnings = [];
      const rows = flatten(composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], (...args) => warnings.push(args)));
      return { rows, warnings };
    };
    const before = compose();
    assert.equal(before.rows.filter(row => row.name === '@crysound/feishu-settings').length, 0);
    if (kind === 'upgrade') assert.ok(before.warnings.some(args => args.join(' ').includes('company-feishu-settings')));
    prepareSkillProfile(patch);
    const once = fs.readFileSync(patch, 'utf8');
    prepareSkillProfile(patch);
    assert.equal(fs.readFileSync(patch, 'utf8'), once);
    const after = compose();
    for (const id of ['company-feishu-settings', 'company-feishu-skills']) assert.equal(after.rows.filter(row => row.id === id).length, 1);
    assert.deepEqual(after.warnings, []);
    console.log(`${kind}: native module and skill provider each composed once; repeat preparation unchanged`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
