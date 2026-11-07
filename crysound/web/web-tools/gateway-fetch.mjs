import { readFile } from "node:fs/promises";
import { publicTarget, withAbort } from "./network.mjs";
import { toolTiming } from "./timing.mjs";

/** Forward a public URL using only the container identity; paid credentials stay in the gateway. */
export async function gatewayFetch(provider, ctx, config, input, signal, services) {
  const env = services.launchEnvironmentOf(ctx);
  const base = env.get(provider === "deepseek" ? "CRYSOUND_DS_TOOLS_BASE" : "CRYSOUND_TREG_BASE")?.value;
  if (!base) throw new Error("Page gateway unavailable");
  const endpoint = new URL(base), prefix = provider === "deepseek" ? "/_zp/ds-tools/" : "/_zp/treg/";
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "zhaohua-partner-gateway" || endpoint.port !== "3091"
    || endpoint.pathname !== prefix || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid internal page gateway");
  await withAbort(publicTarget(input.url), signal);
  const token = (await readFile(env.get("CRYSOUND_DS_TOOLS_TOKEN_FILE")?.value || "/data/.zp-market-token", "utf8")).trim();
  if (!/^zpd\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Container identity unavailable");
  signal.throwIfAborted();
  toolTiming.fetch(`${provider}-request-start`);
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (provider === "treg") Object.assign(headers, { "x-treg-route-prefer": "crawl4ai", "x-treg-route-waterfall": "0", "x-treg-route-max-cost": "0.005" });
  const response = await services.request(new URL(provider === "deepseek" ? "fetch" : "call/treg.web.extract", endpoint).href,
    { method: "POST", redirect: "error", signal, headers, body: JSON.stringify({ url: input.url }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Page gateway request failed"); }
  const data = await response.json();
  signal.throwIfAborted();
  let title, text;
  if (provider === "deepseek") { title = data?.title; text = data?.content; }
  else {
    const pages = data?.output?.pages;
    if (!Array.isArray(pages) || pages.length !== 1 || pages[0]?.ok === false) throw new Error("Extracted page unavailable");
    title = typeof pages[0].title === "string" ? pages[0].title : "";
    text = pages[0].markdown;
  }
  if (typeof title !== "string" || typeof text !== "string" || text.replace(/\s/g, "").length < config.fetchDeepSeekMinChars) throw new Error("Page unreadable");
  toolTiming.fetch(`${provider}-request-end`, "success");
  const content = `Source: ${input.url}\n\n${title}\n\n${text}`;
  return { url: input.url, statusCode: 200, truncated: content.length > config.fetchMaxOutputChars,
    body: { kind: "text", content: content.slice(0, config.fetchMaxOutputChars) } };
}
