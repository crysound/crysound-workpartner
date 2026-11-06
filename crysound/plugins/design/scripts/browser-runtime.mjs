/** Share at most two browser processes across concurrent design commands for the current OS user. */
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// OS-owned loopback reservations disappear on process exit, including crashes.
// Fixed ports make independent CLI processes share the same two slots.
async function reserve(port) {
  const server = createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      resolve(() => new Promise((done, fail) => server.close(error => error ? fail(error) : done())));
    });
  });
}

async function acquire() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const port of [43871, 43872]) {
      const release = await reserve(port);
      if (release) return release;
    }
    await delay(100);
  }
  throw new Error('两个设计浏览器槽均不可用，请稍后重试或检查本机端口占用。');
}

/**
 * Run with the image's existing headless browser and always close it before releasing its slot.
 * @param {(browser: object) => Promise<unknown>} action Browser work.
 * @returns {Promise<unknown>} Action result.
 */
export async function withBrowser(action) {
  const entry = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
  if (!entry || !isAbsolute(entry)) throw new Error('需要已有的 SLIDESTUDIO_PLAYWRIGHT_RUNTIME；请联系管理员配置，勿安装或下载浏览器。');
  const runtime = await import(pathToFileURL(entry).href);
  if (typeof runtime.launchPinnedChromium !== 'function') throw new Error('共用浏览器运行时缺少 launchPinnedChromium。');
  const release = await acquire();
  let browser;
  try {
    browser = await runtime.launchPinnedChromium();
    return await action(browser);
  } finally {
    // A failed close retains the slot while this process lives; do not start another browser over it.
    if (browser) await browser.close();
    await release();
  }
}
