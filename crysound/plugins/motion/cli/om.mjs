#!/usr/bin/env node
// Linux's advisory lock is released by the OS on every exit; failed jobs never leave stale lock state.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('Company motion runtime currently requires Linux.');
const directory = join(homedir(), '.cache', 'crysound-motion');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const child = spawn('flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '75', join(directory, 'job.lock'),
  process.execPath, fileURLToPath(new URL('./supervise.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
const stop = (signal) => { child.kill(signal); };
const term = () => stop('SIGTERM');
const interrupt = () => stop('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', interrupt);
child.once('error', (error) => { console.error(`Cannot start motion job: ${error.message}`); process.exitCode = 1; });
child.once('close', (code) => {
  process.off('SIGTERM', term);
  process.off('SIGINT', interrupt);
  if (code === 75) console.error('Another motion job is running in this container. Wait for it to finish.');
  process.exitCode = code ?? 1;
});
