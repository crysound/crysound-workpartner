import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import tools from "../../hands/tools.json" with { type: "json" };
import { createPeer, createTransfers, sendFile, decodeChunk, validateCall, HandsError, HEARTBEAT_MS, CONTROL_LIMIT, VERSION } from "../../hands/wire.mjs";
import { acceptWebSocket } from "./device-websocket.mjs";
import { cloudSource, cloudDestination } from "./device-paths.mjs";

export const OFFLINE_HINT = "电脑未连接，请在你的电脑上打开兆华工作伙伴后重试。";
const normalizedIP = (ip) => ip?.replace(/^::ffff:/, "");
const slugValid = (slug) => typeof slug === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(slug);

/** 只信 TCP 来源，逐次读取 Docker 的运行容器地址；不使用请求头提供的 IP。 */
export function containerLookup(docker, users) {
  return async (ip) => {
    const result = await docker("GET", "/containers/json");
    if (result.status !== 200) throw new Error("Cannot inspect container addresses");
    const containers = JSON.parse(result.body);
    const candidates = containers.filter((item) => item.State === "running" &&
      normalizedIP(item.NetworkSettings?.Networks?.["partner-net"]?.IPAddress) === normalizedIP(ip));
    if (candidates.length !== 1) return null;
    return users().find((user) => slugValid(user.slug) && candidates[0].Names?.includes(`/zhaohua-partner-${user.slug}`)) ?? null;
  };
}

/**
 * 设备中转：认证函数由网关注入；自身不读取任何登录密钥，不启动或停止容器。
 * @param options stateRoot/usersRoot、authenticateDesktop(req)、lookupContainer(ip)；callTimeoutMs 必须小于 MCP 客户端超时。
 * @returns handleHttp/handleUpgrade（只处理设备路径）、close 和 online，供网关与独立测试宿主使用。
 */
