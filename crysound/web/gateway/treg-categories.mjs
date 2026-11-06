// 分类顺序、中文说明与草稿示例由公司维护；平台和价格来自 TR-EG 目录。
export const tregCategories = [
  {
    id: "seo", name: "SEO 与搜索", categories: ["SEO/AEO"],
    examples: ["查询 Google 和百度的关键词搜索量", "查询网站外链和域名权重", "分析搜索排名", "查询品牌在 AI 搜索中的可见度"],
    prompt: "帮我查询一个网站的关键词、搜索排名和外链。先问我要分析的网站和目标市场。",
  },
  {
    id: "people", name: "人员与公司", categories: ["Enrichment"],
    examples: ["查找目标公司的联系人", "查找并核验工作邮箱", "查询公司规模与融资信息", "查询 LinkedIn 人员与达人资料"],
    prompt: "帮我查找目标公司的联系人和工作邮箱。先问我要找的公司、岗位和地区。",
  },
  {
    id: "social", name: "社交媒体", categories: ["Social"],
    examples: ["查询 YouTube 视频与评论", "查询 LinkedIn 公司动态", "搜索抖音和小红书内容", "查询微博与 X 的公开帖子"],
    prompt: "帮我查询社交媒体上的相关内容。先问我要查的平台、关键词和时间范围。",
  },
  {
    id: "advertising", name: "广告与达人营销", categories: ["Advertising"],
    examples: ["查询 Google Ads 广告数据", "查询 Meta 广告库", "查询抖音星图达人数据", "查询小红书蒲公英与 TikTok 广告"],
    prompt: "帮我查询广告或达人营销数据。先问我要查的平台、品牌或达人。",
  },
  {
    id: "commerce", name: "电商", categories: ["E-commerce"],
    examples: ["查询亚马逊商品", "查询淘宝和京东商品", "查询 TikTok Shop 数据", "查询 eBay 商品与店铺"],
    prompt: "帮我查询电商商品数据。先问我要查的平台、商品和目标市场。",
  },
  {
    id: "reviews", name: "评价与应用商店", categories: ["Reviews & Apps"],
    examples: ["查询 App Store 应用评价", "查询 Google Play 应用信息", "查询 Tripadvisor 旅行评价", "查询 Yelp 与 Trustpilot 商家评价"],
    prompt: "帮我查询并整理用户评价。先问我要查的平台、应用或商家。",
  },
  {
    id: "other", name: "其他", categories: ["Community", "Research & public data", "Market data", "Developer"],
    examples: ["查询 Hacker News 与 Product Hunt", "查询论文和公开研究数据", "查询股票与加密市场数据", "查询 GitHub 项目与软件包"],
    prompt: "帮我查询公开数据。先问我要查询的主题、数据来源和时间范围。",
  },
];
