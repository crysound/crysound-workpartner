import { readFile } from "node:fs/promises";
import { publicTarget, withAbort } from "./network.mjs";
import { toolTiming } from "./timing.mjs";

/** A container identity token reaches only the internal gateway; the paid API key never enters dsh. */
export async function deepseekFetch(ctx, config, input, signal, services) {
  const env = services.launchEnvironmentOf(ctx);
  const base = env.get("CRYSOUND_DS_TOOLS_BASE")?.value;
  if (!base) throw new Error("DeepSeek gateway unavailable");
  const endpoint = new URL(base);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "zhaohua-partner-gateway" || endpoint.port !== "3091"
    || endpoint.pathname !== "/_zp/ds-tools/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid internal DeepSeek gateway");
  await withAbort(publicTarget(input.url), signal);
  const token = (await readFile(env.get("CRYSOUND_DS_TOOLS_TOKEN_FILE")?.value || "/data/.zp-market-token", "utf8")).trim();
  if (!/^zpd\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Container identity unavailable");
  signal.throwIfAborted();
  toolTiming.fetch("deepseek-request-start");
  const response = await services.request(new URL("fetch", endpoint).href, { method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ url: input.url }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("DeepSeek fetch failed"); }
  const data = await response.json();
  signal.throwIfAborted();
  if (typeof data?.title !== "string" || typeof data?.content !== "string" || data.content.replace(/\s/g, "").length < config.fetchDeepSeekMinChars) throw new Error("DeepSeek page unreadable");
  toolTiming.fetch("deepseek-request-end", "success");
  const content = `Source: ${input.url}\n\n${data.title}\n\n${data.content}`;
  return { url: input.url, statusCode: 200, truncated: content.length > config.fetchMaxOutputChars,
    body: { kind: "text", content: content.slice(0, config.fetchMaxOutputChars) } };
}