export async function createDeviceRelay({ stateRoot = "/state", usersRoot = "/users", authenticateDesktop, lookupContainer, callTimeoutMs = 240_000, heartbeatMs = HEARTBEAT_MS }) {
  await fs.mkdir(path.join(stateRoot, "devices"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(stateRoot, "device-audit"), { recursive: true, mode: 0o700 });
  const policyFile = path.join(stateRoot, "devices-policy.json");
  try { await fs.writeFile(policyFile, '{"disabled":false,"disabledUsers":[]}\n', { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const devices = new Map();
  const negotiating = new Map();
  const connections = new Set();
  const calls = new Map();
  const tasks = new Set();
  const registryWrites = new Map();
  let order = 0;
  let closing = false;

  async function persist(user, device) {
    const task = (registryWrites.get(user.slug) ?? Promise.resolve()).catch((error) => {
      console.error("上次设备登记失败；将重试写入，请检查状态目录");
    }).then(async () => {
      const file = path.join(stateRoot, "devices", `${user.slug}.json`);
      let prior;
      try { prior = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const now = new Date().toISOString();
      const data = { id: device.id, name: device.name, os: device.os, appVersion: device.appVersion, firstSeen: prior?.id === device.id ? prior.firstSeen : now, lastSeen: now };
      const temp = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(data) + "\n", { mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }); }
    });
    registryWrites.set(user.slug, task);
    return task;
  }

  async function policy(slug) {
    let value;
    try { value = JSON.parse(await fs.readFile(policyFile, "utf8")); }
    catch (error) { throw new HandsError("POLICY_INVALID", "本机访问策略无法读取，请联系管理员"); }
    if (!value || typeof value.disabled !== "boolean" || !Array.isArray(value.disabledUsers) || value.disabledUsers.some((s) => !slugValid(s))) throw new HandsError("POLICY_INVALID", "本机访问策略无效，请联系管理员");
    if (value.disabled || value.disabledUsers.includes(slug)) throw new HandsError("POLICY_DISABLED", "管理员已关闭本机访问，请联系管理员");
  }

  async function audit(user, device, tool, args, outcome, confirmed, bytes) {
    const paths = [args?.path, args?.destination, args?.cloud_path].filter((p) => typeof p === "string").map((p) => p.slice(0, 4096));
    const record = { time: new Date().toISOString(), user: user.slug, device: device?.id ?? null, tool: typeof tool === "string" ? tool.slice(0, 100) : "invalid", paths, bytes, outcome, confirmed };
    await fs.appendFile(path.join(stateRoot, "device-audit", `${user.slug}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  async function invoke(user, name, args, signal, rpcId) {
    const device = devices.get(user.slug);
    let result;
    let outcome = "ok";
    let pending;
    let source;
    let destination;
    try {
      validateCall(tools, name, args);
      await policy(user.slug);
      if (!device?.ready) throw new HandsError("OFFLINE", OFFLINE_HINT);
      if (device.pending || calls.has(user.slug)) throw new HandsError("BUSY", "电脑正在处理另一个操作，请稍后再试");
      const id = randomUUID();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      let resolve;
      let reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      // 提前安装拒绝处理；文件准备失败时 done 仍由 finally 清理。
      done.catch(() => {});
      pending = { id, rpcId, tool: name, controller, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort), confirmed: null, bytes: 0 };
      device.pending = pending;
      calls.set(user.slug, pending);
      pending.timer = setTimeout(() => controller.abort(), callTimeoutMs);
      controller.signal.addEventListener("abort", () => {
        try { device.peer.send({ type: "cancel", id }); } catch (error) { /* 断线已由 close 处理。 */ }
        reject(new HandsError("CANCELLED", "本机操作超时或已取消，结果可能未知；请检查目标文件后重试"));
      }, { once: true });
      if (controller.signal.aborted) throw new HandsError("CANCELLED", "操作已取消");
      if (name === "save_to_laptop") {
        source = await cloudSource(usersRoot, user.slug, args.cloud_path);
        pending.source = source;
      }
      if (name === "fetch_to_cloud") {
        destination = await cloudDestination(usersRoot, user.slug, args.path);
        pending.receiving = device.transfers.receive(id, destination.handle, controller.signal);
        pending.receiving.catch((error) => reject(error));
      }
      device.peer.send({ type: "call", id, tool: name, arguments: args, source: "兆华工作伙伴（云端）" });
      const reply = await done;
      if (name === "fetch_to_cloud") {
        const bytes = await pending.receiving;
        await destination.commit();
        result = { value: { path: destination.cloudPath, bytes }, bytes, confirmed: false };
      } else result = reply;
    } catch (error) {
      outcome = error instanceof HandsError ? error.code : "RELAY_ERROR";
      result = { isError: true, value: error instanceof HandsError ? error.message : "本机中转失败，请检查连接或联系管理员；如操作已开始，请检查目标文件", confirmed: pending ? pending.confirmed : false, bytes: pending?.bytes || 0 };
    } finally {
      if (pending) {
        device.retired.add(pending.id);
        if (device.retired.size > 100) device.retired.delete(device.retired.values().next().value);
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.controller.abort();
        if (device.pending === pending) device.pending = undefined;
        if (calls.get(user.slug) === pending) calls.delete(user.slug);
      }
      if (pending?.sending) await pending.sending.catch((error) => { /* 已由 invoke 报告，关闭文件前等发送方退出。 */ });
      try { await source?.handle.close(); await destination?.cleanup(); }
      catch (error) {
        outcome = "CLEANUP_FAILED";
        result = { isError: true, value: "文件清理失败，操作可能已生效；请检查目标文件并联系管理员清理临时文件", confirmed: result?.confirmed ?? null, bytes: result?.bytes || 0 };
        console.error("本机传输文件清理失败；请检查工作区权限与磁盘空间");
      }
    }
    try { await audit(user, device, name, args, outcome, result.confirmed, result.bytes); } catch (error) {
      console.error("本机操作审计写入失败；请检查状态目录权限与磁盘空间");
      return { isError: true, content: [{ type: "text", text: "操作审计保存失败，操作结果可能已生效；请检查目标文件并联系管理员" }] };
    }
    return { isError: result.isError === true, content: [{ type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value) }] };
  }

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  async function handleHttp(req, res) {
    if (new URL(req.url, "http://gateway").pathname !== "/_zp/device-mcp") return false;
    try {
      // 公网代理即便恰好位于 Docker 网络也不可借此入口；请求头不能充当容器身份。
      if (Object.keys(req.headers).some((h) => h === "origin" || h === "forwarded" || h.startsWith("x-forwarded-") || h.startsWith("cf-") || h === "x-real-ip")) { json(res, 403, { error: "仅限容器内部访问" }); return true; }
      const user = await lookupContainer(normalizedIP(req.socket.remoteAddress));
      if (!user || !slugValid(user.slug)) { json(res, 403, { error: "仅限容器内部访问" }); return true; }
      if (req.method !== "POST") { res.setHeader("allow", "POST"); json(res, 405, { error: "Method not allowed" }); return true; }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > CONTROL_LIMIT) { json(res, 413, { error: "请求过大" }); return true; }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString()); } catch (error) { json(res, 400, { error: "Invalid JSON" }); return true; }
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
          (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) { json(res, 400, { error: "Invalid JSON-RPC" }); return true; }
      if (message.method === "notifications/cancelled") {
        const call = calls.get(user.slug);
        if (call && call.rpcId === message.params?.requestId) call.controller.abort();
        json(res, 202); return true;
      }
      if (message.id === undefined) { json(res, 202); return true; }
      const reply = (result) => json(res, 200, { jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "initialize": {
          const requested = message.params?.protocolVersion;
          const supported = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
          reply({ protocolVersion: supported.includes(requested) ? requested : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "crysound-laptop", version: "1.0.0" } });
          break;
        }
        case "ping": reply({}); break;
        case "tools/list": reply({ tools: tools.map(({ confirm, ...tool }) => ({ ...tool, annotations: { readOnlyHint: !confirm && tool.name !== "fetch_to_cloud" && tool.name !== "open", destructiveHint: confirm, openWorldHint: true } })) }); break;
        case "tools/call": {
          const controller = new AbortController();
          const closed = () => { if (!res.writableEnded) controller.abort(); };
          res.on("close", closed);
          const task = invoke(user, message.params?.name, message.params?.arguments ?? {}, controller.signal, message.id);
          tasks.add(task);
          try { reply(await task); }
          finally { tasks.delete(task); res.removeListener("close", closed); }
          break;
        }
        default: json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    } catch (error) {
      if (!res.headersSent) json(res, 503, { error: "设备入口暂不可用，请联系管理员" });
      else res.end();
    }
    return true;
  }

  async function handleUpgrade(req, socket, head) {
    if (new URL(req.url, "http://gateway").pathname !== "/_zp/device") return false;
    if (closing) { socket.destroy(); return true; }
    let user;
    try { user = await authenticateDesktop(req); } catch (error) { user = null; }
    if (!user || !slugValid(user.slug)) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return true; }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return true;
    const device = { ws, ready: false, order: ++order, lastSeen: Date.now(), retired: new Set() };
    connections.add(device);
    negotiating.get(user.slug)?.ws.close(4001);
    negotiating.set(user.slug, device);
    const peer = device.peer = createPeer((message) => ws.send(message));
    const transfers = device.transfers = createTransfers(peer);
    let queue = Promise.resolve();
    const helloTimer = setTimeout(() => { if (!device.ready) ws.close(1008); }, 10_000);
    const heartbeat = setInterval(() => {
      if (Date.now() - device.lastSeen > heartbeatMs * 3) { ws.close(1001); return; }
      try { peer.send({ type: "heartbeat", at: Date.now() }); } catch (error) { ws.close(1011); }
    }, heartbeatMs);
    ws.on("close", () => {
      clearTimeout(helloTimer); clearInterval(heartbeat);
      peer.close(); transfers.close(new HandsError("OFFLINE", "电脑连接已断开；结果可能未知，请检查目标文件"));
      device.pending?.reject(new HandsError("OFFLINE", "电脑连接已断开；操作结果可能未知，请检查目标文件"));
      device.pending?.controller.abort();
      if (devices.get(user.slug) === device) devices.delete(user.slug);
      if (negotiating.get(user.slug) === device) negotiating.delete(user.slug);
      connections.delete(device);
    });
    ws.on("message", (raw) => {
      try {
        const message = Buffer.isBuffer(raw) ? raw : JSON.parse(raw);
        device.lastSeen = Date.now();
        if (!Buffer.isBuffer(message) && peer.accept(message)) return;
        queue = queue.then(async () => {
          const requestId = Buffer.isBuffer(message) ? decodeChunk(message).id : message.id;
          if (device.retired.has(requestId)) return;
          if (!device.ready) {
            if (message.type !== "hello" || message.version !== VERSION ||
                ![message.id, message.name, message.os, message.appVersion].every((x) => typeof x === "string" && x.length > 0 && x.length <= 128 && !/[\x00-\x1f]/.test(x))) throw new Error("Invalid hello");
            const older = devices.get(user.slug);
            if (older && older.order > device.order) { ws.close(4001); return; }
            Object.assign(device, { id: message.id, name: message.name, os: message.os, appVersion: message.appVersion });
            devices.set(user.slug, device);
            older?.ws.close(4001);
            await persist(user, device);
            if (devices.get(user.slug) !== device) return;
            device.ready = true; clearTimeout(helloTimer);
            if (negotiating.get(user.slug) === device) negotiating.delete(user.slug);
            peer.send({ type: "hello", version: VERSION });
            return;
          }
          if (message.type === "heartbeat") { await persist(user, device); return; }
          if (await transfers.accept(message)) return;
          const pending = device.pending;
          if (!pending || message.id !== pending.id) throw new Error("Unknown request id");
          if (message.type === "receive_ready") {
            if (!pending.source || pending.sending) throw new Error("Unexpected transfer");
            pending.sending = sendFile(peer, pending.id, pending.source.handle, pending.source.size, pending.controller.signal);
            pending.sending.catch((error) => pending.reject(error));
          } else if (message.type === "result" || message.type === "error") {
            if (typeof message.confirmed !== "boolean" || !Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > 200 * 1024 * 1024) throw new Error("Invalid result");
            pending.confirmed = message.confirmed; pending.bytes = message.bytes;
            if (message.type === "error") {
              if (typeof message.code !== "string" || typeof message.message !== "string") throw new Error("Invalid error");
              pending.reject(new HandsError(message.code, message.message));
            } else {
              if (tools.find((tool) => tool.name === pending.tool).confirm && !message.confirmed) throw new Error("Missing confirmation");
              if (pending.source) {
                if (!pending.sending) throw new Error("Missing transfer");
                await pending.sending;
              }
              pending.resolve({ value: message.value, bytes: message.bytes, confirmed: message.confirmed });
            }
          } else throw new Error("Invalid device message");
        });
        queue.catch(() => ws.close(1002));
      } catch (error) { ws.close(1002); }
    });
    ws.start();
    return true;
  }
  return {
    handleHttp, handleUpgrade,
    online: (slug) => devices.get(slug)?.ready === true,
    async close() {
      closing = true;
      for (const device of connections) device.ws.close(1001);
      await Promise.allSettled([...tasks, ...registryWrites.values()]);
    },
  };
}
