/** Test-only Host plugin: load only in an isolated profile containing synthetic conversations. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'memory-capability-probe';
export const inject = ['sessionQuery', 'llm'];

/** Observe real lifecycle/read APIs and a disposable timer, without learning or making model calls. */
export function apply(ctx) {
  const record = value => appendFileSync(join(process.env.DSH_HOME, 'memory-capability-probe.jsonl'), JSON.stringify(value) + '\n');
  ctx.on('agent/status', ({ agent, status }) => {
    record({ capability: 'status', status });
    if (status === 'idle') void ctx.sessionQuery.readSession(agent.session.id).then(({ events }) => {
      record({ capability: 'history', userMessages: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length,
        auxiliaryRequests: events.filter(event => event.type === 'session/title-llm-request').length });
    }).catch(error => record({ capability: 'history', error: error.message }));
  }, { global: true });
  ctx.effect(() => {
    const timer = setTimeout(() => record({ capability: 'timer', fired: true }), 100);
    return () => clearTimeout(timer);
  });
  record({ capability: 'llm', prepareCall: typeof ctx.llm.prepareCall === 'function' });
}
