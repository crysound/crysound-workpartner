// Host 的公司请求：市场补身份，模型或市场 401 时通知桌面壳重新登录。
import fs from "node:fs";
const base = process.env.CRYSOUND_LLM_BASE;
const marketOrigin = process.env.CRYSOUND_MARKET_ORIGIN || (base ? new URL(base).origin : undefined);
const original = globalThis.fetch;
if (original && (base || marketOrigin)) {
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const market = url.origin === marketOrigin && url.pathname.startsWith("/_zp/market/");
    if (market) {
      const token = process.env.CRYSOUND_MARKET_TOKEN_FILE
        ? fs.readFileSync(process.env.CRYSOUND_MARKET_TOKEN_FILE, "utf8").trim() : process.env.MAGPIE_API_KEY;
      if (!token) throw new Error("市场身份缺失，请重新登录或联系管理员重建容器");
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("authorization", `Bearer ${token}`);
      init = { ...init, headers, redirect: "error" };
    }
    const response = await original.call(this, input, init);
    if (response.status === 401 && (market || (base && url.href.startsWith(base))) && typeof process.send === "function") {
      try { process.send({ type: "crysound-auth-expired" }); } catch (error) { /* IPC 关闭不影响请求结果。 */ }
    }
    return response;
  };
}
