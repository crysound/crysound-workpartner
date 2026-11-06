// 公司市场的构建期补丁：网页版 npm 运行时与桌面打包运行时使用同一份，不修改上游插件源码。
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { marketLocales } from "../brand/market-locales.mjs";

/**
 * 修补已构建的 ui-plugin-manager client.js；补丁完整命中或抛错，重复执行不改变结果。
 * @param {string} text dsh 0.2.2-rc.1 的浏览器模块内容。
 * @returns 默认打开公司市场、按公司顺序和中英文名称显示标签的模块内容。
 */
export function patchMarketUi(text) {
  const marker = "/* CRYSOUND market tabs v2 */";
  if (text.includes(marker)) return text;
  const replace = (find, replacement) => {
    if (text.split(find).length !== 2) throw new Error("市场界面补丁未唯一命中，请核对 dsh 版本");
    text = text.replace(find, replacement);
  };
  // 未加载完 slots 时保留默认意图；用户主动选择标签后，不再抢回公司市场。
  replace('tab: "installed"', 'tab: "zp-market-default"');
  replace('const tab = tabs.some((item) => item.id === selectedTab) ? selectedTab : INSTALLED_TAB;',
    'const tab = selectedTab === "zp-market-default" ? (tabs.some((item) => item.id === "discover") ? "discover" : INSTALLED_TAB) : tabs.some((item) => item.id === selectedTab) ? selectedTab : INSTALLED_TAB;');
  replace('if (tab !== selectedTab) setTab(tab);',
    'if (tab !== selectedTab && !(selectedTab === "zp-market-default" && tab === INSTALLED_TAB)) setTab(tab);');
  replace('if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") instance.actions.setView({ kind: "list" });',
    'if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") { instance.actions.setView({ kind: "list" }); instance.actions.setTab("zp-market-default"); }');
  const items = /items: \[\{\s+value: INSTALLED_TAB,[\s\S]*?\}\)\)\]/g;
  const matches = [...text.matchAll(items)];
  if (matches.length !== 1) throw new Error("市场标签列表补丁未唯一命中，请核对 dsh 版本");
  const list = matches[0][0];
  const renamed = list.replace('label: item.label,', 'label: item.id === "discover" ? t("zpCompanyMarket") : item.id === "dsh-market" ? t("zpThirdPartyMarket") : item.label,');
  if (renamed === list) throw new Error("市场标签名称补丁未命中");
  replace(list, renamed + '.sort((a, b) => { const rank = (id) => id === "discover" ? 0 : id === "dsh-market" ? 1 : id === INSTALLED_TAB ? 3 : 2; return rank(a.value) - rank(b.value); })');
  replace('ctx.effect(() => ctx.locale.register(NS, {',
    `Object.assign(zh, ${JSON.stringify(marketLocales.zh)}); Object.assign(en, ${JSON.stringify(marketLocales.en)});\n\t\t\tctx.effect(() => ctx.locale.register(NS, {`);
  replace('const t = ctx.locale.bind(NS);', `const t = ctx.locale.bind(NS);
      const updateMarketCopy = () => {
        document.documentElement.dataset.zpMarketPanel = t("zpMarketPanel");
        document.documentElement.dataset.zpMarketHint = t("zpMarketHint");
        document.dispatchEvent(new Event("zp-market-copy"));
      };
      ctx.effect(() => { updateMarketCopy(); return () => {
        delete document.documentElement.dataset.zpMarketPanel;
        delete document.documentElement.dataset.zpMarketHint;
        document.dispatchEvent(new Event("zp-market-copy"));
      }; }, "CRYSOUND market sidebar copy");
      ctx.on("locale/change", updateMarketCopy);`);
  replace('label: () => t("panel"),', 'label: () => t("zpMarketPanel"),');
  return marker + "\n" + text;
}

/**
 * 修补独立运行时文件，保留权限并断开 pnpm 硬链接。
 * @param {string} file ui-plugin-manager/lib/client.js 的路径。
 * @returns {void}
 */
export function patchMarketUiFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const next = patchMarketUi(text);
  if (text !== next) {
    // pnpm 的硬链接不能原地改写，避免影响其他安装。
    const mode = fs.statSync(file).mode;
    fs.unlinkSync(file);
    fs.writeFileSync(file, next, { mode });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("用法：patch-market-ui.mjs <ui-plugin-manager/lib/client.js>");
  patchMarketUiFile(file);
}
