/** Bounded direct retrieval, question summaries, and concurrent Treg and DeepSeek public-page fallbacks. */
import { gatewayFetch } from "./gateway-fetch.mjs";
import { summarizeFetch } from "./summary.mjs";
import { withAbort, webError } from "./network.mjs";
import { toolTiming } from "./timing.mjs";
import { pageInput, publicArticle, unreadablePage } from "./page-content.mjs";

async function bounded(milliseconds, parent, operation) {
  const stop = new AbortController();
  const signal = parent ? AbortSignal.any([parent, stop.signal]) : stop.signal;
  const timer = setTimeout(() => stop.abort(webError("网页抓取超时，请稍后重试", "WEB_FETCH_TIMEOUT")), milliseconds);
  try { return await withAbort(Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }), signal); }
  finally { clearTimeout(timer); stop.abort(); }
}

function blocked(error) {
  for (let current = error; current; current = current.cause) {
    if (["WEB_BLOCKED_URL", "WEB_INVALID_URL", "WEB_ABORTED"].includes(current.code)) return true;
  }
  return false;
}

/** Fetch a normal page first; failures and direct deadlines race two bounded gateway fallbacks.
 * @param ctx Initiating plugin context. @param config Company settings. @param input Parsed URL. @param prompt Optional question.
 * @param render Released bounded Markdown renderer. @param signal Caller cancellation. @param services Released environment, credential, log and body extraction helpers plus model transport.
 * @returns Retrieved page or a cited question summary; failed fallbacks preserve the direct error/result.
 */
export async function fetchPage(ctx, config, input, prompt, render, signal, services) {
  signal?.throwIfAborted();
  const requestedUrl = input.url;
  input = pageInput(input);
  const started = performance.now();
  let original, failure;
  const fallback = config.fetchTreg || config.fetchDeepSeek;
  const totalTimeout = new URL(input.url).hostname === "mp.weixin.qq.com"
    ? Math.min(config.fetchTotalTimeoutMs, config.fetchWechatTimeoutMs) : config.fetchTotalTimeoutMs;
  const remaining = () => totalTimeout - (performance.now() - started);
  const directTimeout = publicArticle(input) ? config.fetchPublicArticleTimeoutMs : config.fetchDirectTimeoutMs;
  const cite = result => requestedUrl === input.url ? result : { ...result, body: { kind: "text", content: `Source: ${requestedUrl}\n\n${render(result).text}` } };
  const summarize = async result => {
    result = cite(result);
    if (!fallback) return summarizeFetch(ctx, config, prompt, requestedUrl, result, render, signal, services);
    if (remaining() <= 0) return result;
    try {
      return await bounded(remaining(), signal, summarySignal => summarizeFetch(ctx, config, prompt, requestedUrl, result, render, summarySignal, services));
    } catch (error) { signal?.throwIfAborted(); return result; } // A readable page survives the total summary deadline.
  };
  toolTiming.fetch("direct-start");
  try {
    original = fallback
      ? await bounded(Math.min(directTimeout, remaining()), signal, directSignal => ctx.web.fetch(input, directSignal))
      : await ctx.web.fetch(input, signal);
    if (original.statusCode < 400 && unreadablePage(original.body.kind === "text" ? original.body.content : services.extract(original))) {
      original = undefined;
      throw webError("网页只有空壳或验证提示，无法读取正文", "WEB_PROVIDER_ERROR");
    }
    toolTiming.fetch("direct-end", original.statusCode >= 400 ? "http-error" : "success");
  } catch (error) {
    signal?.throwIfAborted();
    toolTiming.fetch("direct-end", error.code === "WEB_FETCH_TIMEOUT" ? "timeout" : "error");
    failure = error;
  }
  if (original && original.statusCode < 400 && original.body.content.trim()) {
    toolTiming.fetch("deepseek-skip", "direct-success");
    toolTiming.fetch("treg-skip", "direct-success");
    return summarize(original);
  }
  const providers = [["deepseek", config.fetchDeepSeek, config.fetchDeepSeekTimeoutMs], ["treg", config.fetchTreg, config.fetchTregTimeoutMs]];
  const stop = new AbortController();
  const parent = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const attempts = [];
  let winner;
  for (const [provider, enabled, timeout] of providers) {
    if (!enabled || blocked(failure) || remaining() <= 0) {
      toolTiming.fetch(`${provider}-skip`, blocked(failure) ? "blocked" : !enabled ? "disabled" : "budget");
      continue;
    }
    attempts.push((async () => {
      toolTiming.fetch(`${provider}-start`);
      try {
        const result = await bounded(Math.min(timeout, remaining()), parent,
          fallbackSignal => gatewayFetch(provider, ctx, config, input, fallbackSignal, services));
        // The first readable result owns the outcome even if both complete in the same turn.
        if (winner) throw new Error("Another provider won");
        winner = provider;
        toolTiming.fetch(`${provider}-end`, "winner");
        stop.abort();
        return result;
      } catch (error) {
        const outcome = parent.aborted ? "cancelled" : error.code === "WEB_FETCH_TIMEOUT" ? "timeout" : "error";
        toolTiming.fetch(`${provider}-request-end`, outcome);
        toolTiming.fetch(`${provider}-end`, outcome);
        throw error;
      }
    })());
  }
  let rescued;
  try { rescued = await Promise.any(attempts); }
  catch (error) { signal?.throwIfAborted(); } // Failed fallbacks preserve the direct result/error.
  finally { stop.abort(); await Promise.allSettled(attempts); }
  signal?.throwIfAborted();
  if (rescued) return summarize(rescued);
  if (failure) throw failure;
  return original;
}
