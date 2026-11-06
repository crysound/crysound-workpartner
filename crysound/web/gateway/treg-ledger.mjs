import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const beijingDay = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
export const tregFailure = (status, message) => Object.assign(new Error(message), { status });
export const dailyMessage = "你今天的数据额度已用完，明天恢复；需要更多请找管理员";
export const monthlyMessage = "你本月的数据额度已用完，下月恢复；需要更多请找管理员";

/** 单个网关进程独占账本；同步预留和原子落盘在任何网络请求之前完成。 */
export function createTregLedger({ dir, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const load = (month) => {
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(dir, `${month}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { format: 1, entries: [], notices: [] }; throw error; }
    if (value?.format !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.notices)
      || !value.notices.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))) throw new Error("数据账本无效");
    const ids = new Set();
    for (const row of value.entries) {
      if (typeof row.id !== "string" || ids.has(row.id) || typeof row.user !== "string" || typeof row.path !== "string"
        || !Number.isFinite(Date.parse(row.time)) || beijingDay(Date.parse(row.time)).slice(0, 7) !== month
        || !Number.isSafeInteger(row.reservedMicro) || row.reservedMicro < 0
        || !(row.actualMicro === null || (Number.isSafeInteger(row.actualMicro) && row.actualMicro >= 0))) throw new Error("数据账目无效");
      ids.add(row.id);
    }
    return value;
  };
  const save = (month, value) => {
    const target = path.join(dir, `${month}.json`), temp = `${target}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    const directory = fs.openSync(dir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  const totals = (state, user, day) => state.entries.reduce((sum, row) => {
    if (row.user === user) {
      const cost = row.actualMicro ?? row.reservedMicro;
      sum.month += cost;
      if (beijingDay(Date.parse(row.time)) === day) sum.day += cost;
      if (!Number.isSafeInteger(sum.month)) throw new Error("数据账本金额溢出");
    }
    return sum;
  }, { day: 0, month: 0 });
  return {
    usage(user, limits) {
      const day = beijingDay(now()), used = totals(load(day.slice(0, 7)), user, day);
      return { timezone: "Asia/Shanghai", date: day, month: day.slice(0, 7),
        daily: { usedUsd: used.day / 1e6, limitUsd: limits.daily / 1e6 },
        monthly: { usedUsd: used.month / 1e6, limitUsd: limits.monthly / 1e6 } };
    },
    reserve(user, requestPath, limits) {
      const time = now(), day = beijingDay(time), month = day.slice(0, 7), state = load(month);
      const used = totals(state, user, day);
      if (used.month >= limits.monthly) throw tregFailure(429, monthlyMessage);
      if (used.day >= limits.daily) throw tregFailure(429, dailyMessage);
      const reservedMicro = Math.min(limits.call, limits.daily - used.day, limits.monthly - used.month);
      if (reservedMicro <= 0) throw tregFailure(429, "单次数据额度为零，请联系管理员");
      const row = { id: crypto.randomUUID(), time: new Date(time).toISOString(), user, path: requestPath, reservedMicro, actualMicro: null };
      state.entries.push(row); save(month, state);
      return { month, id: row.id, reservedMicro };
    },
    settle(reservation, actualMicro) {
      if (!Number.isSafeInteger(actualMicro) || actualMicro < 0) return; // 未知结果保留预留金额，包括重启后的未完成调用。
      const state = load(reservation.month), row = state.entries.find((entry) => entry.id === reservation.id);
      if (!row) throw new Error("数据预留记录缺失");
      row.actualMicro = actualMicro; save(reservation.month, state);
    },
    claimNotice() {
      const day = beijingDay(now()), month = day.slice(0, 7), state = load(month);
      if (state.notices.includes(day)) return false;
      state.notices.push(day); save(month, state); return true;
    },
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
  const defaults = { daily: usdMicro(env.TREG_DAILY_USD ?? 1), monthly: usdMicro(env.TREG_MONTHLY_USD ?? 10), call: usdMicro(env.TREG_CALL_MAX_USD ?? 1) };
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
