#!/usr/bin/env node
// Linux's advisory lock is released by the OS on every exit; failed jobs never leave stale lock state.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openJobLock } from './storage.mjs';

if (process.platform !== 'linux') throw new Error('Company motion runtime currently requires Linux.');
let lock;
try { lock = openJobLock(); }
catch (error) { console.error(error.message); process.exit(1); }
// flock locks the inherited open file description; the supervisor retains it until all helpers stop.
const acquired = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', '3'],
  { stdio: ['ignore', 'inherit', 'inherit', lock.fd] });
if (acquired.status !== 0) {
  closeSync(lock.fd);
  if (acquired.status === 75) console.error('另一项任务正在运行，请等它完成后再试。');
  else console.error(`无法取得动效任务锁：${acquired.error?.message || '请检查 flock 是否可用。'}`);
  process.exit(acquired.status || 1);
}
const child = spawn(process.execPath,
  [fileURLToPath(new URL('./supervise.mjs', import.meta.url)), ...process.argv.slice(2)],
  { stdio: ['inherit', 'inherit', 'inherit', lock.fd], env: { ...process.env, TMPDIR: lock.directory } });
closeSync(lock.fd);
const stop = (signal) => { child.kill(signal); };
const term = () => stop('SIGTERM');
const interrupt = () => stop('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', interrupt);
child.once('error', (error) => { console.error(`Cannot start motion job: ${error.message}`); process.exitCode = 1; });
child.once('close', (code) => {
  process.off('SIGTERM', term);
  process.off('SIGINT', interrupt);
  process.exitCode = code ?? 1;
});
