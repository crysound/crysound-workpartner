const allowedCategories = new Set([
  "SEO/AEO", "Enrichment", "Social", "Advertising", "E-commerce", "Reviews & Apps",
  "Community", "Research & public data", "Market data", "Developer",
]);

/**
 * 校验公共平台目录，只返回允许查询的数据平台；不生成市场分类卡片或缓存目录。
 * @param value Treg /catalog/platforms 的 JSON 响应。
 * @returns 数据平台白名单，不包含 AI 生成、未知分类或无关的上游字段。
 */
export function dataPlatforms(value) {
  if (!Array.isArray(value?.platforms) || !value.platforms.length) throw new Error("数据目录无效");
  const seen = new Set();
  return value.platforms.map((row) => {
    if (!row || typeof row.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug)
      || typeof row.label !== "string" || !row.label.trim() || typeof row.category !== "string" || seen.has(row.slug)) {
      throw new Error("数据平台字段无效");
    }
    seen.add(row.slug);
    return { slug: row.slug, name: row.label, category: row.category };
  }).filter((row) => allowedCategories.has(row.category));
}
