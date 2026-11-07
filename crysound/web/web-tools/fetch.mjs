/** Company anonymous fetch adapter and bounded Chromium fallback. */
import { toolTiming } from "./timing.mjs";
import { publicRequest, USER_AGENT, LANGUAGE, webError } from "./network.mjs";

/** Detect login destinations or forms. @param url Final destination. @param html Page HTML, absent before navigation. @returns Whether login is required. */
export function loginPage(url, html = "") {
  const path = new URL(url).pathname;
  return /^(?:login|signin|passport|sso)\./i.test(new URL(url).hostname)
    || /(?:^|\/)(?:login|log-in|signin|sign-in|passport|oauth|authorize)(?:[/.;-]|$)/i.test(path)
    || /<input\b[^>]*type\s*=\s*["']?password\b/i.test(html)
    || /<title[^>]*>[^<]*(?:登录|登入|sign\s*in|log\s*in)[^<]*<\/title>/i.test(html);
}

/** Identify a short script-driven shell. @param html Decoded HTML. @returns Whether one render should be attempted. */
export function needsRendering(html) {
  for (const [, , body] of compactHtml(html).matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    if (body.replace(/<[^>]*>/g, "").replace(/&(?:nbsp|#160);|\s/g, "").length >= 80) return false;
  }
  // Count text tokens only. This heuristic never produces HTML for display or execution.
  let length = 0, rawTag;
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-z][\w:-]*)\b[^>]*>|([^<]+)/gi)) {
    const [, closing, tag, text] = match;
    if (tag) {
      const name = tag.toLowerCase();
      if (closing && name === rawTag) rawTag = undefined;
      else if (!closing && ["script", "style", "noscript"].includes(name) && !rawTag) rawTag = name;
    } else if (text && !rawTag) {
      length += (text.match(/&(?:nbsp|#160);|\S/g) ?? []).filter(token => token !== "&nbsp;" && token !== "&#160;").length;
      if (length >= 240) return false;
    }
  }
  return /<script\b|enable\s+javascript|需要.{0,5}JavaScript/i.test(html);
}

/** Flatten HTTP redirects using checked transport. @param url Initial URL. @param signal Optional cancellation. @param request Checked request function. @param maxHops Redirect limit. @param main Check login paths when true. @returns Final response and URL. */
export async function followPublic(url, signal, request, maxHops = 5, main = false) {
  for (let hop = 0; ; hop++) {
    if (main && loginPage(url)) throw webError("需要登录，无法抓取", "WEB_PROVIDER_ERROR");
    const response = await request(url, signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    await response.body?.cancel();
    if (hop >= maxHops) throw webError("网页跳转超过上限", "WEB_REDIRECT_BLOCKED");
    const location = response.headers.get("location");
    if (!location) throw webError("网页跳转缺少目标地址", "WEB_PROVIDER_ERROR");
    url = new URL(location, url).href;
  }
}

async function cappedBytes(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw webError("网页资源过大", "WEB_FETCH_TOO_LARGE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks);
      length += value.length;
      if (length > maxBytes) throw webError("网页资源过大", "WEB_FETCH_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
}

/** Validate plugin rendering settings before registration. @param config Resolved plugin config. @returns Render options for the adapter. */
export function renderOptions(config) {
  if (!Number.isInteger(config.renderConcurrency) || config.renderConcurrency < 1) throw new Error("web-fetch-http: renderConcurrency must be a positive integer");
  if (!Number.isInteger(config.renderTimeoutMs) || config.renderTimeoutMs < 1 || config.renderTimeoutMs > 2_147_483_647) throw new Error("web-fetch-http: renderTimeoutMs must be a positive integer within Node's timer range");
  return { maxConcurrent: config.renderConcurrency, renderTimeoutMs: config.renderTimeoutMs };
}

// Skip raw HTML blocks that the tool's Markdown converter omits, before applying character caps.
function compactHtml(html) {
  const tags = /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|textarea)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
  const parts = [];
  let offset = 0;
  for (let match; (match = tags.exec(html));) {
    parts.push(html.slice(offset, match.index));
    offset = tags.lastIndex;
    if (!match[1]) continue;
    const closing = new RegExp(`</${match[1]}\\s*>`, "gi");
    closing.lastIndex = offset;
    offset = closing.exec(html) ? closing.lastIndex : html.length;
    if (match[1].toLowerCase() === "textarea" && !hiddenTextarea(match[2])) parts.push(html.slice(match.index, offset));
    tags.lastIndex = offset;
  }
  return parts.join("") + html.slice(offset);
}

function hiddenTextarea(attributes) {
  for (const [, name, double, single, unquoted] of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
    const value = double ?? single ?? unquoted ?? "";
    if (name.toLowerCase() === "hidden" || (name.toLowerCase() === "aria-hidden" && value.toLowerCase() === "true")) return true;
    if (name.toLowerCase() === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(value)) return true;
  }
  return false;
}

function boundedBody(result, maxChars) {
  const content = result.body.kind === "html" ? compactHtml(result.body.content) : result.body.content;
  return { ...result, body: { ...result.body, content: content.slice(0, maxChars) }, truncated: result.truncated || content.length > maxChars };
}

/** Create a provider with owned render slots and no waiting queue. @param Base Released HTTP provider class. @param WebError Released error class. @param limits Resolved provider limits. @param options Optional local transport/runtime overrides. @returns Company fetch provider. */
export function companyFetcher(Base, WebError, limits, {
  request = (url, signal) => publicRequest(url, signal, {}, undefined, undefined, limits.maxResponseBytes),
  loadRuntime = () => import(process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME),
  maxConcurrent = 1,
  renderTimeoutMs = 2_000,
} = {}) {
  let rendering = 0;
  return new class extends Base {

    async followAndRead(initialUrl, signal) {
      let downloaded = false;
      try {
        toolTiming.fetch("download-start");
        const { response, url } = await followPublic(initialUrl, signal, request, Math.min(5, limits.maxRedirects), true);
        // The streaming byte cap yields a usable prefix even when the declared length exceeds it.
        response.headers.delete("content-length");
        const result = await super.readBody(response, new URL(url), signal);
        downloaded = true;
        toolTiming.fetch("download-end", "success");
        toolTiming.fetch("extract-start");
        try {
          if (loginPage(url, result.body.content)) throw new WebError("需要登录，无法抓取", "WEB_PROVIDER_ERROR");
          if (result.body.kind !== "html" || result.statusCode >= 400 || result.truncated || !needsRendering(result.body.content)) { toolTiming.fetch("render-skip", "static"); return boundedBody(result, limits.maxBodyChars); }
          if (rendering >= maxConcurrent) throw new WebError("网页渲染正忙，请稍后重试", "WEB_PROVIDER_ERROR");
        } finally { toolTiming.fetch("extract-end"); }
        rendering++;
        toolTiming.fetch("render-start");
        try {
          const rendered = await this.render(result, signal);
          toolTiming.fetch("render-end", "success");
          return rendered;
        } catch (error) {
          toolTiming.fetch("render-end", signal.aborted ? "cancelled" : "error");
          throw error;
        } finally { rendering--; }
      } catch (error) {
        if (!downloaded) toolTiming.fetch("download-end", signal.aborted ? "cancelled" : "error");
        if (signal.aborted) throw new WebError(
          signal.reason?.code === "WEB_FETCH_TIMEOUT" ? "网页抓取超时，请稍后重试" : "网页抓取已取消",
          signal.reason?.code === "WEB_FETCH_TIMEOUT" ? "WEB_FETCH_TIMEOUT" : "WEB_ABORTED", { cause: error },
        );
        if (error.cause?.code === "WEB_FETCH_TOO_LARGE") throw new WebError(error.cause.message, "WEB_FETCH_TOO_LARGE", { cause: error });
        if (error instanceof WebError) throw error;
        throw new WebError(error.code?.startsWith("WEB_") ? error.message : "网页请求失败，请稍后重试",
          error.code?.startsWith("WEB_") ? error.code : "WEB_PROVIDER_ERROR", { cause: error });
      }
    }

    async render(result, parentSignal) {
      const stop = new AbortController();
      const signal = AbortSignal.any([parentSignal, stop.signal, AbortSignal.timeout(renderTimeoutMs)]);
      const requests = new Set();
      let browser;
      try {
        const runtime = await loadRuntime();
        signal.throwIfAborted();
        // The image supplies this browser; never download a runtime during a tool call.
        browser = await runtime.launchPinnedChromium({ timeout: renderTimeoutMs, env: { PATH: process.env.PATH, LANG: "zh_CN.UTF-8" } });
        const abort = () => { void browser.close().catch(error => { /* Awaited again in finally. */ }); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN", extraHTTPHeaders: { "Accept-Language": LANGUAGE }, serviceWorkers: "block", acceptDownloads: false });
          let resourceCount = 0, navigationCount = 0, totalBytes = 0, mainStatus = result.statusCode, mainError, finalUrl = result.url;
          await context.routeWebSocket("**/*", socket => socket.close());
          await context.route("**/*", route => {
            const operation = (async () => {
              const incoming = route.request();
              const isMain = incoming.isNavigationRequest() && incoming.frame() === page.mainFrame();
              try {
                if (incoming.method() !== "GET" || ["image", "media", "font"].includes(incoming.resourceType())) return await route.abort();
                if (++resourceCount > 64 || requests.size >= 8) throw webError("网页请求数量超过上限", "WEB_PROVIDER_ERROR");
                if (isMain && ++navigationCount > 6) throw webError("网页跳转超过上限", "WEB_REDIRECT_BLOCKED");
                if (isMain && loginPage(incoming.url())) throw webError("需要登录，无法抓取", "WEB_PROVIDER_ERROR");
                const { response, url } = await followPublic(incoming.url(), signal, request, Math.min(5, limits.maxRedirects), isMain);
                let body = await cappedBytes(response, limits.maxResponseBytes);
                totalBytes += body.length;
                if (totalBytes > limits.maxResponseBytes * 4) throw webError("网页资源总量过大", "WEB_FETCH_TOO_LARGE");
                if (isMain) {
                  finalUrl = url;
                  if (/html/i.test(response.headers.get("content-type") ?? "")) {
                    const base = `<base href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
                    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.headers.get("content-type"))?.[1] ?? "utf-8";
                    const html = new TextDecoder(charset).decode(body);
                    body = Buffer.from(/<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + base) : base + html);
                  }
                }
                const headers = Object.fromEntries(response.headers);
                if (isMain && /html/i.test(headers["content-type"] ?? "")) headers["content-type"] = "text/html; charset=utf-8";
                // Fresh anonymous context: neither accept cookies nor forward them to the network.
                for (const key of ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"]) delete headers[key];
                if (isMain) mainStatus = response.status;
                await route.fulfill({ status: response.status, headers, body });
              } catch (error) {
                if (isMain) mainError = error;
                await route.abort();
              }
            })();
            requests.add(operation);
            operation.finally(() => requests.delete(operation)).catch(error => { /* Page teardown may cancel route actions; goto reports navigation failure. */ });
            return operation;
          });
          const page = await context.newPage();
          try {
            await page.goto(result.url, { waitUntil: "domcontentloaded", timeout: renderTimeoutMs });
            // Analytics and persistent connections must not delay usable page text.
            await page.waitForFunction(() => document.body && (
              document.body.innerText.replace(/\s/g, "").length >= 240
              || [...document.querySelectorAll("article,main")].some(element => element.innerText.replace(/\s/g, "").length >= 80)
              || document.querySelector('input[type="password"]')
              || /登录|登入|sign\s*in|log\s*in/i.test(document.title)
            ), undefined, { timeout: renderTimeoutMs });
          } catch (error) {
            if (mainError) throw mainError;
            throw error;
          }
          if (mainError) throw mainError;
          signal.throwIfAborted();
          const html = await page.content();
          if (loginPage(finalUrl, html)) throw webError("需要登录，无法抓取", "WEB_PROVIDER_ERROR");
          if (mainStatus >= 400 || needsRendering(html)) throw webError("网页渲染后仍无法读取正文", "WEB_PROVIDER_ERROR");
          return boundedBody({ ...result, url: finalUrl, statusCode: mainStatus, body: { kind: "html", content: html } }, limits.maxBodyChars);
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } catch (error) {
        throw new WebError(error.code ? error.message : "网页需要动态渲染，但本次渲染未完成，请稍后重试", parentSignal.aborted ? "WEB_ABORTED" : error.code ?? "WEB_PROVIDER_ERROR", { cause: error });
      } finally {
        stop.abort();
        if (browser) await browser.close();
        await Promise.allSettled([...requests]);
      }
    }
  // Decode up to the byte cap; apply the smaller output cap after removing scripts and styles.
  }({ ...limits, maxBodyChars: limits.maxResponseBytes });
}
