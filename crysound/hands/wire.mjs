import { createHash } from "node:crypto";

export const VERSION = 1;
export const TEXT_LIMIT = 1024 * 1024;
export const FILE_LIMIT = 200 * 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
export const HEARTBEAT_MS = 30_000;
export const CONTROL_LIMIT = 8 * 1024 * 1024;

/** 带稳定错误码的工具失败；message 可直接向同事显示。 */
export class HandsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 验证注册表使用的封闭 JSON Schema 子集，拒绝未知工具和额外参数。 */
export function validateCall(tools, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) throw new HandsError("INVALID_ARGUMENT", "本机工具或参数无效");
  const schema = tool.inputSchema;
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) throw new HandsError("INVALID_ARGUMENT", `缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule || typeof value !== rule.type || value.includes("\0") ||
      (rule.minLength !== undefined && value.length < rule.minLength) ||
      (rule.maxLength !== undefined && value.length > rule.maxLength) ||
      (rule.enum && !rule.enum.includes(value))) throw new HandsError("INVALID_ARGUMENT", `参数无效：${key}`);
  }
  return tool;
}

/** 二进制消息：4 字节大端头长度、JSON {id,seq}、不超过 64 KiB 的文件块。 */
export function encodeChunk(id, seq, data) {
  const header = Buffer.from(JSON.stringify({ id, seq }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, data]);
}

/** 解码一条有界二进制消息；传输顺序和总大小由接收方验证。 */
export function decodeChunk(buffer) {
  if (buffer.length < 4) throw new HandsError("PROTOCOL", "文件分块无效");
  const length = buffer.readUInt32BE(0);
  if (length > 256 || length < 1 || buffer.length < 4 + length || buffer.length > 4 + length + CHUNK_SIZE) throw new HandsError("PROTOCOL", "文件分块无效");
  const header = JSON.parse(buffer.subarray(4, 4 + length).toString());
  if (typeof header.id !== "string" || !Number.isSafeInteger(header.seq) || header.seq < 0) throw new HandsError("PROTOCOL", "文件分块头无效");
  return { ...header, data: buffer.subarray(4 + length) };
}

/** 每块等待确认，避免慢磁盘或慢网络把整个文件排进内存。 */
export async function sendFile(peer, id, handle, size, signal, check = () => {}) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new HandsError("SIZE_LIMIT", "文件不能超过 200 MB");
  const initial = await handle.stat();
  if (initial.size !== size) throw new HandsError("FILE_CHANGED", "文件在传输前发生变化，请重试");
  const hash = createHash("sha256");
  await peer.exchange({ type: "transfer", id, size }, "ready", signal);
  let offset = 0;
  let seq = 0;
  while (offset < size) {
    check();
    signal?.throwIfAborted();
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new HandsError("FILE_CHANGED", "文件在传输时发生变化，请重试");
    hash.update(buffer);
    await peer.exchange(encodeChunk(id, seq, buffer), "ack", signal, id, seq);
    offset += bytesRead;
    seq++;
  }
  const final = await handle.stat();
  if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new HandsError("FILE_CHANGED", "文件在传输时发生变化，请重试");
  check();
  await peer.exchange({ type: "transfer_end", id, sha256: hash.digest("hex") }, "received", signal);
  return size;
}

/** 有序磁盘接收器；只有大小和校验值都一致才确认完成。 */
export function fileReceiver(handle, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new HandsError("SIZE_LIMIT", "文件不能超过 200 MB");
  const hash = createHash("sha256");
  let bytes = 0;
  let seq = 0;
  return {
    async chunk(chunk) {
      if (chunk.seq !== seq || chunk.data.length === 0 || bytes + chunk.data.length > size) throw new HandsError("PROTOCOL", "文件分块顺序或大小无效");
      let written = 0;
      while (written < chunk.data.length) {
        const result = await handle.write(chunk.data, written, chunk.data.length - written, bytes + written);
        if (!result.bytesWritten) throw new HandsError("IO", "文件写入中断");
        written += result.bytesWritten;
      }
      hash.update(chunk.data);
      bytes += chunk.data.length;
      seq++;
    },
    finish(digest) {
      if (bytes !== size || digest !== hash.digest("hex")) throw new HandsError("PROTOCOL", "文件大小或校验值不符");
      return bytes;
    },
  };
}

/** 双向传输确认的生命周期；断线、取消或超时都会终止等待，不自动重放写操作。 */
export function createPeer(send, timeoutMs = 30_000) {
  const waits = new Map();
  return {
    send,
    accept(message) {
      const key = `${message.id}:${message.type}:${message.seq ?? ""}`;
      const waiting = waits.get(key);
      if (!waiting) return false;
      waiting.resolve(message);
      return true;
    },
    exchange(message, type, signal, id = message.id, seq) {
      const key = `${id}:${type}:${seq ?? ""}`;
      return new Promise((resolve, reject) => {
        if (waits.has(key)) return reject(new HandsError("PROTOCOL", "重复的传输等待"));
        const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); waits.delete(key); };
        const fail = (error) => { clean(); reject(error); };
        const abort = () => fail(new HandsError("CANCELLED", "操作已取消；如已提交修改，请检查目标文件"));
        const timer = setTimeout(() => fail(new HandsError("TIMEOUT", "文件传输超时；请检查电脑连接")), timeoutMs);
        waits.set(key, { resolve: (value) => { clean(); resolve(value); }, reject: fail });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) return abort();
        try { send(message); } catch (error) { fail(error); }
      });
    },
    close(error = new HandsError("OFFLINE", "连接已断开；操作结果可能未知，请检查目标文件")) {
      for (const waiting of [...waits.values()]) waiting.reject(error);
    },
  };
}

/** 每个连接拥有接收状态；调用者负责临时文件、提交和取消后的清理。 */
export function createTransfers(peer) {
  const receivers = new Map();
  return {
    receive(id, handle, signal) {
      return new Promise((resolve, reject) => {
        if (receivers.has(id)) return reject(new HandsError("PROTOCOL", "重复文件接收"));
        const abort = () => fail(new HandsError("CANCELLED", "文件接收已取消"));
        const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); receivers.delete(id); };
        const fail = (error) => { clean(); reject(error); };
        const timer = setTimeout(() => fail(new HandsError("TIMEOUT", "文件接收超时")), 240_000);
        receivers.set(id, { handle, receiver: null, fail, done: (bytes) => { clean(); resolve(bytes); } });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    async accept(message) {
      const binary = Buffer.isBuffer(message);
      const chunk = binary ? decodeChunk(message) : message;
      if (!binary && !["transfer", "transfer_end"].includes(message.type)) return false;
      const state = receivers.get(chunk.id);
      if (!state) throw new HandsError("PROTOCOL", "没有对应的文件接收请求");
      try {
        if (binary) {
          if (!state.receiver) throw new HandsError("PROTOCOL", "文件传输尚未开始");
          await state.receiver.chunk(chunk);
          peer.send({ type: "ack", id: chunk.id, seq: chunk.seq });
        } else if (message.type === "transfer") {
          if (state.receiver) throw new HandsError("PROTOCOL", "文件传输重复开始");
          state.receiver = fileReceiver(state.handle, message.size);
          peer.send({ type: "ready", id: message.id });
        } else {
          if (!state.receiver) throw new HandsError("PROTOCOL", "文件传输尚未开始");
          const bytes = state.receiver.finish(message.sha256);
          peer.send({ type: "received", id: message.id });
          state.done(bytes);
        }
      } catch (error) { state.fail(error); throw error; }
      return true;
    },
    close(error) { for (const receiver of [...receivers.values()]) receiver.fail(error); },
  };
}
