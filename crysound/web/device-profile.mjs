import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const DEVICE_ROW_ID = "crysound-laptop-mcp";
const row = `- insert:
    - id: ${DEVICE_ROW_ID}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: laptop
        transport: streamable-http
        url: http://zhaohua-partner-gateway:3090/_zp/device-mcp
        headers: {}
        toolCallTimeoutMs: 300000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 1000
          maxDelayMs: 30000
          maxAttempts: 10
`;

/** 仅由 Web entrypoint 调用；保留用户已有同 id 行（包括主动 disabled），原子写回。 */
export async function mergeDeviceProfile(filename) {
  let text;
  try { text = await fs.readFile(filename, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; text = ""; }
  const pattern = new RegExp(`^\\s*-\\s+id:\\s*["']?${DEVICE_ROW_ID}["']?\\s*(?:#.*)?$`, "m");
  if (pattern.test(text)) return false;
  const next = text.replace(/^\[\]\s*$/m, "").replace(/\s*$/, "\n") + row;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, next, { mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node device-profile.mjs <web cordis.patch.yml>");
  await mergeDeviceProfile(process.argv[2]);
}
