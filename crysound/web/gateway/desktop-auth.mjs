import crypto from "node:crypto";

// Shared by model forwarding and the read-only company configuration route.
export function desktopUser(req, sessionKey, readUsers) {
  const parts = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").split(".");
  const [prefix, data, mac] = parts;
  if (parts.length !== 3 || prefix !== "zpd" || !data || !mac) return null;
  const expected = crypto.createHmac("sha256", sessionKey).update(`zpd.${data}`).digest("base64url");
  const supplied = Buffer.from(mac);
  if (supplied.length !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(supplied, Buffer.from(expected))) return null;
  let token;
  try { token = JSON.parse(Buffer.from(data, "base64url").toString()); }
  catch { return null; } // A malformed credential must never fall through to the web login route.
  return token && typeof token.e === "number" && token.e > Date.now() / 1000 && typeof token.u === "string"
    ? readUsers().find((user) => user.unionId === token.u) ?? null : null;
}
