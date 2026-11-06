import test from "node:test";
import assert from "node:assert/strict";
import { dataPlatforms } from "../treg-catalog.mjs";

const row = (slug, category) => ({ slug, label: slug, category, private: "must-not-be-exposed" });

test("平台白名单保留数据类，拒绝 AI 与未知类，不包含市场卡片或价格", () => {
  const result = dataPlatforms({ platforms: [
    row("web", "SEO/AEO"), row("people", "Enrichment"), row("youtube", "Social"),
    row("meta-ads", "Advertising"), row("amazon", "E-commerce"), row("app-store", "Reviews & Apps"),
    row("github", "Developer"), row("stocks", "Market data"), row("research", "Research & public data"),
    row("hackernews", "Community"), row("video-gen", "AI generation"), row("unknown", "Future category"),
  ] });
  assert.equal(result.length, 10);
  assert.deepEqual(result[0], { slug: "web", name: "web", category: "SEO/AEO" });
  assert.doesNotMatch(JSON.stringify(result), /video-gen|unknown|must-not-be-exposed|price|prompt|package/);
});

test("无效或有歧义的平台目录不能用于调用白名单", () => {
  for (const platforms of [[], [row("../admin", "Social")], [row("web", "Social"), row("web", "Social")],
    [{ slug: "web", category: "Social" }], [{ ...row("web", "Social"), category: null }]]) {
    assert.throws(() => dataPlatforms({ platforms }));
  }
});
