// This reader never submits prompts to an Agent, so collected Feishu text cannot
// trigger tools or replies. It only appends the already generated reminder.
import fs from 'node:fs';

export async function deliverDailyReport(ctx, record, signal, stillPending = async () => true) {
  const id = record.sessionId;
  let session = ctx.sessions.get(id);
  if (!session) {
    if (await ctx.sessionPersistence.stat(id)) {
      const found = await ctx.sessionController.resolveAgent(id);
      if (found.error) throw found.error;
      session = found.agent.session;
    } else {
      const created = await ctx.sessionController.create({ sessionId: id });
      if (created.sessionId !== id) throw new Error('Reminder session identity changed');
      session = ctx.sessions.get(id);
    }
  }
  // Scan through the public paged reader, including after a crash before ACK.
  let beforeSeq;
  let exists = false;
  do {
    const page = await ctx.sessionController.events({ address: { kind: 'session', sessionId: id }, maxMessages: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal);
    exists = page.records.some(entry => entry.type === 'event' && entry.event.type === 'assistant/message' && entry.event.data.message.id === record.id);
    if (exists || !page.hasMore) break;
    beforeSeq = page.records[0]?.event?.seq;
    if (beforeSeq === undefined) throw new Error('Missing history cursor');
  } while (!exists);
  signal.throwIfAborted();
  if (!await stillPending()) return false;
  signal.throwIfAborted();
  if (!exists) {
    const text = `${record.date} · 每天帮我查一次\n\n${record.report.text}`;
    session.append('assistant/message', { turn: 0, step: 0,
      message: { id: record.id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'magpie', model: record.report.model } },
      stream: [{ type: 'text-chunks', time0: record.at, index: 0, dt: [], texts: [text] }],
    }, { surfaceOp: 'append' });
  }
  await ctx.sessionController.rename({ sessionId: id, title: `伙伴 · ${record.date} 提醒` });
  if (!await ctx.sessions.flush(session)) throw new Error('Reminder persistence unavailable');
  return true;
}

export function installDailyReader(ctx) {
  const configFile = process.env.CRYSOUND_FEISHU_CONFIG;
  if (!configFile) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  // Cloud-only first release. Desktop local mode does not run a second scheduler.
  if (config.kind !== 'container') return;
  ctx.effect(() => {
    const controller = new AbortController();
    let timer;
    async function request(route, body) {
      const response = await fetch(new URL('/daily-check/' + route, config.tokenUrl), {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${fs.readFileSync(config.identityFile, 'utf8').trim()}`, 'content-type': 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('Daily reminder unavailable');
      return response.json();
    }
    async function tick() {
      try {
        const records = await request('pending');
        for (const record of records) {
          controller.signal.throwIfAborted();
          const delivered = await deliverDailyReport(ctx, record, controller.signal, async () => (await request('pending')).some(item => item.id === record.id));
          if (delivered) await request('delivered', { id: record.id });
        }
      } catch { /* No user notification on failure; the pending record stays visible. */ }
      if (!controller.signal.aborted) { timer = setTimeout(tick, 60000); timer.unref(); }
    }
    void tick();
    return () => { controller.abort(); clearTimeout(timer); };
  });
}
