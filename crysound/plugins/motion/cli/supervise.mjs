import { fileURLToPath } from 'node:url';
import { runJob } from './job.mjs';

process.exitCode = await runJob(fileURLToPath(new URL('./worker.mjs', import.meta.url)), process.argv.slice(2));
