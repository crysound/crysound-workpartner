// Package-owned text only; the official list alone decides which guides appear on the home page.
/**
 * Parse package-owned bilingual text; malformed metadata fails publication.
 * @param {unknown} value Optional manifest guide field.
 * @returns {object | undefined} Sanitized text or undefined when absent; invalid data throws.
 */
export function parsePluginGuide(value) {
  if (value === undefined) return undefined;
  const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dsh.market.guide 必须包含中英文说明、三个示例和能力提示");
  const result = {};
  for (const language of ["zh", "en"]) {
    const row = value[language];
    if (!row || !text(row.summary, 200) || !text(row.prompt, 500)
      || !Array.isArray(row.examples) || row.examples.length !== 3 || !row.examples.every(item => text(item, 300))) {
      throw new Error("dsh.market.guide 每种语言需要 summary、prompt 和三个 examples");
    }
    result[language] = { summary: row.summary.trim(), prompt: row.prompt.trim(), examples: row.examples.map(item => item.trim()) };
  }
  return result;
}
