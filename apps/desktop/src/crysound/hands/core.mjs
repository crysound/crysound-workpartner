import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import tools from "../../../../../crysound/hands/tools.json" with { type: "json" };
import { HandsError, TEXT_LIMIT, FILE_LIMIT, validateCall } from "../../../../../crysound/hands/wire.mjs";

import { sensitivePath } from "../../../../../crysound/hands/paths.mjs";
export { sensitivePath } from "../../../../../crysound/hands/paths.mjs";

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
const fail = (code, message) => { throw new HandsError(code, message); };


/**
 * 无 Electron 依赖的本机文件服务。授权默认空；确认默认拒绝；trash/open 必须由宿主注入。
 * @param options 回调 confirm({tool,paths,summary,source,sessionId,signal})、trash(path)、open(path)；confirmTimeoutMs 仅可缩短 60 秒上限。
 * @returns execute、setGrants 和 clearSessions；宿主撤销授权时须等待 setGrants 完成。
 */
export function createHandsCore({ confirm = async () => "deny", trash, open, confirmTimeoutMs = 60_000 } = {}) {
  if (!(confirmTimeoutMs > 0 && confirmTimeoutMs <= 60_000)) throw new Error("confirmTimeoutMs must be within 1..60000");
  let grants = [];
  let revision = 0;
  const sessions = new Map();

  async function setGrants(next) {
    // 先撤销再解析新授权，避免异步 realpath 期间继续使用旧权限。
    grants = [];
    sessions.clear();
    const generation = ++revision;
    const resolved = [];
    for (const grant of next) {
      if (typeof grant.path !== "string" || typeof grant.readOnly !== "boolean" || sensitivePath(grant.path)) fail("DENIED", "不能授权敏感目录");
      const root = await fs.realpath(grant.path);
      if (sensitivePath(root) || !(await fs.stat(root)).isDirectory()) fail("DENIED", "授权目录无效");
      resolved.push({ path: root, readOnly: grant.readOnly });
    }
    if (generation === revision) grants = resolved;
  }

  async function resolve(value, write = false, missing = false) {
    if (!path.isAbsolute(value) || sensitivePath(value)) fail("DENIED", "该路径不在可访问的授权范围内");
    const target = path.resolve(value);
    const matches = grants.filter((g) => inside(g.path, target));
    if (!matches.length || sensitivePath(target)) fail("DENIED", "该路径不在可访问的授权范围内");
    if (write && matches.some((g) => g.readOnly)) fail("READ_ONLY", "该文件夹为只读，请在电脑设置中修改授权");
    const root = matches.sort((a, b) => b.path.length - a.path.length)[0].path;
    if (write && target === root) fail("DENIED", "不能修改授权根目录本身");
    if (await fs.realpath(root) !== root) fail("DENIED", "授权目录已改变，请重新授权");
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (error.code === "ENOENT" && missing && i === parts.length - 1) return target;
        throw error;
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail("DENIED", "跳过链接、特殊文件或共享硬链接");
      if (write && i === parts.length - 1 && !stat.isFile()) fail("DENIED", "修改操作只支持单个普通文件");
    }
    const real = await fs.realpath(target);
    if (!inside(root, real) || sensitivePath(real)) fail("DENIED", "链接指向授权范围外");
    return real;
  }

  async function readHandle(value, limit) {
    const filename = await resolve(value);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail("DENIED", "只支持普通文件");
      if (stat.size > limit) fail("SIZE_LIMIT", limit <= TEXT_LIMIT ? "文本不能超过 1 MB" : "文件不能超过 200 MB");
      return { handle, size: stat.size, filename };
    } catch (error) { await handle.close(); throw error; }
  }

  async function text(value, maximum = TEXT_LIMIT) {
    const { handle, size } = await readHandle(value, maximum);
    try {
      const buffer = Buffer.alloc(size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > maximum) fail("SIZE_LIMIT", "文本不能超过 1 MB");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }

  async function authorized(request, paths, context) {
    const folder = paths.length === 1 ? path.dirname(paths[0]) : null;
    const key = folder && context.sessionId ? `${context.sessionId}\0${folder}` : null;
    if (key && sessions.has(key)) return true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    let timer;
    let stop;
    try {
      const decision = await Promise.race([
        Promise.resolve().then(() => confirm({ ...request, paths, source: context.source, sessionId: context.sessionId, signal: controller.signal })),
        new Promise((resolve) => {
          stop = () => resolve("deny");
          controller.signal.addEventListener("abort", stop, { once: true });
          timer = setTimeout(() => { controller.abort(); resolve("deny"); }, confirmTimeoutMs);
          if (context.signal?.aborted) controller.abort();
        }),
      ]);
      if (!["allow", "allow-folder-for-session"].includes(decision)) fail("CONFIRM_DENIED", "操作未获确认；请等你回到电脑前确认");
      context.signal?.throwIfAborted();
      if (decision === "allow-folder-for-session" && key) {
        if (sessions.size >= 100) fail("DENIED", "本次会话的文件夹授权已达上限，请逐次确认");
        sessions.set(key, true);
      }
      return true;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", stop);
      context.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async function replace(value, writer, context, check) {
    const target = await resolve(value, true, true);
    const temporary = path.join(path.dirname(target), `.zp-hands-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      const bytes = await writer(handle);
      context.signal?.throwIfAborted();
      await handle.sync();
      await handle.close();
      await resolve(value, true, true);
      check();
      await fs.rename(temporary, target);
      return bytes;
    } finally {
      await handle.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async function execute(name, args, context = {}) {
    const tool = validateCall(tools, name, args);
    const generation = revision;
    const check = () => {
      context.signal?.throwIfAborted();
      if (generation !== revision) fail("DENIED", "文件夹授权已改变；如操作已开始，请检查本机结果");
    };
    let confirmed = false;
    let bytes = 0;
    try {
      context.signal?.throwIfAborted();
      if (name === "list_folders") return { value: grants.map((g) => ({ ...g })), confirmed, bytes };
      const writable = tool.confirm;
      const filename = await resolve(args.path, writable, name === "write_text" || name === "save_to_laptop");
      const paths = [filename];
      if (name === "move") paths.push(await resolve(args.destination, true, true));
      if (name === "write_text" && Buffer.byteLength(args.text) > TEXT_LIMIT) fail("SIZE_LIMIT", "文本不能超过 1 MB");
      if (writable) {
        check();
        confirmed = await authorized({ tool: name, summary: args.summary }, paths, context);
        // 确认期间可撤销授权或替换目录，操作前必须重新检查。
        await resolve(args.path, true, name === "write_text" || name === "save_to_laptop");
        if (name === "move") await resolve(args.destination, true, true);
      }
      check();
      let value;
      switch (name) {
        case "list_dir": {
          const entries = [];
          let truncated = false;
          let scanned = 0;
          const dir = await fs.opendir(filename);
          for await (const item of dir) {
            if (++scanned > 2000 || entries.length >= 500) { truncated = true; break; }
            const candidate = path.join(filename, item.name);
            try { await resolve(candidate); } catch (error) {
              if (["DENIED", "ENOENT"].includes(error.code)) continue;
              throw error;
            }
            entries.push({ name: item.name, directory: item.isDirectory() });
          }
          value = { entries, truncated };
          break;
        }
        case "search": {
          const results = [];
          let scanned = 0;
          let read = 0;
          let truncated = false;
          const mode = args.mode ?? "both";
          const query = args.query.toLowerCase();
          async function walk(folder, depth) {
            if (depth > 32) { truncated = true; return; }
            const dir = await fs.opendir(folder);
            for await (const item of dir) {
              context.signal?.throwIfAborted();
              if (++scanned > 2000 || results.length >= 100 || read >= 20 * TEXT_LIMIT) { truncated = true; break; }
              const candidate = path.join(folder, item.name);
              try { await resolve(candidate); } catch (error) {
                if (["DENIED", "ENOENT"].includes(error.code)) continue;
                throw error;
              }
              let match = mode !== "text" && item.name.toLowerCase().includes(query);
              if (!match && item.isFile() && mode !== "name") {
                const stat = await fs.stat(candidate);
                if (stat.size <= TEXT_LIMIT && read + stat.size <= 20 * TEXT_LIMIT) {
                  const maximum = Math.min(TEXT_LIMIT, 20 * TEXT_LIMIT - read);
                  read += stat.size;
                  try {
                    const content = await text(candidate, maximum);
                    read += Math.max(0, Buffer.byteLength(content) - stat.size);
                    match = content.toLowerCase().includes(query);
                  } catch (error) {
                    if (!["ERR_ENCODING_INVALID_ENCODED_DATA", "SIZE_LIMIT", "DENIED", "ENOENT"].includes(error.code)) throw error;
                  }
                } else if (stat.size <= TEXT_LIMIT) truncated = true;
              }
              if (match) results.push({ path: candidate, directory: item.isDirectory() });
              if (item.isDirectory()) await walk(candidate, depth + 1);
              if (truncated && (scanned > 2000 || read >= 20 * TEXT_LIMIT || results.length >= 100)) break;
            }
          }
          await walk(filename, 0);
          value = { results, truncated, scanned, bytesRead: read };
          bytes = read;
          break;
        }
        case "read_text": value = await text(filename); bytes = Buffer.byteLength(value); break;
        case "fetch_to_cloud": {
          if (!context.sendFile) fail("UNAVAILABLE", "文件传输尚未连接");
          const file = await readHandle(filename, FILE_LIMIT);
          try { value = await context.sendFile(file.handle, file.size, check); bytes = file.size; } finally { await file.handle.close(); }
          break;
        }
        case "save_to_laptop":
          if (!context.receiveFile) fail("UNAVAILABLE", "文件传输尚未连接");
          bytes = await replace(filename, context.receiveFile, context, check);
          value = { path: filename, bytes };
          break;
        case "write_text":
          bytes = await replace(filename, async (handle) => { await handle.writeFile(args.text, "utf8"); return Buffer.byteLength(args.text); }, context, check);
          value = { path: filename, bytes };
          break;
        case "move": {
          const stat = await fs.lstat(filename);
          if (!stat.isFile()) fail("DENIED", "移动只支持单个普通文件");
          check();
          await fs.link(filename, paths[1]);
          try { await fs.unlink(filename); } catch (error) { throw new HandsError("PARTIAL", "目标文件已创建，但原文件未移除；请在电脑上检查两个文件"); }
          value = { path: paths[1] };
          bytes = stat.size;
          break;
        }
        case "delete":
          if (!(await fs.lstat(filename)).isFile()) fail("DENIED", "废纸篓操作只支持单个普通文件");
          if (!trash) fail("UNAVAILABLE", "废纸篓尚未连接，不会永久删除文件");
          check();
          await trash(filename);
          value = { trashed: true };
          break;
        case "open": {
          const stat = await fs.stat(filename);
          const extension = path.extname(filename).toLowerCase();
          if (!stat.isFile() || (stat.mode & 0o111) || ![".txt", ".md", ".csv", ".json", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) fail("DENIED", "只允许用默认应用打开普通文档或图片，不打开程序或脚本");
          if (!open) fail("UNAVAILABLE", "默认应用尚未连接");
          check();
          await open(filename);
          value = { opened: true };
          break;
        }
        default: fail("INVALID_ARGUMENT", "未知本机工具");
      }
      check();
      return { value, bytes, confirmed };
    } catch (error) {
      if (!(error instanceof HandsError)) {
        const code = error.name === "AbortError" ? "CANCELLED" : "IO";
        error = new HandsError(code, code === "CANCELLED" ? "操作已取消；若已修改文件，请检查本机结果" : "本机文件操作失败，请检查文件权限、占用或磁盘空间");
      }
      error.confirmed = confirmed;
      error.bytes = bytes;
      throw error;
    }
  }
  return { execute, setGrants, clearSessions: () => sessions.clear() };
}
