// 容器自己的 npm 配置，保留其他配置；只写字面令牌。
import fs from "node:fs";
import crypto from "node:crypto";
const [file, tokenFile = "/data/.zp-market-token"] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, "utf8").trim();
if (!file || !token || /[\r\n]/.test(token)) throw new Error("缺少或无效的容器令牌");
const auth = "//zhaohua-partner-gateway:3090/_zp/npm/:_authToken";
const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const lines = previous.split(/\r?\n/).filter((line) => !["@crysound:registry", auth].includes(line.split("=", 1)[0].trim()));
lines.push("@crysound:registry=http://zhaohua-partner-gateway:3090/_zp/npm/", `${auth}=${token}`);
const temp = `${file}.${crypto.randomBytes(12).toString("hex")}`;
try {
  fs.writeFileSync(temp, lines.join("\n").replace(/^\n+|\n+$/g, "") + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
} finally { fs.rmSync(temp, { force: true }); }
