// 打包前仅提取 PUBLIC_HOST；其他部署参数和凭据不会进入桌面资源。
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const [input = fileURLToPath(new URL("../web/.env", import.meta.url)), output = fileURLToPath(new URL("../config/public-host.json", import.meta.url))] = process.argv.slice(2);
let host = process.env.PUBLIC_HOST;
if (host === undefined) {
  try { host = parseEnv(fs.readFileSync(input, "utf8")).PUBLIC_HOST; }
  catch (error) { throw new Error("无法读取部署配置；请配置 crysound/web/.env 的 PUBLIC_HOST 或传入 PUBLIC_HOST"); }
}
if (!host || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) || new URL(`https://${host}`).host !== host.toLowerCase()) {
  throw new Error("PUBLIC_HOST 必须是域名（可带端口），不能包含协议、路径或凭据");
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ PUBLIC_HOST: host.toLowerCase() }, null, 2) + "\n");
console.log("桌面公共域名配置已生成；未复制其他部署参数。");
