import { readFile } from "node:fs/promises";

/** Search via the internal Search API, Flash and Luna, with parallel English Exa sources.
 * @param Provider Released search class. @param WebError Released error class.
 * @param options Resolved options and optional search/Exa diagnostic callbacks.
 * @param request Search query. @param signal Optional caller cancellation.
 * @param timeoutMs Optional caller Flash ceiling; absent uses the validated provider configuration.
 * @param services Optional offline transports; production uses existing gateway identity files.
 * @returns Primary answer with optional Exa sources; auxiliary work shares one five-second deadline.
 */
export async function searchWithFallback(Provider, WebError, options, request, signal, timeoutMs, services = {}) {
  signal?.throwIfAborted();
  const budget = options.searchBudget ?? resolveSearchBudget();
  const deadline = performance.now() + budget.searchTotalTimeoutMs;
  const stop = new AbortController();
  const extra = mostlyEnglish(request.query)
    ? exaSearch(request.query, AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]), options.recordExa, services, budget.searchTotalTimeoutMs)
    : Promise.resolve([]);
  try {
    const result = await primarySearch(Provider, WebError, options, request, signal, timeoutMs ?? budget.searchFlashTimeoutMs, services, deadline, budget);
    const sources = await extra;
    signal?.throwIfAborted();
    if (!sources.length) return result;
    const merged = mergeSources(result, sources, request.maxResults ?? 10);
    options.recordExa?.("exa-result", { adopted: merged.sources.some(source => sources.includes(source)) });
    return merged;
  } finally { stop.abort(); }
}

/** Resolve provider timeout settings before registration or a settings refresh.
 * @param values Optional configuration overrides; omitted fields use the shipped defaults.
 * @returns Validated millisecond budgets; incompatible or non-integer values throw.
 */
export function resolveSearchBudget(values = {}) {
  const budget = { searchTotalTimeoutMs: 18_000, searchApiTimeoutMs: 4_000,
    searchFlashTimeoutMs: 12_000, searchLunaReserveMs: 6_000, ...values };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${key} must be a positive timer-safe integer`);
  }
  if (budget.searchApiTimeoutMs > budget.searchTotalTimeoutMs || budget.searchFlashTimeoutMs > budget.searchTotalTimeoutMs
    || budget.searchLunaReserveMs >= budget.searchTotalTimeoutMs) throw new Error("Search budgets must fit within searchTotalTimeoutMs");
  return budget;
}

async function primarySearch(Provider, WebError, options, request, signal, timeoutMs, services, deadline, limits) {
  signal?.throwIfAborted();
  const failures = [];
  const env = services.env ?? process.env;
  const phases = [
    ...(env.CRYSOUND_DS_TOOLS_BASE ? ["search-api"] : []),
    "flash", "luna",
  ];
  for (const provider of phases) {
    signal?.throwIfAborted();
    const remaining = Math.max(0, Math.floor(deadline - performance.now()));
    if (!remaining) break;
    // A short remainder is split evenly so the fallback remains usable.
    const budget = provider === "search-api" ? Math.min(limits.searchApiTimeoutMs, remaining)
      : provider === "flash" ? Math.min(timeoutMs, remaining - Math.min(limits.searchLunaReserveMs, Math.floor(remaining / 2))) : remaining;
    const stop = new AbortController();
    const attempt = AbortSignal.any([stop.signal, AbortSignal.timeout(budget), ...(signal ? [signal] : [])]);
    const started = performance.now();
    let recorded = false, status = "failed";
    const recordRequest = entry => { options.recordRequest?.(entry); recorded = true; };
    options.recordSearch?.("search-phase-start", { provider, budgetMs: budget });
    try {
      const result = await abortable(async () => {
        if (provider === "search-api") return gatewaySearch(env, request, attempt, services, options.recordSearch);
        return new Provider(() => ({ ...options, model: provider === "flash" ? "deepseek/deepseek-flash" : "codex/gpt-6-luna", recordRequest }))
          .search(request, attempt);
      }, attempt);
      attempt.throwIfAborted();
      status = "success";
      return result;
    } catch (error) {
      status = signal?.aborted ? "cancelled" : attempt.aborted ? "timeout" : "failed";
      if (signal?.aborted) throw error;
      // Credential/logging failures before a model HTTP request are not provider failures.
      if (provider !== "search-api" && (!recorded || error.code === "WEB_PROVIDER_CREDENTIAL_MISSING")) throw error;
      failures.push(error);
    } finally {
      stop.abort();
      options.recordSearch?.("search-phase-end", { provider, status, won: status === "success", durationMs: performance.now() - started });
    }
  }
  throw new WebError("网页搜索的所有服务均失败，请稍后重试", "WEB_PROVIDER_ERROR", { cause: new AggregateError(failures) });
}

// A deadline also bounds credential reads and parsing when a transport ignores AbortSignal.
async function abortable(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([aborted, operation()]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function gatewaySearch(env, request, signal, services, record) {
  const endpoint = new URL(env.CRYSOUND_DS_TOOLS_BASE);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "zhaohua-partner-gateway" || endpoint.port !== "3091"
    || endpoint.pathname !== "/_zp/ds-tools/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid internal search gateway");
  const token = (await (services.readToken ?? readFile)(env.CRYSOUND_DS_TOOLS_TOKEN_FILE || "/data/.zp-market-token", "utf8")).trim();
  signal.throwIfAborted();
  if (!/^zpd\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Container identity unavailable");
  const query = [...request.query].slice(0, 128).join("");
  record?.("search-api-request-dispatch");
  const response = await (services.fetcher ?? fetch)(new URL("search", endpoint).href, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, count: 10 }),
  });
  signal.throwIfAborted();
  if (!response.ok) { await response.body?.cancel(); throw new Error("Search gateway unavailable"); }
  const data = await response.json();
  signal.throwIfAborted();
  if (!Array.isArray(data?.results) || !data.results.length || data.results.length > 10) throw new Error("Invalid search results");
  const seen = new Set();
  const sources = data.results.flatMap(row => {
    if (typeof row?.url !== "string" || typeof row.title !== "string" || typeof row.summary !== "string") throw new Error("Invalid search result");
    const url = new URL(row.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid search URL");
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ url: row.url, title: row.title, summary: boundedText(row.summary),
      ...(typeof row.snippet === "string" ? { snippet: row.snippet } : {}),
      ...(typeof row.date === "string" && row.date.trim() ? { publishedAt: row.date } : {}) }];
  });
  return { sources, content: "", truncated: false };
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

async function exaSearch(query, parent, record, services, totalTimeoutMs) {
  const env = services.env ?? process.env;
  if (!env.CRYSOUND_MARKET_ORIGIN || !env.CRYSOUND_MARKET_TOKEN_FILE) return [];
  const signal = AbortSignal.any([parent, AbortSignal.timeout(Math.min(5_000, totalTimeoutMs))]);
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
