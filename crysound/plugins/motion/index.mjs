/** Company motion workflow, registered on both model and slash-command skill surfaces. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'crysound-motion';
/** The host owns the skill registry and registration disposal. */
export const inject = ['skills'];

/**
 * Register the packaged skill and its absolute runtime paths.
 * @param {object} ctx Host context with the skill registry.
 */
export function apply(ctx) {
  const directory = fileURLToPath(new URL('./skills/crysound-motion/', import.meta.url));
  const path = fileURLToPath(new URL('./skills/crysound-motion/SKILL.md', import.meta.url));
  const raw = readFileSync(path, 'utf8');
  const header = /^---\n[\s\S]*?\n---\n/.exec(raw);
  if (!header) throw new Error('crysound-motion: packaged skill metadata is missing');
  const runtime = { node: process.execPath, om: fileURLToPath(new URL('./cli/om.mjs', import.meta.url)) };
  ctx.skills.register({
    name: 'crysound-motion',
    description: '制作 20–30 秒公司产品片、发布片和动效图，生成中文静帧、合成配乐、MP4/GIF。',
    path, provider: name, source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: directory },
    content: raw.slice(header[0].length).trim() + '\n\n## 已安装的命令入口\n\n每条命令用 node 执行 om 文件。路径按独立参数传递。\n\n' + JSON.stringify(runtime),
  });
}
