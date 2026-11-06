// The desktop may only read this explicit public company configuration set; never serve arbitrary paths.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONFIG_FILES = new Set(["plugins.json", "partner.patch.yml", "profile-upgrades.mjs", "plugin-patches.mjs", "market-profile.mjs", "market-npmrc.mjs", "skills/publish-zhaohua-market/SKILL.md"]);

export async function serveCompanyConfig(req, res, pathname, desktopUser, directory = "/opt/partner-config") {
  res.setHeader("cache-control", "no-store");
  if (!desktopUser(req)) { res.writeHead(401); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); return res.end(); }
  const file = pathname.slice("/_zp/config/".length);
  if (!CONFIG_FILES.has(file)) { res.writeHead(404); return res.end(); }
  let bytes;
  try { bytes = await readFile(join(directory, file)); }
  catch (error) {
    console.error("公司配置不可读", file, error.code);
    res.writeHead(503); return res.end();
  }
  res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8", "content-length": bytes.length });
  res.end(req.method === "HEAD" ? undefined : bytes);
}
