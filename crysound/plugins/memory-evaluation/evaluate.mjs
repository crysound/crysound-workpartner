/** Paired real-host evaluation. The supplied entry owns isolation and existing model access. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, globSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cases = JSON.parse(readFileSync(new URL('./dialogues.json', import.meta.url), 'utf8'));

/** Report only complete runs; a rejected save is not a remembered fact. */
export function score(rows) {
  const complete = rows.length === cases.length && rows.every(row => row.status === 'ok');
  if (!complete) return { complete: false, completed: rows.filter(row => row.status === 'ok').length, total: cases.length };
  let hit = 0, falsePositive = 0;
  for (const fixture of cases) {
    const row = rows.find(row => row.id === fixture.id);
    if (!row) throw new Error('Missing fixture: ' + fixture.id);
    if (fixture.label === '该记') {
      if (row.facts.some(fact => new RegExp(fixture.expected.pattern, 'u').test(fact.content))) hit++;
    } else if (row.facts.length) falsePositive++;
  }
  const positive = cases.filter(fixture => fixture.label === '该记').length;
  const negative = cases.length - positive;
  return { complete, extraction: { hit, total: positive, rate: hit / positive }, falseMemory: { hit: falsePositive, total: negative, rate: falsePositive / negative } };
}

async function main() {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
  for (const key of ['--entry', '--baseline', '--candidate', '--sessions', '--output']) if (!args[key]) throw new Error('Missing ' + key);
  const output = resolve(args['--output']);
  mkdirSync(output, { recursive: true });
  const run = (...values) => exec(resolve(args['--entry']), values, { timeout: 360000, maxBuffer: 8 * 1024 * 1024 });
  for (const variant of ['baseline', 'candidate']) {
    const source = resolve(args['--' + variant]);
    const hash = createHash('sha256');
    for (const file of ['index.mjs', 'guidance.mjs']) if (existsSync(join(source, file))) hash.update(readFileSync(join(source, file)));
    const promptHash = hash.digest('hex');
    await run('sync', source);
    const rows = [];
    for (const fixture of cases) {
      const path = join(output, variant + '-' + fixture.id + '.json');
      if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, 'utf8'));
        if (previous.promptHash !== promptHash) throw new Error('Output contains another prompt version: ' + path);
        if (previous.status === 'ok') { rows.push(previous); continue; }
      }
      // The entry's reset applies only to this task's synthetic test data.
      await run('reset');
      let row = { id: fixture.id, variant, promptHash, status: 'error' };
      try {
        const { stdout } = await run('headless', fixture.dialogue.map(message => message.content).join('\n'));
        const { stdout: database } = await run('db', 'select id,kind,title,content from facts order by id');
        const paths = [...globSync('**/session.v*.jsonl.zstd', { cwd: resolve(args['--sessions']) })];
        if (paths.length !== 1) throw new Error('Expected one fresh synthetic session, found ' + paths.length);
        const { stdout: log } = await exec('zstd', ['-dc', join(resolve(args['--sessions']), paths[0])], { maxBuffer: 16 * 1024 * 1024 });
        const events = log.trim().split('\n').map(line => JSON.parse(line));
        const models = events.filter(event => event.type === 'assistant/message').map(event => event.data.message.source).filter(source => source?.model).map(({ provider, model }) => ({ provider, model }));
        if (!models.length || !events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')) throw new Error('No completed model turn in session log');
        const calls = events.filter(event => event.type === 'tool/call' && event.data.name.includes('memory')).map(event => event.data);
        const callIds = new Set(calls.map(call => call.callId));
        const results = events.filter(event => event.type === 'tool/result' && callIds.has(event.data.message.source.callId)).map(event => event.data);
        row = { ...row, status: 'ok', models, dialogue: fixture.dialogue, calls, results, facts: JSON.parse(database), answer: stdout.trim() };
      } catch (error) { row.error = error.message; }
      writeFileSync(path, JSON.stringify(row, null, 2) + '\n');
      rows.push(row);
      console.log(variant, fixture.id, row.status, row.facts?.length ?? 'unmeasured');
      writeFileSync(join(output, variant + '-summary.json'), JSON.stringify(score(rows), null, 2) + '\n');
      if (row.status !== 'ok') throw new Error('Environment or capture failed; preserve results and resume: ' + path);
    }
    console.log(variant, JSON.stringify(score(rows)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
