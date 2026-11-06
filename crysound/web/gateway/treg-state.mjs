import fs from "node:fs";
import path from "node:path";

export const tregFailure = (status, message) => Object.assign(new Error(message), { status });
export const dailyMessage = "你今天的数据额度已用完，北京时间每天 08:00 恢复；需要更多请找管理员";
export const monthlyMessage = "你本月的数据额度已用完，北京时间每月 1 日 08:00 恢复；需要更多请找管理员";
export const blockedMessage = "你的数据服务已暂停，请联系管理员";

/** 单网关进程的通知去重；金额与预算均由 Treg 原生账单负责。 */
export function createTregNotices({ dir, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "notices.json");
  return () => {
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(previous.day)) throw new Error("数据通知记录无效");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous?.day === day) return false;
    const temp = target + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ day }) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    return true;
  };
}

/** 美元配置在边界转换成整数微美元；不接受精度更高或负数。 */
export function usdMicro(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("数据额度配置无效");
  const amount = Number(value), micro = Math.round(amount * 1e6);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(micro) || Math.abs(amount * 1e6 - micro) > 1e-7) throw new Error("数据额度配置无效");
  return micro;
}

export function tregLimits(env, overrides = {}) {
  const defaults = { daily: usdMicro(env.TREG_DAILY_USD ?? 1), monthly: usdMicro(env.TREG_MONTHLY_USD ?? 5), call: usdMicro(env.TREG_CALL_MAX_USD ?? 1) };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("个人数据额度配置无效");
  const users = new Map();
  for (const [slug, row] of Object.entries(overrides)) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug) || !row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some((key) => !["dailyUsd", "monthlyUsd", "callMaxUsd"].includes(key))) throw new Error("个人数据额度配置无效");
    users.set(slug, { daily: row.dailyUsd === undefined ? defaults.daily : usdMicro(row.dailyUsd),
      monthly: row.monthlyUsd === undefined ? defaults.monthly : usdMicro(row.monthlyUsd),
      call: row.callMaxUsd === undefined ? defaults.call : usdMicro(row.callMaxUsd) });
  }
  return (slug) => users.get(slug) ?? defaults;
}
