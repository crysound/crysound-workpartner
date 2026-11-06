// Shared renderer subprocess policy: bound ffmpeg decoding, filters and encoding.
import { spawn as spawnChild, spawnSync as spawnChildSync } from 'node:child_process';

function boundedArgs(command, args) {
  if (command !== 'ffmpeg' || !args.includes('-i')) return args;
  return ['-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...args.slice(0, -1), '-threads', '2', args.at(-1)];
}

/** Spawn an inherited job-group child with bounded ffmpeg threads. */
export const spawn = (command, args, options) => spawnChild(command, boundedArgs(command, args), options);
/** Run a synchronous child under the same thread policy and outer job deadline. */
export const spawnSync = (command, args, options) => spawnChildSync(command, boundedArgs(command, args), options);
