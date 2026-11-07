/** Reject extracted shells without treating an article that quotes a warning as a shell.
 * @param text Extracted Markdown or plain text. @returns Whether the page lacks readable content.
 */
export function unreadablePage(text) {
  const warning = /(?:doesn['’]t work properly without javascript|enable\s+javascript|javascript.{0,12}(?:disabled|not enabled)|请.{0,5}(?:开启|启用|打开)\s*javascript|环境异常|完成验证后.{0,8}(?:访问|继续)|访问过于频繁|请先登录|sign in to continue)/i;
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const warnings = lines.filter(line => warning.test(line));
  if (warnings.length && !lines.some(line => !warning.test(line) && line.replace(/\s/g, "").length >= 80)) return true;
  // A page containing links and counters alone is navigation, even above the character minimum.
  const links = [...text.matchAll(/\[([^\]]*)\]\([^)]*\)/g)];
  const prose = text.replace(/!?\[[^\]]*\]\([^)]*\)/g, "").replace(/https?:\/\/\S+/g, "")
    .replace(/\d[\d,.]*\s*(?:万|亿|次|views?)?/gi, "").replace(/[\s\p{P}\p{S}]/gu, "");
  return !prose || (links.length >= 3 && prose.length < 40);
}

/** Upgrade only the known public Weixin article host; preserve its opaque query parameters.
 * @param input Parsed fetch input. @returns Input with HTTPS for Weixin, otherwise unchanged.
 */
export function pageInput(input) {
  const url = new URL(input.url);
  if (url.hostname !== "mp.weixin.qq.com" || url.protocol !== "http:" || url.port || url.username || url.password) return input;
  url.protocol = "https:";
  return { ...input, url: url.href };
}

/** Resolve a known public article API used by the publisher's own mobile page.
 * @param input Parsed fetch input. @returns Public API and article identity, or undefined for ordinary pages.
 */
export function publicArticle(input) {
  const target = new URL(input.url);
  const article = /^\/wap\/detail\/(chs|cht)\/zw\/(\d+)\.shtml$/.exec(target.pathname);
  if (!["http:", "https:"].includes(target.protocol) || target.hostname !== "m.chinanews.com" || target.port || target.username || target.password || !article) return undefined;
  return { id: article[2], url: `https://dw.chinanews.com/cns/app/v1/wapDetail/content/${article[2]}.json?language=${article[1]}` };
}
