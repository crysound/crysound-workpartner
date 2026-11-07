import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";

const prefix = "/_zp/ds-tools/", costMicro = 750;

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function jsonBody(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function payload(tool, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
  if (tool === "fetch") {
    if (Object.keys(value).some(key => key !== "url") || typeof value.url !== "string" || value.url.length > 8192) throw new Error("Invalid URL");
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Invalid URL");
    return { url: url.href };
  }
  const allowed = ["query", "count", "ori_question", "localization", "need_content"];
  const text = value => typeof value === "string" && value.trim() && [...value].length <= 128;
  if (Object.keys(value).some(key => !allowed.includes(key)) || !text(value.query)
    || (value.count !== undefined && (!Number.isInteger(value.count) || value.count < 1 || value.count > 50))
    || (value.ori_question != null && !text(value.ori_question))
    || (value.localization !== undefined && value.localization !== "" && !isIP(value.localization))
    || (value.need_content !== undefined && typeof value.need_content !== "boolean")) throw new Error("Invalid search");
  return value;
}

function result(tool, data) {
  if (tool === "fetch") {
    if (typeof data?.title !== "string" || typeof data?.content !== "string") throw new Error("Invalid upstream fetch");
    return { title: data.title, content: data.content };
  }
  if (!Array.isArray(data?.results) || data.results.length > 50) throw new Error("Invalid upstream search");
  return { results: data.results.map(row => {
    if (!["title", "url", "snippet", "summary", "content"].every(key => typeof row?.[key] === "string")) throw new Error("Invalid search row");
    return Object.fromEntries(["title", "url", "snippet", "summary", "content", "site_name", "site_icon", "date", "authority", "rerank_score"].map(key => [key, row[key]]));
  }) };
}

/** Internal-only paid tools. One gateway process owns this durable ledger; reserve before dispatch.
 * Unknown outcomes retain their reservation, so crashes and cancellation cannot reopen spent budget.
 */
export function createDsTools({ stateFile, authenticate, env = process.env, request = fetch, now = Date.now }) {
  const monthlyUsd = Number(env.DEEPSEEK_TOOLS_MONTHLY_USD ?? 10), rpm = Number(env.DEEPSEEK_TOOLS_USER_RPM ?? 20);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 10 || !Number.isInteger(rpm) || rpm < 1) throw new Error("Invalid DeepSeek tools limits");
  let state = { months: {}, users: {}, days: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("DeepSeek tools ledger unreadable"); }
  if (!state || typeof state !== "object" || !state.months || typeof state.months !== "object" || !state.users || typeof state.users !== "object" || Array.isArray(state.months) || Array.isArray(state.users) || Object.values(state.months).some(row => !row || !Number.isSafeInteger(row.charged) || row.charged < 0 || !Number.isSafeInteger(row.success) || row.success < 0 || row.success > row.charged)
    || Object.values(state.users).some(row => !row || !Number.isFinite(row.minute) || !Number.isSafeInteger(row.calls) || row.calls < 0)) throw new Error("DeepSeek tools ledger invalid");
  state.days ??= {};
  if (!state.days || typeof state.days !== "object" || Array.isArray(state.days) || Object.values(state.days).some(users => !users || typeof users !== "object" || Array.isArray(users) || Object.values(users).some(tools => !tools || typeof tools !== "object" || Array.isArray(tools) || Object.entries(tools).some(([tool, row]) => !["fetch", "search"].includes(tool) || !row || !Number.isSafeInteger(row.calls) || row.calls < 0 || !Number.isSafeInteger(row.success) || row.success < 0 || row.success > row.calls)))) throw new Error("DeepSeek tools daily ledger invalid");
  const save = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temp = `${stateFile}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, stateFile);
    const directory = fs.openSync(path.dirname(stateFile), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  const token = () => {
    if (env.DEEPSEEK_TOOLS_ENABLED === "0") return "";
    if (env.DEEPSEEK_TOOLS_API_KEY?.trim()) return env.DEEPSEEK_TOOLS_API_KEY.trim();
    try { return fs.readFileSync(env.DEEPSEEK_TOOLS_KEY_FILE || "/run/deepseek-tools/deepseek-tools.key", "utf8").trim(); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  };
  return async (req, res, url) => {
    if (!url.pathname.startsWith(prefix)) return false;
    const tool = url.pathname.slice(prefix.length);
    if (!["fetch", "search"].includes(tool) || url.search || req.url !== prefix + tool) { send(res, 404, { error: "工具接口不存在" }); return true; }
    if (req.method !== "POST") { send(res, 405, { error: "仅支持提交工具请求" }); return true; }
    const user = authenticate(req);
    if (!user) { send(res, 401, { error: "请重新连接工作伙伴" }); return true; }
    const stop = new AbortController(), timer = setTimeout(() => { stop.abort(); if (!req.complete) req.destroy(); }, 8500);
    const closed = () => stop.abort();
    req.on("aborted", closed); res.on("close", closed);
    let row, daily, reserved = false;
    try {
      let body;
      try { body = payload(tool, await jsonBody(req, 16384)); }
      catch (error) { send(res, 400, { error: "工具参数无效" }); return true; }
      const key = token();
      if (!key) { send(res, 503, { error: "网页备用抓取暂不可用" }); return true; }
      stop.signal.throwIfAborted();
      const time = now(), month = new Date(time + 8 * 3600_000).toISOString().slice(0, 7), minute = Math.floor(time / 60000);
      row = state.months[month] ??= { charged: 0, success: 0 };
      const rate = state.users[user.unionId]?.minute === minute ? state.users[user.unionId] : { minute, calls: 0 };
      if (rate.calls >= rpm) { send(res, 429, { error: "网页备用抓取过于频繁，请稍后重试" }); return true; }
      if ((row.charged + 1) * costMicro > Math.floor(monthlyUsd * 1e6)) { send(res, 429, { error: "网页备用抓取本月额度已用完" }); return true; }
      const day = new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
      const people = state.days[day] ??= {};
      const person = people[user.unionId] ??= {};
      daily = person[tool] ??= { calls: 0, success: 0 };
      daily.calls++;
      rate.calls++; state.users[user.unionId] = rate; row.charged++; save(); reserved = true;
      const response = await request(`https://api.deepseek.com/v1/tools/${tool}`, { method: "POST", redirect: "error", signal: stop.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      if (!response.ok) {
        // Explicit upstream failures are not billed. Never relay error bodies or headers containing credentials.
        row.charged--; reserved = false; save(); await response.body?.cancel();
        send(res, 502, { error: "网页备用抓取失败" }); return true;
      }
      row.success++; daily.success++; reserved = false; save();
      const data = result(tool, await jsonBody(response.body, 2_000_000));
      stop.signal.throwIfAborted();
      send(res, 200, data);
    } catch (error) {
      // No exception text, URL, payload or credential enters gateway logs or the caller's response.
      send(res, 502, { error: reserved ? "网页备用抓取结果未知" : "网页备用抓取暂不可用" });
    } finally {
      clearTimeout(timer); stop.abort(); req.off("aborted", closed); res.off("close", closed);
    }
    return true;
  };
}
