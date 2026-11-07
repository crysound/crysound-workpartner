// Point DSH_CLI_ENTRY at the existing runtime to resolve yaml; no dependency installation is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { refreshProfile } from './profile-upgrades.mjs';

const yaml = createRequire(process.env.DSH_CLI_ENTRY ?? import.meta.url)('yaml');

test('新旧配置实际注册双语发布询问与确认边界，第二次刷新字节不变', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-creator-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = new URL('./partner.patch.yml', import.meta.url);
  for (const existing of [false, true]) {
    const dir = path.join(root, String(existing)); fs.mkdirSync(dir);
    const file = path.join(dir, 'cordis.patch.yml');
    if (existing) fs.writeFileSync(file, '# personal\n- id: system-prompt\n  config: {personaPrefix: My persona}\n');
    refreshProfile(file, seed, yaml, !existing);
    const profile = fs.readFileSync(file, 'utf8');
    const guidanceFile = path.join(dir, 'crysound-tool-efficiency.mjs');
    const source = fs.readFileSync(guidanceFile, 'utf8');
    const guidance = await import(guidanceFile);
    const sections = [];
    guidance.apply({ effect: fn => fn(), systemPrompt: { getSectionOrder: () => 1, section: row => sections.push(row) } });
    const text = sections[0].text;
    assert.match(text, /After creating a plugin in Creator mode and passing its self-tests/);
    assert.match(text, /要发布到兆华市场给同事用吗？/);
    assert.match(text, /Do not upload or publish automatically/);
    assert.match(text, /Only after the user agrees/);
    assert.match(text, /publish-zhaohua-market/);
    assert.match(text, /已提交，等管理员审批，批准后会通知你/);
    assert.match(text, /Would you like to publish/);
    if (existing) assert.match(profile, /My persona/);
    refreshProfile(file, seed, yaml);
    assert.equal(fs.readFileSync(file, 'utf8'), profile);
    assert.equal(fs.readFileSync(guidanceFile, 'utf8'), source);
  }
});
