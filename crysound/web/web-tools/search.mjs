/** Search through the released credential, wire mapping and request log paths.
 * @param Provider Released search class. @param WebError Released error class.
 * @param options Resolved options.
 * @param request Search query. @param signal Optional caller cancellation.
 * @param timeoutMs Per-attempt limit, defaulting to ten seconds. @returns First successful native search result.
 */
export async function searchWithFallback(Provider, WebError, options, request, signal, timeoutMs = 10_000) {
  const gpt = "codex/gpt-6.1-sol", deepseek = "deepseek/deepseek-flash";
  const models = [gpt, deepseek];
  const failures = [];
  for (const model of models) {
    signal?.throwIfAborted();
    const attempt = AbortSignal.timeout(timeoutMs);
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
