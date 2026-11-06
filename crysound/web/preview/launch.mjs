import fs from "node:fs";
import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { createRelay } from "./relay.mjs";
import { RELAY_PORT } from "./policy.mjs";

// The relay shares the workspace lifetime: a failed relay must not silently leave a running workspace.
const relay = createRelay({
  key: fs.readFileSync("/data/.zp-preview-relay-key", "utf8").trim(),
  gatewayAddresses: async () => (await lookup("zhaohua-partner-gateway", { all: true })).map((r) => r.address),
});
await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(RELAY_PORT, "0.0.0.0", resolve); });
const connections = new Set();
relay.on("connection", (socket) => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
const closeRelay = () => { relay.close(); for (const socket of connections) socket.destroy(); };
const child = spawn("dsh", ["--profile", "web", ...process.argv.slice(2)], { stdio: "inherit" });
let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  closeRelay();
  child.kill(signal);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  deadline.unref();
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(signal));
relay.on("error", () => { console.error("Workspace preview relay stopped"); stop(); });
child.on("error", () => { console.error("Workspace runtime failed to start"); closeRelay(); process.exitCode = 1; });
child.on("exit", (code) => { closeRelay(); process.exitCode = code ?? 1; });
