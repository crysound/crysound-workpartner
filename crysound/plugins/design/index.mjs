/** Company design skill provider; the host exposes user-invocable skills as slash commands. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'crysound-design';
export const inject = ['skills'];
const directory = fileURLToPath(new URL('.', import.meta.url));
const instructionFile = fileURLToPath(new URL('./SKILL.md', import.meta.url));
const description = '设计公司品牌网页、App 原型、信息图、海报与设计体检；先探索三个方向，选择后迭代。幻灯片使用 SlideStudio。';

/**
 * Register one bundled skill with the host's scoped registry.
 * @param {object} ctx Cordis context containing the skills service.
 * @returns {void}
 */
export function apply(ctx) {
  const candidate = {
    name: 'design', description, invocation: { modelInvocable: true, userInvocable: true },
    provider: 'crysound-design', source: 'bundled', rank: 600,
    resourceBase: { kind: 'directory', path: directory.replaceAll('\\', '/') },
    instructionFilePath: instructionFile.replaceAll('\\', '/'), locator: instructionFile,
  };
  ctx.skills.registerProvider(() => ({
    name: 'crysound-design',
    async list() { return [candidate]; },
    async get(entry, options) {
      const raw = await readFile(instructionFile, { encoding: 'utf8', signal: options.signal });
      const { rank, locator, ...summary } = entry;
      return { ...summary, content: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '') };
    },
  }));
}
