import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HandsError, FILE_LIMIT } from "../../hands/wire.mjs";
import { sensitivePath } from "../../hands/paths.mjs";

const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const deny = () => { throw new HandsError("DENIED", "云端路径必须位于本人的 /data 内，且不能经过链接"); };

/** 云端文件只通过规范用户根目录访问；所有现有路径分量均拒绝符号链接。 */
export async function cloudPath(usersRoot, slug, relative, { mkdir = false } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(slug) || path.isAbsolute(relative)) deny();
  const base = path.resolve(usersRoot, slug);
  const target = path.resolve(base, relative);
  if (!inside(base, target) || await fs.realpath(base) !== base) deny();
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code !== "ENOENT" || !mkdir) throw error;
      await fs.mkdir(current, { mode: 0o700 });
      await fs.chown(current, 1001, 1001);
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) deny();
    if (!inside(base, await fs.realpath(current))) deny();
  }
  return target;
}

/** 读取 /data 内的普通文件，拒绝超限、链接和多硬链接文件。 */
export async function cloudSource(usersRoot, slug, value) {
  if (typeof value !== "string" || !value.startsWith("/data/") || sensitivePath(value)) deny();
  const filename = await cloudPath(usersRoot, slug, value.slice(6));
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) deny();
    if (stat.size > FILE_LIMIT) throw new HandsError("SIZE_LIMIT", "文件不能超过 200 MB");
    return { handle, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

/** 先写独占临时文件，校验完成后发布；只有成功发布的文件会出现在工作区。 */
export async function cloudDestination(usersRoot, slug, localName) {
  const relative = "work/来自本机";
  const folder = await cloudPath(usersRoot, slug, relative, { mkdir: true });
  const originalName = path.basename(localName.replaceAll("\\", "/")).replace(/[\x00-\x1f/:]/g, "_");
  let name = "";
  for (const character of originalName) { if (Buffer.byteLength(name + character) > 160) break; name += character; }
  if (!name) name = "本机文件";
  const destination = path.join(folder, `${randomUUID()}-${name}`);
  const temporary = path.join(folder, `.zp-${randomUUID()}.part`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.chown(1001, 1001); }
  catch (error) { await handle.close(); await fs.rm(temporary, { force: true }); throw error; }
  return {
    handle,
    cloudPath: `/data/${relative}/${path.basename(destination)}`,
    async commit() {
      await handle.sync();
      await handle.close();
      await cloudPath(usersRoot, slug, relative);
      await fs.link(temporary, destination);
      await fs.unlink(temporary);
    },
    async cleanup() { await handle.close(); await fs.rm(temporary, { force: true }); },
  };
}
