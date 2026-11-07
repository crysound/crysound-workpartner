/** @typedef {Record<"zpCompanyMarket" | "zpThirdPartyMarket" | "zpMarketPanel" | "zpRecommended" | "zpAll" | "zpOfficial" | "zpThirdParty" | "zpUse" | "zpInstallLocal" | "zpInstallCloud" | "zpInstallCount" | "zpCountUnavailable" | "zpFilter" | "zpUnknownAuthor" | "zpDownloadCount" | "zpClose" | "zpCompanyAuthor" | "zpBuiltIn", string>} MarketCopy */

/** Company copy merged into the plugin manager dictionaries before registration; other locales use normal fallback. */
export const marketLocales = /** @satisfies {Record<'zh' | 'en', MarketCopy>} */ ({
  zh: {
    zpCompanyMarket: "兆华市场",
    zpThirdPartyMarket: "第三方",
    zpMarketPanel: "市场",
    zpRecommended: "推荐", zpAll: "全部", zpOfficial: "官方", zpThirdParty: "第三方", zpUse: "使用",
    zpInstallLocal: "安装到：当前电脑", zpInstallCloud: "安装到：我的工作伙伴",
    zpInstallCount: "{count} 次安装", zpCountUnavailable: "暂无安装统计", zpFilter: "筛选插件",
    zpUnknownAuthor: "未提供作者", zpDownloadCount: "{count} 次下载", zpClose: "关闭详情", zpCompanyAuthor: "兆华工作伙伴", zpBuiltIn: "内置插件",
  },
  en: {
    zpCompanyMarket: "CRYSOUND market",
    zpThirdPartyMarket: "Third-party",
    zpMarketPanel: "Market",
    zpRecommended: "Recommended", zpAll: "All", zpOfficial: "Official", zpThirdParty: "Third-party", zpUse: "Use",
    zpInstallLocal: "Install to: This computer", zpInstallCloud: "Install to: My WorkPartner",
    zpInstallCount: "{count} installs", zpCountUnavailable: "Install count unavailable", zpFilter: "Filter plugins",
    zpUnknownAuthor: "Author unavailable", zpDownloadCount: "{count} downloads", zpClose: "Close details", zpCompanyAuthor: "CRYSOUND WorkPartner", zpBuiltIn: "Built-in plugin",
  },
});
