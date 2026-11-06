import { tregCategories } from "./treg-categories.mjs";

const source = "https://treg.to/catalog/platforms";
const endpoint = "/_zp/market/data.json";
const maxBytes = 2 * 1024 * 1024;

/** 将外部平台目录映射为七个有序分类；未知分类和 AI generation 不进入市场。
 * @param value TR-EG /catalog/platforms 的 JSON 回答。
 * @returns 仅含展示字段的分类卡片数据；起步价未知时为 null，不能当作免费。
 */
export function dataCategories(value) {
  if (!Array.isArray(value?.platforms) || !value.platforms.length) throw new Error("数据目录无效");
  const seen = new Set();
  const platforms = value.platforms.map((row) => {
    if (!row || typeof row.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug)
      || typeof row.label !== "string" || !row.label.trim() || typeof row.category !== "string" || seen.has(row.slug)) {
      throw new Error("数据平台字段无效");
    }
    seen.add(row.slug);
    const price = row.price_from?.usd;
    if (price !== undefined && price !== null && (!Number.isFinite(price) || price < 0)) throw new Error("数据价格无效");
    return { slug: row.slug, name: row.label, category: row.category, priceFromUsd: price ?? null };
  });
  return tregCategories.map(({ categories, ...card }) => {
    const rows = platforms.filter((row) => categories.includes(row.category));
    const prices = rows.map((row) => row.priceFromUsd).filter((price) => price !== null);
    return {
      ...card, package: "@crysound/data", pluginName: "兆华数据", platforms: rows,
      priceFromUsd: prices.length ? Math.min(...prices) : null,
      priceNote: "起步价按目录原始计价单位展示，实际费用以所选接口为准",
    };
  });
}

async function loadCatalog(fetcher) {
  const response = await fetcher(source, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("数据目录读取失败"); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("数据目录过大");
    chunks.push(chunk);
  }
  return dataCategories(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** 创建只读市场目录端点，启用时启动只取一次；失败关闭目录，重建网关后再取。
 * @param options enabled 为已配置总开关及非空令牌；authenticate 校验 zpd，sessionUser 校验网页会话；registry 是公开安装地址；fetcher 可注入测试传输。
 * @returns HTTP 处理器；其他路径返回 false，目录响应不包含组织令牌或上游原始错误。
 */
export function createDataCatalog({ enabled, authenticate, sessionUser, registry, fetcher = fetch }) {
  // 捕获启动失败，避免未处理的 rejection；请求只读取同一份启动结果。
  const catalog = enabled
    ? loadCatalog(fetcher).then((categories) => ({ categories, fetchedAt: new Date().toISOString() }), (error) => null)
    : Promise.resolve(null);
  const handle = async (req, res, url) => {
    if (url.pathname !== endpoint) return false;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    if (!authenticate(req) && !sessionUser(req)) { json(401, { error: "请先登录工作伙伴" }); return true; }
    if (req.method !== "GET") { res.setHeader("allow", "GET"); json(405, { error: "此接口只支持读取目录" }); return true; }
    if (!enabled) { json(503, { error: "数据服务尚未开放" }); return true; }
    const result = await catalog;
    if (!result) { json(503, { error: "数据目录暂时无法读取，请联系管理员" }); return true; }
    json(200, { ...result, registry });
    return true;
  };
  handle.read = () => catalog;
  return handle;
}
