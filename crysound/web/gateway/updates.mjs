/** Read-only Mac update feed; desktop passports are required even for metadata and HEAD. */
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Serve a single update file without redirects, directory listing, or browser-session authentication. */
export async function serveMacUpdate(req, res, pathname, desktopUser, directory = "/downloads/updates/mac") {
  res.setHeader("cache-control", "no-store");
  if (!desktopUser(req)) { res.writeHead(401); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); return res.end(); }
  const name = pathname.slice("/_zp/updates/mac/".length);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) { res.writeHead(404); return res.end(); }
  let file;
  try {
    file = await open(join(directory, name), "r");
    const info = await file.stat();
    if (!info.isFile()) { await file.close(); res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "content-type": name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
      "content-length": info.size,
      "cache-control": name === "latest-mac.yml" ? "no-cache" : "no-store",
    });
    if (req.method === "HEAD") { await file.close(); return res.end(); }
    const stream = file.createReadStream();
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (file) await file.close();
    if (res.headersSent) return res.destroy();
    res.writeHead(error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 503);
    res.end();
  }
}
