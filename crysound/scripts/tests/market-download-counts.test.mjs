// Exercise card metadata from the patched release modules without installing or building.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { patchMarketCatalog } from '../patch-market-catalog.mjs';
import { patchThirdPartyCards } from '../patch-market-cards.mjs';
import { marketLocales } from '../../brand/market-locales.mjs';

const jsx = (type, props) => ({ type, props });
const react = { useState: () => [false, () => {}], useRef: () => ({}), useId: () => 'detail', useEffect: () => {} };

for (const thirdParty of [false, true]) {
  test(`${thirdParty ? '第三方' : '公司'}卡片在中英文隐藏零和缺失次数，显示正数，旧补丁可升级`, () => {
    const file = thirdParty ? process.env.THIRD_PARTY_CLIENT
      : process.env.MARKET_RUNTIME_MODULES && path.join(process.env.MARKET_RUNTIME_MODULES, '@deepseek-ai/dsh-client-ui-plugin-market/lib/client.js');
    assert.ok(file, 'Provide MARKET_RUNTIME_MODULES and THIRD_PARTY_CLIENT release fixtures');
    const patch = thirdParty ? patchThirdPartyCards : patchMarketCatalog;
    const patched = patch(fs.readFileSync(file, 'utf8'));
    const legacy = thirdParty
      ? patched.replace('third-party cards v2', 'third-party cards v1').replace('statistic?.count > 0 ? copy.zpDownloadCount', 'statistic ? copy.zpDownloadCount')
      : patched.replace('market catalog v3', 'market catalog v2').replace('count > 0 ? t("zpDownloadCount", { count: new Intl.NumberFormat(language).format(count) }) : null', 'count === undefined ? null : t("zpDownloadCount", { count: new Intl.NumberFormat(language).format(count) })');
    assert.equal(patch(legacy), patched);
    assert.equal(patch(patched), patched);
    const name = thirdParty ? 'ZpThirdPartyCard' : 'EntryCard';
    const start = patched.indexOf(`function ${name}(`);
    const end = patched.indexOf(thirdParty ? '\n  function CardDesc(' : '\n\t\t/**', start);
    assert.ok(start >= 0 && end > start);
    const render = vm.runInNewContext(`${patched.slice(start, end)}\n${name}`, {
      react, react_jsx_runtime: { jsx, jsxs: jsx }, ZpIcon: () => {}, EntryAction: () => {},
      entryTitle: entry => entry.name, downloadStatistic: plugin => plugin.statistic,
      zpCopy: language => marketLocales[language], Intl,
    });
    for (const language of ['zh', 'en']) for (const count of [undefined, 0, 1, 1234]) {
      const copy = marketLocales[language];
      const card = render({ language, title: 'Plugin', renderAction: () => null,
        plugin: { name: 'plugin', owner: 'Author', statistic: count === undefined ? null : { count } },
        entry: { name: 'plugin', author: 'Author', metadata: { labels: ['crysound-official'], sortKeys: count === undefined ? {} : { 'crysound-installs': count } } },
        t: (key, params) => params ? (copy[key] ?? key).replace('{count}', params.count) : copy[key] ?? key,
      });
      const meta = card.props.children.find(child => child?.props.className === 'zp-card-meta').props;
      const expected = [thirdParty ? copy.zpThirdParty : copy.zpOfficial, 'Author',
        count > 0 ? copy.zpDownloadCount.replace('{count}', new Intl.NumberFormat(language).format(count)) : null].filter(Boolean).join(' · ');
      assert.equal(meta.children, expected, `${language}, count=${count}`);
      assert.equal(meta.title, expected);
    }
  });
}
