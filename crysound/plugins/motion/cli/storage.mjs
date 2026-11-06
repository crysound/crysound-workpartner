import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Open the per-user lock in Linux's shared /tmp, or the current workspace if /tmp is read-only.
 * @returns {{ directory: string, fd: number }} Private writable directory and owned lock descriptor.
 */
export function openJobLock() {
  // TMPDIR can differ between model calls; the container lock must not follow that per-job value.
  const name = `crysound-motion-${process.getuid()}`;
  const failures = [];
  for (const directory of [join('/tmp', name), join(process.cwd(), '.crysound-motion', name)]) {
    let fd;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw new Error('目录必须由本人拥有且仅本人可访问');
      }
      fd = openSync(join(directory, 'job.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const lock = fstatSync(fd);
      if (!lock.isFile() || lock.uid !== process.getuid() || (lock.mode & 0o077)) {
        throw new Error('锁文件必须由本人拥有且仅本人可访问');
      }
      return { directory, fd };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      failures.push(`${directory}：${error.code || error.message}`);
    }
  }
  throw new Error(`无法创建动效任务锁：系统临时目录和当前工作区均不可写或不安全。请在可写工作区运行，并检查目录权限。\n${failures.join('\n')}`);
}
