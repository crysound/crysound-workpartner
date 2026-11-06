import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { acceptWebSocket } from "../../web/gateway/device-websocket.mjs";
import { sendFile, CONTROL_LIMIT } from "../wire.mjs";

function masked(opcode, final, payload) {
  assert(payload.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([(final ? 128 : 0) | opcode, 128 | payload.length]), mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}

async function fixture(t) {
  const messages = [];
  const peers = new Set();
  const message = Promise.withResolvers();
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    peers.add(ws); ws.on("close", () => peers.delete(ws));
    ws.on("message", (value) => { messages.push(value); message.resolve(value); }); ws.start();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const socket = net.connect(server.address().port, "127.0.0.1");
  t.after(async () => { socket.destroy(); for (const peer of peers) peer.close(); await new Promise((resolve) => server.close(resolve)); });
  await once(socket, "connect");
  const response = once(socket, "data");
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n");
  assert.match((await response)[0].toString(), /101 Switching Protocols/);
  return { socket, messages, message: message.promise };
}

test("RFC 6455 分片在完整 UTF-8 消息后解码，分片间仍处理 ping", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const utf8 = Buffer.from("你好");
  const pong = once(f.socket, "data");
  f.socket.write(Buffer.concat([masked(1, false, utf8.subarray(0, 1)), masked(9, true, Buffer.alloc(0)), masked(0, true, utf8.subarray(1))]));
  assert.equal(await f.message, "你好");
  assert.deepEqual((await pong)[0], Buffer.from([0x8a, 0]));
});

test("无掩码、非法续帧、控制帧分片、扩展位与超长帧都关闭连接", { timeout: 10_000 }, async (t) => {
  const cases = [
    ["unmasked", Buffer.from([0x81, 1, 65])],
    ["continuation", masked(0, true, Buffer.from("x"))],
    ["control", masked(9, false, Buffer.alloc(0))],
    ["reserved", Buffer.from([0xc1, 0x80, 0, 0, 0, 0])],
    ["utf8", masked(1, true, Buffer.from([255]))],
    ["close", masked(8, true, Buffer.from([0]))],
    ["length", (() => { const frame = Buffer.alloc(10); frame[0] = 0x82; frame[1] = 0xff; frame.writeBigUInt64BE(BigInt(CONTROL_LIMIT + 1), 2); return frame; })()],
  ];
  for (const [name, packet] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const response = once(f.socket, "data");
      f.socket.write(packet);
      const [frame] = await response;
      assert.equal(frame[0], 0x88); assert.equal(frame.readUInt16BE(2), 1002); assert.deepEqual(f.messages, []);
    });
  }
});

test("文件在传输途中被改动时不发送完成消息，接收端不能提交文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hands-source-change-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "source.txt");
  await fs.writeFile(filename, "original");
  const handle = await fs.open(filename, "r"); t.after(() => handle.close());
  const messages = [];
  const peer = { exchange: async (message) => { messages.push(message); if (Buffer.isBuffer(message)) await fs.appendFile(filename, "changed"); } };
  await assert.rejects(sendFile(peer, "source-change", handle, 8), (error) => error.code === "FILE_CHANGED");
  assert(!messages.some((message) => message.type === "transfer_end"));
});
