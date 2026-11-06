// Own the job group outside the renderer event loop: synchronous music synthesis cannot block its deadline.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run one Linux worker in a disposable process group; stop every helper before resolving.
 * @param {string} worker JavaScript worker entry.
 * @param {string[]} args Worker arguments.
 * @param {object} options Deadline, environment and output routing.
 * @returns {Promise<number>} Worker exit status, or 124 on deadline.
 */
export async function runJob(worker, args, { timeoutMs = 300_000, env = process.env, stdio = 'inherit' } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'crysound-motion-'));
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)));
  const child = spawn(process.execPath, [worker, ...args], {
    detached: true, stdio, env: { ...cleanEnv, OM_SAMPLES: 'off', TMPDIR: scratch },
  });
  let stopped = 0;
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let force;
  const stop = (code) => {
    if (stopped) return;
    stopped = code;
    kill('SIGTERM');
    force = setTimeout(() => kill('SIGKILL'), 1000);
  };
  const onTerm = () => stop(143);
  const onInt = () => stop(130);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const timer = setTimeout(() => { console.error('Motion job exceeded its time limit; stopped.'); stop(124); }, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(stopped || code || (code === 0 ? 0 : 1)));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    // Helpers inherit the worker's group even if their original parent already exited.
    if (child.pid) kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  }
}
