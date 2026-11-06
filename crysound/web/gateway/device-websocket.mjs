import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { CONTROL_LIMIT } from "../../hands/wire.mjs";

const MAX_MESSAGE = CONTROL_LIMIT;
const decoder = new TextDecoder("utf-8", { fatal: true });

function frame(opcode, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const size = body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(size);
  header[0] = 0x80 | opcode;
  if (size === 2) header[1] = body.length;
  else if (size === 4) { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, body]);
}

/**
 * 有界 RFC 6455 服务端；支持掩码、分片、ping/pong、close，拒绝扩展和非法帧。
 * @param req Node Upgrade 请求，认证由调用方先完成。
 * @param socket 已认证的 TCP socket。
 * @param head HTTP 解析器已读取的数据；监听 message 后调用 start。
 * @returns send/close/start 和 message/close 事件；不提供压缩。
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket" ||
    !String(req.headers.connection).toLowerCase().split(/\s*,\s*/).includes("upgrade") ||
    req.headers["sec-websocket-version"] !== "13" || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const events = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmentBytes = 0;
  let closed = false;
  const close = (code = 1000) => {
    if (closed) return;
    closed = true;
    const body = Buffer.alloc(2); body.writeUInt16BE(code);
    socket.end(frame(8, body));
    socket.destroySoon();
    events.emit("close");
  };
  socket.on("error", () => close(1011));
  socket.on("close", () => { if (!closed) { closed = true; events.emit("close"); } });
  function consume(data) {
    if (closed) return;
    buffer = Buffer.concat([buffer, data]);
    try {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const opcode = first & 15;
        const final = !!(first & 128);
        if ((first & 0x70) || !(buffer[1] & 128) || ![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error("Invalid frame");
        const marker = buffer[1] & 127;
        let length = marker;
        let offset = 2;
        if (marker === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2); offset = 4;
          if (length < 126) throw new Error("Noncanonical length");
        } else if (marker === 127) {
          if (buffer.length < 10) return;
          const long = buffer.readBigUInt64BE(2);
          if (long > BigInt(MAX_MESSAGE) || long <= 65535n) throw new Error("Invalid length");
          length = Number(long); offset = 10;
        }
        if (length > MAX_MESSAGE || (opcode >= 8 && (!final || length > 125))) throw new Error("Oversized frame");
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) {
          if (length === 1) throw new Error("Invalid close");
          if (length >= 2) {
            const code = payload.readUInt16BE();
            if (code < 1000 || code >= 5000 || [1004, 1005, 1006, 1015].includes(code) || (code >= 1016 && code < 3000)) throw new Error("Invalid close code");
            decoder.decode(payload.subarray(2));
          }
          close(); return;
        }
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode === 10) continue;
        if ((opcode === 0 && !fragmentOpcode) || (opcode !== 0 && fragmentOpcode)) throw new Error("Invalid continuation");
        if (opcode !== 0) fragmentOpcode = opcode;
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_MESSAGE) throw new Error("Oversized message");
        fragments.push(payload);
        if (final) {
          const message = Buffer.concat(fragments);
          const binary = fragmentOpcode === 2;
          fragments = []; fragmentBytes = 0; fragmentOpcode = 0;
          events.emit("message", binary ? message : decoder.decode(message));
          if (closed) return;
        }
      }
    } catch (error) { close(1002); }
  }
  socket.on("data", consume);
  return Object.assign(events, {
    send(message) {
      if (closed) throw new Error("WebSocket closed");
      const binary = Buffer.isBuffer(message);
      const data = binary ? message : JSON.stringify(message);
      if (Buffer.byteLength(data) > MAX_MESSAGE || socket.writableLength > 4 * MAX_MESSAGE) { close(1009); throw new Error("WebSocket backpressure limit"); }
      socket.write(frame(binary ? 2 : 1, data));
    },
    close,
    start() { if (head.length) consume(head); },
  });
}
