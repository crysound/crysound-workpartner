import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { launch } from '../cli/lib/cdp.js';

for (const [platform, uid] of [['linux', 1001], ['linux', 0], ['darwin', 1001]]) {
  test(`Chrome launch flags for ${platform} uid ${uid}`, async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalSpawn = childProcess.spawn;
    const originalGetuid = process.getuid;
    t.after(() => {
      Object.defineProperty(process, 'platform', descriptor);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'platform'), descriptor);
      assert.equal(childProcess.spawn, originalSpawn);
      assert.equal(process.getuid, originalGetuid);
    });
    Object.defineProperty(process, 'platform', { value: platform });
    t.mock.method(process, 'getuid', () => uid);
    let invocation;
    const child = new EventEmitter();
    child.pid = 12345;
    child.stderr = new PassThrough();
    child.stdio = [null, null, child.stderr, new PassThrough(), new PassThrough()];
    child.kill = () => { child.emit('exit', 0); return true; };
    t.mock.method(childProcess, 'spawn', (exe, args) => {
      invocation = { exe, args };
      return child;
    });
    syncBuiltinESMExports();
    const conn = await launch('configured-chrome', { args: ['--custom-render-option'] });
    try {
      assert.equal(invocation.exe, 'configured-chrome');
      for (const flag of ['--no-sandbox', '--disable-dev-shm-usage']) {
        assert.equal(invocation.args.includes(flag), platform === 'linux', flag);
      }
      assert.ok(invocation.args.includes('--custom-render-option'));
      assert.ok(invocation.args.includes('--remote-debugging-pipe'));
    } finally {
      await conn.close({ fast: true });
    }
  });
}
