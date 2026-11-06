import { createPeer, createTransfers, sendFile, VERSION, HEARTBEAT_MS, CONTROL_LIMIT, HandsError } from "../../../../../crysound/hands/wire.mjs";

/**
 * 主动出站的本机客户端；生产使用 ws 发送 Authorization。测试可注入全局 WebSocket。
 * @param options url/token/device/core 必填；createSocket(url,{headers}) 可注入，默认动态加载 ws；onStatus 不含凭证；sessionForCall 仅接可信宿主会话，默认逐次确认。
 * @returns start/stop；stop 等待在途操作清理。断线不重放操作，重连只恢复新调用。
 */
export function createHandsClient({ url, token, device, core, createSocket, onStatus = () => {}, sessionForCall = () => undefined, heartbeatMs = HEARTBEAT_MS, reconnectMs = 500, maxReconnectMs = 30_000 }) {
  const endpoint = new URL(url);
  if (endpoint.pathname !== "/_zp/device" || !["wss:", "ws:"].includes(endpoint.protocol) ||
      (endpoint.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw new Error("Hands requires wss (ws is only allowed on loopback)");
  let stopped = true;
  let connecting;
  let socket;
  let retry;
  let heartbeat;
  let attempt = 0;
  let generation = 0;
  let operation;
  let activeController;

  async function connect() {
    const epoch = ++generation;
    try {
      const factory = createSocket ?? (async (address, options) => {
        const { default: WebSocket } = await import("ws");
        return new WebSocket(address, { ...options, maxPayload: CONTROL_LIMIT, perMessageDeflate: false, handshakeTimeout: 10_000 });
      });
      const current = await factory(url, { headers: { Authorization: `Bearer ${token}` } });
      current.addEventListener("error", () => onStatus("connection-error"));
      if (stopped || epoch !== generation) { current.close(); return; }
      socket = current;
      current.binaryType = "arraybuffer";
      let lastSeen = Date.now();
      let ready = false;
      let active;
      let activeOperation;
      let inbound = Promise.resolve();
      const peer = createPeer((message) => {
        if (current.readyState !== 1) throw new HandsError("OFFLINE", "电脑连接已断开");
        current.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
      });
      const transfers = createTransfers(peer);
      const opened = () => {
        peer.send({ type: "hello", version: VERSION, ...device });
        heartbeat = setInterval(() => {
          if (Date.now() - lastSeen > heartbeatMs * 3) { current.close(); return; }
          try { peer.send({ type: "heartbeat", at: Date.now() }); } catch (error) { current.close(); }
        }, heartbeatMs);
      };
      current.addEventListener("open", opened);
      current.addEventListener("close", (event) => {
        clearInterval(heartbeat);
        peer.close();
        transfers.close(new HandsError("OFFLINE", "电脑连接已断开"));
        active?.controller.abort();
        core.clearSessions();
        if (socket === current) socket = undefined;
        onStatus("offline");
        if (event.code === 4001) onStatus("superseded");
        else {
          Promise.resolve(activeOperation).catch((error) => { /* 已由调用路径报告；重连必须等待旧操作清理。 */ }).then(() => {
            if (!stopped && epoch === generation) schedule();
          });
        }
      });
      current.addEventListener("message", (event) => {
        try {
          lastSeen = Date.now();
          const message = typeof event.data === "string" ? JSON.parse(event.data) : Buffer.from(event.data);
          if (!Buffer.isBuffer(message)) {
            if (message.type === "hello") {
              if (message.version !== VERSION) throw new HandsError("PROTOCOL", "本机协议版本不一致");
              ready = true; attempt = 0; onStatus("online"); return;
            }
            if (message.type === "heartbeat") return;
            if (peer.accept(message)) return;
            if (message.type === "cancel") { if (active?.id === message.id) active.controller.abort(); return; }
            if (message.type === "call") {
              if (!ready || typeof message.id !== "string" || message.id.length > 64) throw new HandsError("PROTOCOL", "调用无效");
              if (active) { peer.send({ type: "error", id: message.id, code: "BUSY", message: "电脑正在处理另一个操作，请稍后再试", confirmed: false, bytes: 0 }); return; }
              const controller = new AbortController();
              activeController = controller;
              active = { id: message.id, controller };
              const run = async () => {
                try {
                  const result = await core.execute(message.tool, message.arguments, {
                    signal: controller.signal,
                    source: message.source,
                    sessionId: sessionForCall(message),
                    sendFile: async (handle, size, check) => {
                      await sendFile(peer, message.id, handle, size, controller.signal, check);
                      return { transferred: true, bytes: size };
                    },
                    receiveFile: async (handle) => {
                      const receiving = transfers.receive(message.id, handle, controller.signal);
                      try { peer.send({ type: "receive_ready", id: message.id }); }
                      catch (error) { controller.abort(); await receiving.catch((failure) => { /* 中止已清理接收器，原始发送错误由调用路径报告。 */ }); throw error; }
                      return receiving;
                    },
                  });
                  peer.send({ type: "result", id: message.id, ...result });
                } catch (error) {
                  if (current.readyState === 1) peer.send({ type: "error", id: message.id, code: error.code || "IO", message: error.message, confirmed: error.confirmed === true, bytes: error.bytes || 0 });
                } finally { active = undefined; if (activeController === controller) activeController = undefined; }
              };
              operation = run();
              activeOperation = operation;
              operation.catch(() => current.close());
              return;
            }
          }
          inbound = inbound.then(() => transfers.accept(message));
          inbound.catch(() => current.close());
        } catch (error) { onStatus("protocol-error"); current.close(); }
      });
    } catch (error) {
      onStatus("connection-error");
      if (!stopped && epoch === generation) schedule();
    }
  }
  function schedule() {
    clearTimeout(retry);
    const delay = Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(attempt++, 10));
    retry = setTimeout(() => { connecting = connect(); }, delay);
  }
  return {
    start() { if (!stopped) return; stopped = false; connecting = connect(); },
    async stop() {
      stopped = true; generation++;
      clearTimeout(retry); clearInterval(heartbeat);
      activeController?.abort();
      socket?.close();
      await connecting;
      await operation;
      core.clearSessions();
    },
  };
}
