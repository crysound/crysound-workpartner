/** @typedef {{ zpCompanyMarket: string, zpThirdPartyMarket: string, zpMarketPanel: string, zpMarketHint: string }} MarketCopy */

/** Company copy merged into the plugin manager dictionaries before registration; other locales use normal fallback. */
export const marketLocales = /** @satisfies {Record<'zh' | 'en', MarketCopy>} */ ({
  zh: {
    zpCompanyMarket: "兆华市场",
    zpThirdPartyMarket: "第三方市场",
    zpMarketPanel: "市场",
    zpMarketHint: "兆华 · 第三方",
  },
  en: {
    zpCompanyMarket: "CRYSOUND market",
    zpThirdPartyMarket: "Third-party market",
    zpMarketPanel: "Market",
    zpMarketHint: "Crysound · Third-party",
  },
});
