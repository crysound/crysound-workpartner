/** Public-destination validation and DNS-pinned anonymous HTTP transport. */
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/** Browser identification for anonymous page retrieval. */
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/** Preferred languages for Chinese websites. */
export const LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
]) blocked.addSubnet(address, prefix, "ipv4");
// Only global IPv6 unicast is usable; refuse transition mechanisms carrying IPv4 destinations.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) blocked.addSubnet(address, prefix, "ipv6");

/** Check global address eligibility. @param address IP literal. @returns Whether the address is public. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** Build a company policy error. @param message Actionable explanation. @param code Web error code. @returns Coded error for the adapter. */
export function webError(message, code = "WEB_BLOCKED_URL") {
  return Object.assign(new Error(message), { code });
}

/** Observe optional cancellation without abandoning operation settlement. @param operation Pending work. @param signal Omitted means wait normally. @returns Work result or abort rejection. */
export function withAbort(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Validate a URL and every DNS answer. @param input URL string. @param resolve Optional DNS implementation. @returns URL and checked addresses. */
export async function publicTarget(input, resolve = lookup) {
  let url;
  try { url = new URL(input); } catch (error) { throw webError("网页地址无效", "WEB_INVALID_URL"); }
  if (url.href.length > 2048 || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw webError("只允许不含身份信息的 HTTP 或 HTTPS 网页地址");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw webError("无法抓取私网、本机或保留地址");
  }
  return { url, records };
}

/** Pin checked DNS answers on a fresh socket without proxy or ambient identity. @param input URL. @param signal Optional cancellation. @param headers Optional non-secret headers. @param resolve Optional DNS implementation. @param send Optional test transport. @returns Streaming Fetch-compatible response. */
export async function publicRequest(input, signal, headers = {}, resolve = lookup, send) {
  signal?.throwIfAborted();
  const { url, records } = await withAbort(publicTarget(input, resolve), signal);
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const pinnedLookup = (_hostname, options, callback) => {
      const candidates = options.family ? records.filter(record => record.family === options.family) : records;
      if (!candidates.length) return callback(new Error("No checked address for requested family"));
      callback(null, ...(options.all ? [candidates] : [candidates[0].address, candidates[0].family]));
    };
    const dispatch = send ?? (url.protocol === "https:" ? https.request : http.request);
    const request = dispatch(url, {
      method: "GET", signal, agent: false, lookup: pinnedLookup,
      headers: { ...headers, "user-agent": USER_AGENT, "accept-language": LANGUAGE, "accept-encoding": "identity" },
    }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) {
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
      }
      const status = response.statusCode;
      // Fetch Response rejects bodies for these statuses.
      const noBody = [204, 205, 304].includes(status);
      if (noBody) response.resume();
      accept(new Response(noBody ? null : Readable.toWeb(response), { status, headers: responseHeaders }));
    });
    request.on("error", reject);
    request.end();
  });
}
