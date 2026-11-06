import crypto from "node:crypto";
import { dataPlatforms } from "./treg-catalog.mjs";
import { createTregNotices, tregLimits, tregFailure as fail, dailyMessage, monthlyMessage, blockedMessage } from "./treg-state.mjs";

const origin = "https://treg.to";
const prefix = "/_zp/treg";
const idPattern = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/;
const companyMessage = "公司数据额度暂时用完，已通知管理员";
const tools = [
  { name: "catalog_search", description: "搜索可用的数据接口；不包含 AI 生成和管理功能。", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } }, required: ["query"], additionalProperties: false } },
  { name: "catalog_get", description: "查询数据接口的参数和价格。", inputSchema: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false } },
  { name: "call", description: "调用数据接口，按本人额度付费；先查询参数和价格。", inputSchema: { type: "object", properties: {
    endpoint_id: { type: "string" }, params: { anyOf: [{ type: "object" }, { type: "array" }] },
    method: { type: "string", enum: ["GET", "POST"] }, query: { type: "object" }, body: { anyOf: [{ type: "object" }, { type: "array" }] },
    idempotency_key: { type: "string", maxLength: 150 },
  }, required: ["endpoint_id"], additionalProperties: false } },
];
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
};
async function readBytes(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail(413, "数据内容过大，请缩小查询范围");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function bodyJson(req) {
  try { return JSON.parse((await readBytes(req.iterator({ destroyOnReturn: false }), 2 * 1024 * 1024)).toString()); }
  catch (error) { req.resume(); if (error.status) throw error; throw fail(400, "请求必须是有效的 JSON"); }
}
function queryString(value) {
  if (!object(value)) throw fail(400, "查询参数无效");
  const query = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|x-treg-|treg_session|api_key|token)/i.test(key)) throw fail(403, "不能传入身份或计费参数");
    for (const v of Array.isArray(item) ? item : [item]) if (v !== null) query.append(key, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return query.toString();
}

/** 只提供数据目录、目录内 GET/POST 和受限 MCP；MCP call 经同一 REST 计费边界转发。
 * 不透传上游 MCP 的管理工具：其 call 也未转交 transport 的 Route-Max-Cost，不能直接代理。
 */
