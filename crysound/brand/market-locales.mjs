/** @typedef {{ zpCompanyMarket: string, zpThirdPartyMarket: string, zpMarketPanel: string }} MarketCopy */

/** Company copy merged into the plugin manager dictionaries before registration; other locales use normal fallback. */
export const marketLocales = /** @satisfies {Record<'zh' | 'en', MarketCopy>} */ ({
  zh: {
    zpCompanyMarket: "兆华市场",
    zpThirdPartyMarket: "第三方",
    zpMarketPanel: "市场",
  },
  en: {
    zpCompanyMarket: "CRYSOUND market",
    zpThirdPartyMarket: "Third-party",
    zpMarketPanel: "Market",
  },
});
