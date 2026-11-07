/** Search through the released credential, wire mapping and request log paths.
 * @param Provider Released search class. @param WebError Released error class.
 * @param options Resolved options.
 * @param request Search query. @param signal Optional caller cancellation.
 * @param timeoutMs Primary attempt limit, defaulting to twelve seconds; fallback uses at most four seconds. @returns First successful search result.
 */
export async function searchWithFallback(Provider, WebError, options, request, signal, timeoutMs = 12_000) {
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
