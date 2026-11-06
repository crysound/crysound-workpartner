// 公司市场的构建期补丁：网页版 npm 运行时与桌面打包运行时使用同一份，不修改上游源码。
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * 修补已构建的 ui-plugin-manager client.js；补丁完整命中或抛错，重复执行不改变结果。
 * @param text dsh 0.2.2-rc.1 的浏览器模块内容。
 * @returns 默认打开公司市场、按公司顺序和中英文名称显示标签的模块内容。
 */
export function patchMarketUi(text) {
  const marker = "/* CRYSOUND market tabs v1 */";
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
  const items = /items: \[\{\s+value: INSTALLED_TAB,[\s\S]*?\}\)\)\]/g;
  const matches = [...text.matchAll(items)];
  if (matches.length !== 1) throw new Error("市场标签列表补丁未唯一命中，请核对 dsh 版本");
  const list = matches[0][0];
  const renamed = list.replace('label: item.label,', 'label: item.id === "discover" ? (language === "zh" ? "兆华市场" : "CRYSOUND market") : item.id === "dsh-market" ? (language === "zh" ? "第三方市场" : "Third-party market") : item.label,');
  if (renamed === list) throw new Error("市场标签名称补丁未命中");
  replace(list, renamed + '.sort((a, b) => { const rank = (id) => id === "discover" ? 0 : id === "dsh-market" ? 1 : id === INSTALLED_TAB ? 3 : 2; return rank(a.value) - rank(b.value); })');
  return marker + "\n" + text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("用法：patch-market-ui.mjs <ui-plugin-manager/lib/client.js>");
  const text = fs.readFileSync(file, "utf8");
  const next = patchMarketUi(text);
  if (text !== next) {
    // pnpm 的硬链接不能原地改写，避免影响其他安装。
    const mode = fs.statSync(file).mode;
    fs.unlinkSync(file);
    fs.writeFileSync(file, next, { mode });
  }
}
