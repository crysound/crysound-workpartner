import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { patchThirdPartyCards } from '../patch-market-cards.mjs';
import { marketLocales } from '../../brand/market-locales.mjs';

test('官方图标均为可审阅的独立 SVG，索引与生成的第三方补丁没有漂移',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../../config/plugins.json',import.meta.url)));
  for(const [name,entry] of Object.entries(config.officialPlugins)) {
    const expected=fs.readFileSync(new URL('../../brand/market-icons/'+name.split('/').pop()+'.svg',import.meta.url),'utf8').trim();
    assert.equal(Buffer.from(entry.icon.split(',')[1],'base64').toString(),expected);
    assert.ok(!/<script|foreignObject|href=/.test(expected));
  }
  assert.deepEqual(Object.keys(marketLocales.zh).sort(),Object.keys(marketLocales.en).sort());
  execFileSync(process.execPath,[new URL('../sync-market-card-patch.mjs',import.meta.url).pathname,'--check']);
});

test('真实第三方市场保留原生操作、可解析并拒绝未知卡片结构；重复修补不变',()=>{
  assert.ok(process.env.THIRD_PARTY_CLIENT,'THIRD_PARTY_CLIENT must name dshmarket@1.73.12 client/client.js');
  const raw=fs.readFileSync(process.env.THIRD_PARTY_CLIENT,'utf8');
  const patched=patchThirdPartyCards(raw);
  assert.doesNotThrow(()=>new vm.Script(patched));
  assert.equal(patchThirdPartyCards(patched),patched);
  assert.throws(()=>patchThirdPartyCards(raw.replace('const pluginCard =','const renamedCard =')),/未命中/);
  assert.throws(()=>patchThirdPartyCards(raw.replaceAll('render: (plugin) => pluginCard(plugin)','render: pluginCard')),/未完整命中/);
});
