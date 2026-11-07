// 私有市场：网关持有内部账号，发布者与审批记录只由网关维护。
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import semver from "semver";
import { parsePluginGuide } from "./plugin-guide.mjs";

const PREFIX = "/_zp/npm/";
const PACKAGE = /^@crysound\/[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw fail(413, "发布内容过大"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readState(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return { format: 1, packages: {} }; throw error; }
  const state = JSON.parse(text);
  if (state?.format !== 1 || !state.packages || Array.isArray(state.packages) || typeof state.packages !== "object") throw new Error("市场记录无效，请从备份恢复");
  for (const [name, pkg] of Object.entries(state.packages)) {
    if (!PACKAGE.test(name) || typeof pkg.owner !== "string" || !pkg.versions || typeof pkg.versions !== "object") throw new Error("市场包记录无效");
    for (const [version, row] of Object.entries(pkg.versions)) {
      if (!VERSION.test(version) || !["publishing", "pending", "approved", "rejected"].includes(row.status) || typeof row.publisher !== "string" || !Number.isFinite(row.publishTimestamp)) throw new Error("市场版本记录无效");
    }
  }
  return state;
}

/**
 * 创建市场 HTTP 处理器；发布与审批串行、原子保存。未知上传结果保留 publishing，需管理员核对。
 * @param options 存储文件、内部注册表及凭据、公网/内网 origin、身份与用户列表读取器、管理员列表与通知函数。
 *   fetcher 默认使用进程 fetch；maxBytes 默认限制发布 JSON 为 64 MiB。
 *   officialPublishers 与 officialPackages 必须同时命中才显示官方标识；后者允许 @crysound/*，缺省均为空。
 *   officialPlugins 由公司 plugins.json 指定包名、中文名与维护人；officialMaintainers 可覆盖部署名单。
 *   retiredPackages 从市场索引和引导中隐藏退役包，保留注册表内容和审批记录。
 *   官方维护人可发布新版本但仍须逐版审批，其他包保持首发者所有权。
 * @returns 异步处理器；已处理的市场路径返回 true，其他路径返回 false，HTTP 失败由处理器回答。
 */
export function createMarket({ stateFile, registry, authorization, publicOrigin, internalOrigin, authenticate, sessionUser, readUsers, admins, officialPublishers = [], officialPackages = [], officialMaintainers = {}, officialPlugins = {}, retiredPackages = [], notify = async () => {}, fetcher = fetch, maxBytes = 64 * 1024 * 1024 }) {
  if (!Array.isArray(retiredPackages) || retiredPackages.some((name) => !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name))) throw new Error("退役插件配置必须是包名列表");
  if (!officialMaintainers || Array.isArray(officialMaintainers) || typeof officialMaintainers !== "object" || Object.entries(officialMaintainers).some(([name, slugs]) => !PACKAGE.test(name) || !Array.isArray(slugs) || !slugs.length || slugs.some((slug) => typeof slug !== "string" || !slug.trim()))) throw new Error("市场维护人配置必须是包名到用户代号列表的对象");
  if (!officialPlugins || Array.isArray(officialPlugins) || typeof officialPlugins !== "object" || Object.entries(officialPlugins).some(([name, entry]) => !PACKAGE.test(name) || !entry || typeof entry.displayName !== "string" || !entry.displayName.startsWith("兆华") || entry.displayName.length > 80 || !Array.isArray(entry.maintainers) || entry.maintainers.some((slug) => typeof slug !== "string" || !slug.trim()) || (entry.home !== undefined && typeof entry.home !== "boolean"))) throw new Error("官方插件配置必须包含包名、兆华开头的显示名和维护人列表");
  const maintainers = (name) => officialMaintainers[name] ?? officialPlugins[name]?.maintainers ?? [];
  const designated = (name) => Object.hasOwn(officialPlugins, name);
  const isOfficial = (name, owner) => designated(name) || (officialPublishers.includes(owner) && (officialPackages.includes(name) || officialPackages.includes("@crysound/*")));
  const legacyNames = { "@crysound/design": "兆华设计", "@crysound/motion": "兆华动画", "@crysound/data": "兆华数据" };
  const categories = Object.fromEntries([
    ["design", "设计", "Design"], ["video", "视频", "Video"], ["documents", "文档与报告", "Documents and reports"],
    ["data", "数据", "Data"], ["development", "研发", "Development"], ["sales", "销售与市场", "Sales and marketing"], ["other", "其他", "Other"],
  ].map(([id, zh, en]) => [id, { title: { zh, en } }]));
  const categoryOf = (manifest, name) => {
    if (name === "@crysound/data") return "data";
    const words = [...(Array.isArray(manifest.labels) ? manifest.labels : []), ...(Array.isArray(manifest.keywords) ? manifest.keywords : [])];
    return Object.keys(categories).find((id) => words.some((word) => typeof word === "string" && [id, categories[id].title.zh, categories[id].title.en.toLowerCase()].includes(word.toLowerCase()))) || "other";
  };
  let state = readState(stateFile);
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch((error) => { /* 错误由请求处理器报告，后续操作仍可执行。 */ });
    return result;
  };
  const save = (next) => {
    const file = `${stateFile}.tmp`;
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, stateFile);
    state = next;
  };
  const upstream = (path, init = {}) => fetcher(`${registry}${path}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(60000),
    headers: { authorization, accept: "application/json", ...init.headers },
  });

  async function publish(req, res, user, name, path) {
    const body = await readBody(req, maxBytes);
    let doc;
    try { doc = JSON.parse(body); } catch (error) { throw fail(400, "发布内容必须是 JSON"); }
    if (!doc?.versions || typeof doc.versions !== "object" || Array.isArray(doc.versions)) throw fail(400, "发布内容需要 versions 对象");
    const entries = Object.entries(doc.versions);
    if (doc?.name !== name || entries.length !== 1) throw fail(400, "每次只能发布一个版本，包名必须与路径一致");
    const [version, manifest] = entries[0];
    if (!VERSION.test(version) || semver.valid(version) === null || manifest?.name !== name || manifest?.version !== version || typeof manifest.dsh?.bundle?.patch !== "string" || !manifest.dsh.bundle.patch.trim() || typeof manifest.description !== "string" || !manifest.description.trim()) throw fail(400, "需要有效版本、description 和 dsh.bundle.patch");
    if (manifest.engines?.dsh !== undefined && (typeof manifest.engines.dsh !== "string" || !manifest.engines.dsh.trim() || semver.validRange(manifest.engines.dsh) === null)) throw fail(400, "engines.dsh 必须是有效的 SemVer 范围");
    for (const field of ["displayName", "title"]) {
      if (manifest[field] !== undefined && (typeof manifest[field] !== "string" || !manifest[field].trim() || manifest[field].length > 80)) throw fail(400, `${field} 必须是 1 到 80 字的显示名`);
    }
    try { parsePluginGuide(manifest.dsh?.market?.guide); } catch (error) { throw fail(400, error.message); }
    if (!doc._attachments || typeof doc._attachments !== "object" || Array.isArray(doc._attachments) || Object.keys(doc._attachments).length !== 1 || doc._deleted || doc._rev) throw fail(400, "只接受带 tarball 的新版本发布");
    // 仅向后端发送新版本数据，丢弃调用者的权限、修订号等注册表字段。
    const upload = JSON.stringify({ name, versions: { [version]: manifest }, "dist-tags": {}, _attachments: doc._attachments, readme: typeof doc.readme === "string" ? doc.readme : "" });
    await serial(async () => {
      const existing = state.packages[name];
      const maintained = isOfficial(name, existing?.owner ?? user.slug) && maintainers(name).includes(user.slug);
      if (designated(name) && !existing && !maintained && !officialPublishers.includes(user.slug)) throw fail(403, "这个包名由兆华官方保留，只有指定维护人或公司发布账号能首次发布");
      if (existing && existing.owner !== user.slug && !maintained) throw fail(403, "只有首个发布者或指定的官方维护人能发布这个包的新版本");
      if (!isOfficial(name, existing?.owner ?? user.slug) && [name.split("/").at(-1), manifest.displayName, manifest.title].some((value) => typeof value === "string" && value.trim().startsWith("兆华"))) throw fail(403, "“兆华”开头的名称仅供官方插件使用，请修改插件名称后重新发布");
      if (existing?.versions[version]) throw fail(409, "这个版本已记录，不能覆盖；请发布新版本或联系管理员核对上传记录");
      const current = await upstream(path);
      if (current.status !== 404 && !current.ok) { await current.body?.cancel(); throw fail(502, "无法核对现有版本，请稍后重试"); }
      const old = current.ok ? await current.json() : null;
      if (!current.ok) await current.body?.cancel();
      if (old?.versions?.[version]) throw fail(409, "注册表已有这个版本，不能覆盖");
      if (old && !existing) throw fail(409, "注册表已有包但缺少所有权记录，请管理员恢复记录");
      const next = structuredClone(state);
      const pkg = next.packages[name] ??= { owner: user.slug, versions: {} };
      pkg.versions[version] = {
        status: "publishing", publisher: user.slug, publishTimestamp: Math.floor(Date.now() / 1000),
        description: manifest.description.slice(0, 2000), readme: String(doc.readme || manifest.readme || "").slice(0, 4000),
      };
      save(next);
      let response;
      try { response = await upstream(path, { method: "PUT", headers: { "content-type": "application/json" }, body: upload }); }
      catch (error) { throw fail(502, "插件上传结果未知，已保留待核对记录；请管理员核对上传结果，勿重复发布同一版本"); }
      await response.body?.cancel();
      if (response.status >= 500) throw fail(502, "插件上传结果未知，已保留待核对记录；请管理员核对，勿重复发布同一版本");
      if (!response.ok) {
        // 后端明确拒绝时撤销预留；连接中断则保留，避免他人抢占或覆盖。
        const rollback = structuredClone(state);
        if (existing) delete rollback.packages[name].versions[version];
        else delete rollback.packages[name];
        save(rollback);
        throw fail(response.status >= 500 ? 502 : response.status, "注册表拒绝发布，请检查包内容后重试");
      }
      const done = structuredClone(state);
      done.packages[name].versions[version].status = "pending";
      try { save(done); }
      catch (error) { throw fail(500, "插件已上传，但待审批记录保存失败；已保留待核对记录，请管理员核对，勿重复发布"); }
      void Promise.resolve().then(() => notify({ name, version, publisher: user.slug, admins })).catch((error) => console.log("市场审批通知失败，请打开审批页查看"));
      json(res, 201, { ok: true, status: "pending", message: `${name} ${version} 已上传，等待管理员审批` });
    });
  }

  async function index(res, guidesOnly = false) {
    const plugins = [];
    const guides = [];
    const users = readUsers();
    const labels = { "crysound-official": { title: { zh: "兆华官方", en: "CRYSOUND official" } } };
    for (const [name, pkg] of Object.entries(state.packages)) {
      if (retiredPackages.includes(name)) continue;
      const approved = Object.keys(pkg.versions).filter((v) => pkg.versions[v].status === "approved").sort(semver.rcompare);
      if (!approved.length) continue;
      const response = await upstream(`/${encodeURIComponent(name)}`);
      if (!response.ok) { await response.body?.cancel(); throw fail(502, "无法核对已批准的包，请管理员检查注册表"); }
      const doc = await response.json();
      const versions = approved.flatMap((version) => {
        const manifest = doc.versions?.[version];
        if (!manifest) return [];
        if (manifest.name !== name || manifest.version !== version || typeof manifest.description !== "string") throw fail(502, "已批准版本的注册表数据无效");
        return [{ version, publishTimestamp: pkg.versions[version].publishTimestamp, source: { type: "npm" },
          engines: typeof manifest.engines?.dsh === "string" ? { dsh: manifest.engines.dsh } : {} }];
      });
      if (!versions.length) continue;
      const manifest = doc.versions[(versions.find((v) => semver.prerelease(v.version) === null) ?? versions[0]).version];
      const official = isOfficial(name, pkg.owner);
      const title = (official ? (officialPlugins[name]?.displayName ?? legacyNames[name]) : undefined) || manifest.displayName || manifest.title;
      if (guidesOnly && official) {
        let guide;
        try { guide = parsePluginGuide(manifest.dsh?.market?.guide); } catch (error) { throw fail(502, "已批准版本的引导内容无效"); }
        if (guide) guides.push({ name, version: manifest.version, title: title || name, home: officialPlugins[name]?.home === true, guide });
      }
      if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 80)) throw fail(502, "已批准版本的显示名无效");
      const maintenanceLabels = official ? (maintainers(name).length ? maintainers(name) : [pkg.owner]).filter((slug, index, slugs) => slugs.indexOf(slug) === index).flatMap((slug) => {
        const person = users.find((user) => user.slug === slug)?.name;
        if (typeof person !== "string" || !person.trim()) return [];
        const id = `crysound-maintainer:${slug}`;
        labels[id] = { title: { zh: `维护：${person}`, en: `Maintained by ${person}` } };
        return [id];
      }) : [];
      // Preview bytes are embedded by the package author, so no private registry URL or token reaches an image request.
      const preview = manifest.dsh?.market?.preview;
      const image = typeof preview === "string" && preview.length <= 44000 ? /^data:image\/(?:png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(preview) : null;
      const bytes = image ? Buffer.from(image[1], "base64") : null;
      // The pinned native index reader limits inline icons to 32 KiB and canonical base64.
      const icon = bytes && bytes.length <= 32 * 1024 && bytes.toString("base64") === image[1] ? preview : undefined;
      plugins.push({ name, ...(icon ? { icon } : {}), ...(title === undefined ? {} : { title: title.trim() }), description: manifest.description,
        author: official ? "兆华工作伙伴" : users.find((user) => user.slug === pkg.owner)?.name || pkg.owner,
        metadata: { category: categoryOf(manifest, name), keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((word) => typeof word === "string") : [], labels: official ? ["crysound-official", ...maintenanceLabels] : [], sortKeys: {} },
        versions,
      });
    }
    plugins.sort((a, b) => Number(b.metadata.labels.includes("crysound-official")) - Number(a.metadata.labels.includes("crysound-official")) || Math.max(...b.versions.map((v) => v.publishTimestamp)) - Math.max(...a.versions.map((v) => v.publishTimestamp)) || a.name.localeCompare(b.name));
    if (guidesOnly) return json(res, 200, { guides: guides.sort((a, b) => Object.keys(officialPlugins).indexOf(a.name) - Object.keys(officialPlugins).indexOf(b.name)) });
    json(res, 200, { format: 1, title: "兆华市场", metadata: { categories, labels, sortKeys: {} }, plugins });
  }

  async function admin(req, res) {
    const user = sessionUser(req);
    if (!user) { res.writeHead(302, { location: "/_zp/login?next=%2F_zp%2Fmarket%2Fadmin", "cache-control": "no-store" }); return res.end(); }
    if (!admins.includes(user.slug)) throw fail(403, "只有市场管理员能访问审批页");
    if (req.method === "POST") {
      if (req.headers.origin !== publicOrigin) throw fail(403, "审批请求来源无效，请从审批页操作");
      const form = new URLSearchParams(await readBody(req, 16384));
      const name = form.get("name"), version = form.get("version"), action = form.get("action");
      if (!PACKAGE.test(name) || !VERSION.test(version) || !["approved", "rejected", "notify"].includes(action)) throw fail(400, "审批参数无效");
      await serial(async () => {
        const row = state.packages[name]?.versions[version];
        if (row?.status !== "pending") throw fail(409, "版本已处理或尚未完成上传，请刷新页面");
        if (action === "notify") {
          try { await notify({ name, version, publisher: row.publisher, admins }); }
          catch (error) { throw fail(502, "部分审批卡片未送达，请检查飞书机器人权限后重发；待审批记录已保留"); }
          return;
        }
        if (action === "approved") {
          const response = await upstream(`/${encodeURIComponent(name)}`);
          if (!response.ok) { await response.body?.cancel(); throw fail(502, "无法核对待审批的包，请稍后重试"); }
          if (!(await response.json()).versions?.[version]) throw fail(409, "注册表缺少这个版本，请管理员核对后再审批");
        }
        const next = structuredClone(state);
        Object.assign(next.packages[name].versions[version], { status: action, reviewer: user.slug, reviewedAt: new Date().toISOString() });
        save(next);
      });
      res.writeHead(303, { location: "/_zp/market/admin", "cache-control": "no-store" }); return res.end();
    }
    if (req.method !== "GET") throw fail(405, "不支持此方法");
    const rows = Object.entries(state.packages).flatMap(([name, pkg]) => Object.entries(pkg.versions).filter(([, row]) => row.status === "pending").map(([version, row]) =>
      `<article><h2>${esc(name)} · ${esc(version)}</h2><p>发布者：${esc(row.publisher)}</p><p>${esc(row.description)}</p><pre>${esc(row.readme)}</pre><form method="post"><input type="hidden" name="name" value="${esc(name)}"><input type="hidden" name="version" value="${esc(version)}"><button name="action" value="approved">批准上架</button> <button name="action" value="rejected">拒绝上架</button> <button name="action" value="notify">重发审批卡片</button></form></article>`)).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>兆华市场审批</title><style>body{font:16px/1.6 sans-serif;max-width:850px;margin:32px auto;padding:0 20px;color:#170057}article{border-bottom:1px solid #ddd;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:8px 20px}</style><h1>兆华市场 · 待审批</h1>${rows || "<p>暂无待审批版本。</p>"}</html>`);
  }

  return async function market(req, res, url) {
    if (!url.pathname.startsWith(PREFIX) && !url.pathname.startsWith("/_zp/market/")) return false;
    try {
      if (url.pathname === "/_zp/market/admin") { await admin(req, res); return true; }
      if (url.pathname === "/_zp/market/guides.json" && req.method === "GET") {
        if (!authenticate(req) && !sessionUser(req)) throw fail(401, "市场登录已失效，请重新登录");
        await index(res, true); return true;
      }
      const user = authenticate(req);
      if (!user) throw fail(401, "市场登录已失效，请重新登录");
      if (url.pathname === "/_zp/market/index.json" && req.method === "GET") { await index(res); return true; }
      if (!url.pathname.startsWith(PREFIX)) throw fail(404, "没有这个市场接口");
      let path;
      try { path = decodeURIComponent(url.pathname.slice(PREFIX.length)); } catch (error) { throw fail(400, "包路径无效"); }
      const match = /^(@crysound\/[a-z0-9][a-z0-9._~-]*)(?:\/([^/]+)|\/-\/([a-zA-Z0-9._~-]+\.tgz))?$/.exec(path);
      if (req.method === "PUT" && /^(?:@[^/]+\/)?兆华/.test(path)) throw fail(403, "“兆华”开头的名称仅供官方插件使用，请修改插件包名后重新发布");
      if (!match || match[1].length > 214) throw fail(403, "市场只接受 @crysound/ 包及其 tarball");
      const [, name, selector, tarball] = match;
      if (req.method === "PUT" && !selector && !tarball) { await publish(req, res, user, name, `/${encodeURIComponent(name)}`); return true; }
      if (!["GET", "HEAD"].includes(req.method)) throw fail(403, "禁止删除、修改 dist-tag 或改写包数据；请发布新版本");
      if (selector && !/^(?:[a-zA-Z0-9][a-zA-Z0-9._+~-]*)$/.test(selector)) throw fail(400, "版本路径无效");
      const pkg = state.packages[name];
      if (!pkg) throw fail(404, "没有可安装的版本");
      const metadata = await upstream(`/${encodeURIComponent(name)}`);
      if (!metadata.ok) { await metadata.body?.cancel(); throw fail(metadata.status, "注册表未能读取这个包"); }
      const doc = await metadata.json();
      const readable = (version) => {
        const row = state.packages[name]?.versions[version];
        return row?.status === "approved" || (row?.status === "pending" && row.publisher === user.slug);
      };
      doc.versions = Object.fromEntries(Object.entries(doc.versions ?? {}).filter(([version]) => readable(version)));
      const approved = Object.keys(doc.versions).filter((version) => state.packages[name].versions[version].status === "approved").sort(semver.rcompare);
      if (!Object.keys(doc.versions).length) throw fail(404, "没有可安装的版本");
      doc.time = Object.fromEntries(Object.entries(doc.time ?? {}).filter(([version]) => Object.hasOwn(doc.versions, version)));
      doc["dist-tags"] = Object.fromEntries(Object.entries(doc["dist-tags"] ?? {}).filter(([tag, version]) => tag !== "latest" && approved.includes(version)));
      if (approved.length) doc["dist-tags"].latest = approved[0];
      if (tarball) {
        // tarball 文件名由注册表元数据映射到版本，不能只凭文件名中的版本授权。
        if (!Object.values(doc.versions).some((manifest) => manifest.dist?.tarball && new URL(manifest.dist.tarball).pathname.split("/").pop() === tarball)) throw fail(404, "没有可安装的版本");
        const r = await upstream(`/${encodeURIComponent(name)}/-/${tarball}`);
        if (!r.ok) { await r.body?.cancel(); throw fail(r.status, "注册表未能读取这个包"); }
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "private, no-store" });
        if (req.method === "HEAD") { await r.body?.cancel(); res.end(); }
        else await pipeline(Readable.fromWeb(r.body), res);
      } else {
        const version = selector && (Object.hasOwn(doc.versions, selector) ? selector : doc["dist-tags"][selector]);
        if (selector && (!version || !Object.hasOwn(doc.versions, version))) throw fail(404, "没有可安装的版本");
        const result = selector ? doc.versions[version] : doc;
        const rewrite = (v) => {
          if (!v?.dist?.tarball) return;
          const u = new URL(v.dist.tarball);
          const file = u.pathname.split("/").pop();
          if (!/^[a-zA-Z0-9._~-]+\.tgz$/.test(file)) throw fail(502, "注册表返回无效 tarball 地址");
          const origin = internalOrigin && req.headers.host === new URL(internalOrigin).host ? internalOrigin : publicOrigin;
          v.dist.tarball = `${origin}${PREFIX}${name}/-/${file}`;
        };
        if (selector) rewrite(result);
        else for (const v of Object.values(doc.versions)) rewrite(v);
        if (req.method === "HEAD") { res.writeHead(200, { "cache-control": "no-store" }); res.end(); }
        else json(res, 200, result);
      }
    } catch (error) {
      console.log("市场请求失败", error.status || 500);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "市场操作失败，请管理员检查记录与注册表状态" });
      else res.destroy();
    }
    return true;
  };
}
