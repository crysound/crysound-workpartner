// One gateway writer per user. A durable claim precedes all reads/model calls;
// failures and interrupted runs are visible in history and never retried that day.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function beijingDay(now) {
  const local = new Date(now + 8 * 3600000);
  return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 16), weekday: local.getUTCDay() };
}
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createDailyCheck({ directory, users, connected, available, collect, summarize, now = Date.now }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const running = new Map();
  const file = user => path.join(directory, hash(user.unionId) + '.json');
  function load(user) {
    try {
      const state = JSON.parse(fs.readFileSync(file(user), 'utf8'));
      if (state.version !== 1) throw new Error('Unsupported daily check state');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, enabled: false, time: '09:00', records: [], seen: [] };
    }
  }
  function save(user, state) {
    const temp = file(user) + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file(user));
  }
  function status(user) {
    const state = load(user);
    return { enabled: state.enabled, time: state.time, available: available(user), connected: connected(user),
      records: state.records.map(({ id, date, at, outcome, count, sessionId, unread, reason }) => ({ id, date, at, outcome, count, sessionId, unread, reason })) };
  }
  function configure(user, input) {
    if (typeof input.enabled !== 'boolean' || typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || Object.keys(input).some(key => !['enabled', 'time'].includes(key))) throw fail(400, 'invalid_settings', '请选择开关状态和有效的北京时间');
    if (input.enabled && !available(user)) throw fail(403, 'not_available', '这项功能尚未向你开放试用');
    if (input.enabled && !connected(user)) throw fail(409, 'needs_connection', '请先在飞书授权中连接本人账号');
    const state = load(user);
    Object.assign(state, input);
    if (!input.enabled) {
      // Stop undelivered reminders as well as future runs; keep history.
      for (const record of state.records) if (record.outcome === 'pending') { record.outcome = 'cancelled'; delete record.report; }
    }
    save(user, state);
    return status(user);
  }
  async function execute(user, manual) {
    let state = load(user);
    const day = beijingDay(now());
    if (!state.enabled || !available(user) || !connected(user)) {
      if (manual) throw fail(409, 'needs_enabled', '请先连接飞书并打开每天帮我查一次');
      return;
    }
    if (!manual && ([0, 6].includes(day.weekday) || day.time < state.time)) return;
    if (state.records.some(record => record.date === day.date)) {
      if (manual) throw fail(409, 'already_attempted', '今天已经查过或尝试过了，明天再查，避免重复提醒');
      return;
    }
    const record = { id: crypto.randomUUID(), date: day.date, at: now(), outcome: 'interrupted', count: 0 };
    state.records = [record, ...state.records].slice(0, 30);
    save(user, state);
    let phase = 'read';
    try {
      const items = await collect(user, day, now());
      if (!Array.isArray(items) || items.some(item => !item.id || !item.text) || items.length > 2000) throw new Error('Incomplete collection');
      const fingerprints = items.map(item => hash(item));
      const fresh = items.filter((_item, index) => !state.seen.includes(fingerprints[index]));
      // Settings may have changed while requests were in flight. Never overwrite them.
      state = load(user);
      const current = state.records.find(item => item.id === record.id);
      if (!state.enabled || !available(user) || !connected(user)) { current.outcome = 'cancelled'; save(user, state); return; }
      if (!fresh.length) { current.outcome = 'quiet'; state.seen = fingerprints; save(user, state); return; }
      if (JSON.stringify(fresh).length > 60000) throw new Error('Daily facts exceed summary limit');
      current.facts = fresh; save(user, state);
      phase = 'summary';
      const report = await summarize(user, fresh, day);
      if (!report || typeof report.text !== 'string' || !report.text.trim() || report.text.length > 8000 || typeof report.model !== 'string' || !report.model) throw new Error('Invalid summary');
      state = load(user);
      const latest = state.records.find(item => item.id === record.id);
      if (!state.enabled || !available(user) || !connected(user)) latest.outcome = 'cancelled';
      else {
        latest.outcome = 'pending'; latest.count = fresh.length;
        // The preallocated identity makes delivery idempotent across Host/gateway restarts.
        latest.sessionId = crypto.randomUUID(); latest.report = report;
        state.seen = fingerprints;
      }
      save(user, state);
    } catch (error) {
      state = load(user);
      const current = state.records.find(item => item.id === record.id);
      if (current) { current.outcome = 'failed'; current.reason = phase; save(user, state); }
      // Never persist or log raw upstream errors (may contain personal content).
    }
  }
  function run(user, manual = false) {
    if (running.has(user.unionId)) return manual ? Promise.reject(fail(409, 'running', '正在检查，请稍后查看记录')) : running.get(user.unionId);
    const task = execute(user, manual).finally(() => running.delete(user.unionId));
    running.set(user.unionId, task);
    return task;
  }
  async function tick() { for (const user of users()) if (available(user)) await run(user); }
  function pending(user) {
    const state = load(user);
    if (!state.enabled || !available(user) || !connected(user)) return [];
    return state.records.filter(record => record.outcome === 'pending');
  }
  function delivered(user, id) {
    const state = load(user), record = state.records.find(item => item.id === id);
    if (record?.outcome === 'pending') { record.outcome = 'delivered'; record.unread = true; delete record.report; save(user, state); }
    return {};
  }
  function read(user, id) {
    const state = load(user), record = state.records.find(item => item.id === id);
    if (record) { record.unread = false; save(user, state); }
    return {};
  }
  return { status, configure, run, tick, pending, delivered, read };
}

export function createDailyCheckHandler({ service, identify, origin, internal = false }) {
  return async (req, res, url) => {
    const prefix = internal ? '/daily-check/' : '/_zp/daily-check/';
    if (!url.pathname.startsWith(prefix)) return false;
    const route = url.pathname.slice(prefix.length);
    const reply = (code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const user = identify(req);
      if (!user) throw fail(401, 'login', '请先登录工作伙伴');
      if (!(internal ? ['pending', 'delivered'] : ['status', 'settings', 'run', 'read']).includes(route)) throw fail(404, 'request', '页面不存在');
      if (['status', 'pending'].includes(route) ? req.method !== 'GET' : req.method !== 'POST') throw fail(405, 'request', '请求方法不支持');
      if (!internal && req.method === 'POST' && req.headers.origin !== origin) throw fail(403, 'request', '请从工作伙伴设置中操作');
      let input = {};
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) { text += chunk; if (text.length > 2048) throw fail(413, 'request', '请求内容过多'); }
        try { input = JSON.parse(text || '{}'); } catch { throw fail(400, 'request', '请求格式有误'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'request', '请求格式有误');
      }
      if (route === 'status') reply(200, service.status(user));
      else if (route === 'settings') reply(200, service.configure(user, input));
      else if (route === 'run') { await service.run(user, true); reply(200, service.status(user)); }
      else if (route === 'pending') reply(200, service.pending(user));
      else if (route === 'delivered') reply(200, service.delivered(user, input.id));
      else reply(200, service.read(user, input.id));
    } catch (error) { reply(error.status || 503, { code: error.code || 'unavailable', message: error.status ? error.message : '暂时无法检查，请查看运行记录；今天不会自动重试' }); }
    return true;
  };
}