export function createTreg({ enabled, token, orgId, orgSlug, attributionVerified = false, stateDir,
  authenticate, catalog, env = {}, overrides = {}, notify = async () => {}, fetcher = fetch, now = Date.now }) {
  const limitsFor = tregLimits(env, overrides);
  const claimNotice = enabled ? createTregNotices({ dir: stateDir, now }) : null;
  const endpointCache = new Map(), budgets = new Map();
  const fetchJson = async (path) => {
    const response = await fetcher(origin + path, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw fail(502, "数据目录暂时无法读取"); }
    return JSON.parse((await readBytes(response.body, 2 * 1024 * 1024)).toString());
  };
  const readPlatforms = catalog ?? (async () => dataPlatforms(await fetchJson("/catalog/platforms")));
  const platforms = async () => new Set((await readPlatforms()).map((platform) => platform.slug));
  const endpoint = async (id, ancestors = new Set()) => {
    if (typeof id !== "string" || !idPattern.test(id) || ancestors.has(id)) throw fail(403, "只允许调用已开放分类的数据接口");
    // 只缓存公共目录详情；最终允许与否仍按当前目录和所有路由子接口核对。
    let value = endpointCache.get(id);
    if (!value) {
      value = (await fetchJson(`/catalog/endpoints/${encodeURIComponent(id)}`)).endpoint;
      if (!object(value) || value.id !== id) throw fail(502, "数据接口目录无效");
      endpointCache.set(id, value);
    }
    if (!(await platforms()).has(value.platform) || !["data", "routed"].includes(value.kind)
      || !["GET", "POST"].includes(value.method) || value.platform_eligible !== true) throw fail(403, "此数据接口尚未开放或属于受限分类");
    const children = value.routed_children;
    if (value.kind === "routed") {
      if (!Array.isArray(children) || !children.length) throw fail(403, "无法核对路由的数据分类");
      const next = new Set([...ancestors, id]);
      for (const child of children) await endpoint(child, next);
    }
    return value;
  };
  const search = async (q, limit) => {
    if (typeof q !== "string" || q.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 25) throw fail(400, "搜索关键词或条数无效");
    const value = await fetchJson(`/catalog/search?${new URLSearchParams({ q, limit: String(limit) })}`);
    if (!Array.isArray(value.results)) throw fail(502, "数据搜索结果无效");
    const results = [];
    for (const row of value.results) {
      try { results.push(await endpoint(row.id)); }
      catch (error) { if (error.status !== 403) throw error; }
    }
    return { query: q, count: results.length, results };
  };
  const orgHeaders = () => ({ "x-treg-token": token(), "x-treg-org": orgSlug, accept: "application/json" });
  const authHeaders = (user) => ({ ...orgHeaders(), "x-treg-meta": `user=${user.slug}` });
  // 普通用户共用默认标签预算；只为配置了例外的人写个人覆盖。
  // PUT 不发送 status/calls_per_day，保留管理员暂停和次数限制。
  const setBudget = (slug, limits) => {
    const cacheKey = `${slug}:${limits.daily}:${limits.monthly}`;
    if (!budgets.has(cacheKey)) {
      const pending = (async () => {
        const suffix = slug ? `/${encodeURIComponent(slug)}` : "";
        const response = await fetcher(`${origin}/orgs/${orgId}/budgets/user${suffix}`, {
          method: "PUT", headers: { ...orgHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ daily_cap_micro: limits.daily, monthly_cap_micro: limits.monthly }),
          redirect: "error", signal: AbortSignal.timeout(15000),
        });
        await response.body?.cancel();
        if (!response.ok) throw fail(503, "个人数据限额尚未配置好，请联系管理员");
      })();
      budgets.set(cacheKey, pending);
      pending.catch(() => { budgets.delete(cacheKey); });
    }
    return budgets.get(cacheKey);
  };
  const budget = async (user) => {
    await setBudget("", limitsFor(""));
    if (Object.hasOwn(overrides, user.slug)) await setBudget(user.slug, limitsFor(user.slug));
  };
  const usage = async (user) => {
    if (!/^[1-9]\d*$/.test(String(orgId))) throw fail(503, "数据服务尚待管理员完成验证");
    const date = new Date(now()), day = date.toISOString().slice(0, 10);
    const spend = async (days) => {
      const response = await fetcher(`${origin}/orgs/${orgId}/usage/by-tag?key=user&days=${days}`, {
        headers: orgHeaders(), redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { await response.body?.cancel(); throw fail(503, "数据用量暂时无法读取，请稍后再试"); }
      const value = JSON.parse((await readBytes(response.body, 2 * 1024 * 1024)).toString());
      if (value.key !== "user" || !Array.isArray(value.rows)) throw fail(502, "数据用量格式无效");
      const rows = value.rows.filter((row) => row?.value === user.slug);
      if (rows.length > 1 || (rows.length && (!Number.isSafeInteger(rows[0].charged_micro) || rows[0].charged_micro < 0))) throw fail(502, "数据用量格式无效");
      return (rows[0]?.charged_micro ?? 0) / 1e6;
    };
    const [daily, monthly] = await Promise.all([spend(1), spend(date.getUTCDate())]);
    const limits = limitsFor(user.slug);
    return { timezone: "UTC", date: day, month: day.slice(0, 7),
      resetMessage: "北京时间每天 08:00、每月 1 日 08:00 重置额度",
      daily: { usedUsd: daily, limitUsd: limits.daily / 1e6 },
      monthly: { usedUsd: monthly, limitUsd: limits.monthly / 1e6 } };
  };
  const alert = async () => {
    if (!claimNotice()) return;
    try { await notify(); } catch (error) { console.warn("数据额度管理员通知未送达，请检查数据服务"); }
  };
  const call = async (user, id, method, query, body, idempotencyKey) => {
    if (!attributionVerified || !/^[1-9]\d*$/.test(String(orgId)) || !/^[a-z0-9-]+$/.test(orgSlug || "")) throw fail(503, "数据服务尚待管理员完成验证");
    const ep = await endpoint(id);
    if (method !== ep.method) throw fail(403, "请求方法必须与数据目录一致");
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,150}$/.test(idempotencyKey))) throw fail(400, "重复请求标识无效");
    if (body !== undefined && !object(body) && !Array.isArray(body)) throw fail(400, "调用内容必须是 JSON 对象或数组");
    const qs = queryString(query);
    const limits = limitsFor(user.slug);
    if (limits.monthly === 0) throw fail(429, monthlyMessage);
    if (limits.daily === 0) throw fail(429, dailyMessage);
    if (limits.call === 0) throw fail(429, "单次数据额度为零，请联系管理员");
    await budget(user);
    const headers = { ...authHeaders(user), "x-treg-route-max-cost": String(limits.call / 1e6), "content-type": "application/json" };
    // 上游幂等键是组织级命名空间；把本人加入，避免拿另一人的缓存结果。
    if (idempotencyKey) headers["idempotency-key"] = crypto.createHash("sha256").update(`${user.slug}\0${idempotencyKey}`).digest("hex");
    let response, bytes;
    try {
      response = await fetcher(`${origin}/call/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, {
        method, headers, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: "error", signal: AbortSignal.timeout(60000),
      });
      bytes = await readBytes(response.body ?? [], 16 * 1024 * 1024);
    } catch (error) { throw fail(502, "数据调用结果未知，请查询本人用量确认费用，请勿自动重试"); }
    const rawCost = response.headers.get("x-treg-cost-micro");
    const actual = rawCost !== null && /^\d+$/.test(rawCost) ? Number(rawCost) : null;
    let value;
    try { value = bytes.length ? JSON.parse(bytes.toString()) : null; } catch (error) { throw fail(502, "数据接口未返回可读取的 JSON，请缩小查询范围"); }
    if (!response.ok) {
      const code = typeof value?.error === "string" ? value.error : value?.detail?.error;
      if ((response.status === 402 && code === "insufficient_balance") || code === "platform_daily_cap_reached") {
        await alert(); throw fail(503, companyMessage);
      }
      if (code === "tag_spend_cap_reached") throw fail(429, (value?.detail?.period ?? value?.period) === "month" ? monthlyMessage : dailyMessage);
      if (code === "tag_blocked") throw fail(429, blockedMessage);
      if (code === "tag_call_cap_reached") throw fail(429, dailyMessage);
      throw fail(response.status === 429 ? 429 : 502, "数据接口暂未返回结果，请检查参数、额度或联系管理员");
    }
    return { status: response.status, endpoint_id: id, body: value,
      cost_usd: Number.isSafeInteger(actual) ? actual / 1e6 : null,
      costEstimated: !Number.isSafeInteger(actual) };
  };
  const mcp = async (req, res, user) => {
    if (req.method !== "POST") throw fail(405, "此 MCP 接口只接受 POST 请求");
    const message = await bodyJson(req);
    if (!keys(message, ["jsonrpc", "id", "method", "params"]) || message.jsonrpc !== "2.0"
      || (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) throw fail(400, "MCP 请求格式无效");
    const reply = (result) => json(res, 200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "notifications/initialized" && message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.id === undefined) throw fail(400, "MCP 请求缺少标识");
    if (message.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "兆华数据", version: "1.0.0" } });
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") return reply({ tools });
    if (message.method !== "tools/call" || !keys(message.params, ["name", "arguments"])) throw fail(403, "此 MCP 功能尚未开放");
    try {
      const { name, arguments: args } = message.params;
      let value;
      if (name === "catalog_search" && keys(args, ["query", "limit"])) value = await search(args.query, args.limit ?? 8);
      else if (name === "catalog_get" && keys(args, ["endpoint_id"])) value = { endpoint: await endpoint(args.endpoint_id) };
      else if (name === "call" && keys(args, ["endpoint_id", "params", "method", "query", "body", "idempotency_key"])) {
        const ep = await endpoint(args.endpoint_id), method = args.method ?? ep.method;
        if (args.params !== undefined && (args.body !== undefined || args.query !== undefined)) throw fail(400, "params 不能与 body 或 query 同时传入");
        if (args.body !== undefined && !object(args.body) && !Array.isArray(args.body)) throw fail(400, "调用内容必须是 JSON 对象或数组");
        value = await call(user, args.endpoint_id, method, args.query ?? (method === "GET" ? args.params ?? {} : {}), args.body ?? args.params, args.idempotency_key);
      } else throw fail(403, "只开放数据搜索、详情和调用，不能传入自定义身份或请求头");
      return reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (error) {
      const text = error.status ? error.message : "数据服务暂时无法处理，请联系管理员";
      return reply({ content: [{ type: "text", text }], isError: true });
    }
  };
  return async (req, res, url) => {
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return false;
    try {
      const user = authenticate(req);
      if (!user) throw fail(401, "请先登录工作伙伴并使用本人的通行证");
      if (!enabled || !token()) throw fail(503, "数据服务尚未开放");
      const path = url.pathname.slice(prefix.length);
      if (path === "/mcp/" || path === "/mcp") { await mcp(req, res, user); return true; }
      if (path === "/usage" && req.method === "GET" && !url.search) json(res, 200, await usage(user));
      else if (path === "/catalog/platforms" && req.method === "GET" && !url.search) {
        json(res, 200, { platforms: await readPlatforms() });
      } else if (path === "/catalog/search" && req.method === "GET" && [...url.searchParams.keys()].every((key) => ["q", "limit"].includes(key))) {
        json(res, 200, await search(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 8)));
      } else if (path.startsWith("/catalog/endpoints/") && req.method === "GET" && !url.search) {
        json(res, 200, { endpoint: await endpoint(path.slice("/catalog/endpoints/".length)) });
      } else if (path.startsWith("/call/") && ["GET", "POST"].includes(req.method)) {
        const body = req.method === "POST" ? await bodyJson(req) : undefined;
        const query = Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => {
          const values = url.searchParams.getAll(key); return [key, values.length === 1 ? values[0] : values];
        }));
        const result = await call(user, path.slice(6), req.method, query, body, req.headers["idempotency-key"]);
        if (result.costEstimated) res.setHeader("x-zp-cost-estimated", "1");
        else res.setHeader("x-treg-cost-micro", String(Math.round(result.cost_usd * 1e6)));
        json(res, 200, result.body);
      } else throw fail(403, "此路径或请求方法尚未开放，只能查询和调用数据目录");
    } catch (error) { json(res, error.status ?? 503, { error: error.status ? error.message : "数据服务暂时无法处理，请联系管理员" }); }
    return true;
  };
}
