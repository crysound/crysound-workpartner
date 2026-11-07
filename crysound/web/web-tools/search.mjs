import { readFile } from "node:fs/promises";

/** Search through the released credential, wire mapping and request log paths.
 * @param Provider Released search class. @param WebError Released error class.
 * @param options Resolved options.
 * @param request Search query. @param signal Optional caller cancellation.
 * @param timeoutMs Primary attempt limit, defaulting to twelve seconds; fallback uses at most four seconds.
 * @param exa Optional test services; production uses the existing container gateway and identity file.
 * @returns Primary answer with optional Exa sources; auxiliary work shares one five-second deadline.
 */
export async function searchWithFallback(Provider, WebError, options, request, signal, timeoutMs = 12_000, exa = {}) {
  signal?.throwIfAborted();
  const stop = new AbortController();
  const extra = mostlyEnglish(request.query)
    ? exaSearch(request.query, AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]), options.recordExa, exa)
    : Promise.resolve([]);
  try {
    const result = await primarySearch(Provider, WebError, options, request, signal, timeoutMs);
    const sources = await extra;
    signal?.throwIfAborted();
    if (!sources.length) return result;
    const merged = mergeSources(result, sources, request.maxResults ?? 10);
    options.recordExa?.("exa-result", { adopted: merged.sources.some(source => sources.includes(source)) });
    return merged;
  } finally { stop.abort(); }
}

async function primarySearch(Provider, WebError, options, request, signal, timeoutMs) {
  const gpt = "codex/gpt-6-luna", deepseek = "deepseek/deepseek-flash";
  const models = [deepseek, gpt];
  const failures = [];
  for (const [index, model] of models.entries()) {
    signal?.throwIfAborted();
    const attempt = AbortSignal.timeout(index === 0 ? timeoutMs : Math.min(timeoutMs, 4_000));
    let recorded = false;
    const recordRequest = (entry) => { options.recordRequest?.(entry); recorded = true; };
    try {
      return await new Provider(() => ({ ...options, model, recordRequest })).search(request,
        signal ? AbortSignal.any([signal, attempt]) : attempt);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Do not fall back after credential/logging errors before an HTTP request exists.
      if (!recorded || error.code === "WEB_PROVIDER_CREDENTIAL_MISSING") throw error;
      failures.push(error);
    }
  }
  throw new WebError("网页搜索的两个服务均失败，请稍后重试", "WEB_PROVIDER_ERROR", { cause: new AggregateError(failures) });
}

/** Keep an answer and its URL-specific excerpts within the tool's 800-character budget.
 * @param response Messages response. @param mapSources Released source mapper.
 * @returns Search answer and original sources; text-only responses remain usable.
 */
export function searchAnswer(response, mapSources) {
  const blocks = response.content ?? [];
  const lastResult = blocks.findLastIndex(block => block.type === "web_search_tool_result");
  const answer = boundedText(blocks.slice(lastResult < 0 ? 0 : lastResult + 1)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n"));
  // The Codex gateway can return the searched answer without native source blocks.
  // With no answer, retain the released mapper's error and fallback behavior.
  const result = lastResult < 0 && answer ? { sources: [], truncated: false } : mapSources(response);
  return {
    ...result,
    ...(answer ? { content: answer } : {}),
    sources: result.sources.map(source => {
      const summary = boundedText(source.snippet ?? "");
      return { ...source, ...(summary ? { summary } : {}) };
    }),
  };
}

function boundedText(text) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 800) return normalized;
  // Avoid cutting between the two UTF-16 code units of an emoji.
  const end = /[\uD800-\uDBFF]/u.test(normalized[798]) ? 798 : 799;
  return normalized.slice(0, end) + "…";
}


// Count non-whitespace Unicode characters so mixed Chinese queries keep their original path.
function mostlyEnglish(query) {
  const compact = [...query.replace(/\s/gu, "")];
  return compact.length > 0 && compact.filter(char => /[A-Za-z]/u.test(char)).length > compact.length / 2;
}

async function exaSearch(query, parent, record, services) {
  const env = services.env ?? process.env;
  if (!env.CRYSOUND_MARKET_ORIGIN || !env.CRYSOUND_MARKET_TOKEN_FILE) return [];
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
  const started = performance.now();
  let dispatched = false, status = "failed";
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    // Race credential reading and body parsing too: neither may extend the five-second budget.
    return await Promise.race([aborted, (async () => {
      const endpoint = new URL("/_zp/treg/call/treg.web.search", env.CRYSOUND_MARKET_ORIGIN);
      if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Invalid gateway address");
      const token = (await (services.readToken ?? readFile)(env.CRYSOUND_MARKET_TOKEN_FILE, "utf8")).trim();
      signal.throwIfAborted();
      if (!token || /[\r\n]/u.test(token)) throw new Error("Missing container identity");
      dispatched = true;
      record?.("exa-request-dispatch");
      const response = await (services.fetcher ?? fetch)(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
          "X-Treg-Route-Prefer": "exa", "X-Treg-Route-Waterfall": "0", "X-Treg-Route-Max-Cost": "0.01" },
        body: JSON.stringify({ q: query, limit: 10 }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Search unavailable"); }
      const value = await response.json();
      signal.throwIfAborted();
      if (!Array.isArray(value?.output?.results)) throw new Error("Invalid search response");
      const sources = value.output.results.flatMap(row => {
        if (!row || typeof row.url !== "string") return [];
        let url;
        try { url = new URL(row.url); } catch { return []; }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
        const summary = boundedText(typeof row.summary === "string" && row.summary.trim() ? row.summary
          : Array.isArray(row.highlights) ? row.highlights.filter(item => typeof item === "string").join(" ") : "");
        const date = row.publishedDate ?? row.publishedAt;
        return [{ url: row.url, ...(typeof row.title === "string" ? { title: row.title } : {}),
          ...(typeof date === "string" && Number.isFinite(Date.parse(date)) ? { publishedAt: date } : {}),
          ...(summary ? { summary } : {}) }];
      });
      status = sources.length ? "ok" : "empty";
      return sources.sort((a, b) => Number(!!b.publishedAt) - Number(!!a.publishedAt));
    })()]);
  } catch {
    if (signal.aborted) status = parent.aborted ? "cancelled" : "timeout";
    return [];
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (dispatched) record?.("exa-request-finished", { durationMs: performance.now() - started, status });
  }
}

function mergeSources(result, extra, limit) {
  const seen = new Set(), sources = [];
  for (const source of [...extra, ...result.sources]) {
    let key;
    try { const url = new URL(source.url); url.hash = ""; key = url.href; } catch { key = source.url; }
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return { ...result, sources: sources.slice(0, limit), truncated: result.truncated || sources.length > limit };
}
