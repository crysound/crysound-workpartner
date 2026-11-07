/** Personal memory: model tools and a logged, bounded system-prompt section. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryStore, recallData } from './store.mjs';
import { registerPanel } from './panel.mjs';
import { guidance } from './guidance.mjs';

/** Cordis plugin name. */
export const name = 'crysound-memory';
/** Headless also supports memory; web services are optional scoped injections. */
export const inject = ['tools', 'systemPrompt'];
/** Deployment limits; storage is confined to the personal persistent home. */
export const Config = Schema.object({
  maxMemories: Schema.number().default(50).description('最多保存的记忆条数（1–200）。'),
  recallChars: Schema.number().default(6000).description('全部记忆、日期及版本编号的召回字符上限（512–24000）。'),
});

/** Register scoped contributions and share one store between tools and the panel. */
export function apply(ctx, config) {
  const store = new MemoryStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'crysound-memory'), config);
  ctx.effect(() => () => store.close());
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'crysound-memory', order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'), interpolate: false,
    text: () => {
      const data = store.snapshot();
      if (!data.enabled) return '个人记忆已关闭；不要调用个人记忆保存工具。';
      return guidance + `已用 ${data.usage.count}/${store.maxMemories} 条、${data.usage.chars}/${store.recallChars} 字。\n当前记忆：\n` + JSON.stringify(recallData(data));
    },
  }));
  const factParameters = {
    kind: { type: 'string', enum: ['preference', 'identity', 'project'], required: true, description: '稳定的偏好、身份或长期项目。' },
    title: { type: 'string', required: true, description: '概念标题，不超过40字，例如“报告格式”。' },
    content: { type: 'string', required: true, description: '一个稳定事实，不超过240字。' },
  };
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    presentationMeta: (_args, value) => ({ memory: { ok: value.ok, message: value.message || value.error || '个人记忆操作完成。', ...(value.saved ? { saved: value.saved } : {}) } }),
  };
  for (const tool of [
    {
      name: 'crysound_memory_list', description: '读取本人当前个人记忆、用量及版本，保存、更新或删除前使用。关闭时不返回条目。', parameters: {},
      execute: () => store.snapshot(), presentCall: () => ({ card: 'generic', title: '查看个人记忆' }),
    },
    {
      name: 'crysound_memory_save',
      description: '稳定偏好、纠正或长期背景第一次出现就保存，内容写成陈述句；不等用户说记住。同一概念带原 id 更新，不重复新增。80%或满额时先提合并/删除方案，用户同意后一次调用原子整理并保存。不记敏感信息；本会话要求别记后不调用。',
      parameters: {
        revision: { type: 'number', required: true, description: '刚读取的记忆版本。' },
        id: { type: 'string', description: '更新已有概念时必填原编号；只有新概念不填。' },
        ...factParameters,
        confirmed: { type: 'boolean', description: '用户已明确同意具体合并/删除方案时才能填 true。' },
        removeIds: { type: 'array', items: { type: 'string' }, description: '经用户同意要删除或已合并进其他条目的编号。' },
        updates: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string', required: true }, ...factParameters,
        }, additionalProperties: false }, description: '合并后需更新的其他条目，原编号不变。与删除和当前保存同一事务。' },
      },
      execute: args => {
        const data = store.save(args);
        // Resolve the committed record, including the generated id, after the transaction succeeds.
        const saved = data.facts.find(fact => fact.id === data.savedId);
        return { ...data, saved: { id: saved.id, title: saved.title }, message: `已记住：${saved.title}` };
      },
      presentCall: () => ({ card: 'generic', title: '保存个人记忆' }),
    },
    {
      name: 'crysound_memory_forget', description: '用户明确要求忘记时，删除指定个人记忆；保留其他事实。不保留含原文的删除日志。',
      parameters: {
        revision: { type: 'number', required: true, description: '刚读取的记忆版本。' },
        id: { type: 'string', required: true, description: '当前记忆中要删除的唯一编号。' },
      },
      execute: args => ({ ...store.remove(args), message: '已删除指定个人记忆。' }),
      presentCall: () => ({ card: 'generic', title: '删除指定个人记忆' }),
    },
  ]) {
    ctx.effect(() => ctx.tools.register(defineTool({
      ...tool, output,
      async execute(args, execution) {
        if (execution.signal.aborted) return { ok: false, error: '操作已取消。' };
        try {
          const data = tool.execute(args);
          return { ok: true, ...recallData(data), usage: data.usage, ...(data.message ? { message: data.message } : {}), ...(data.saved ? { saved: data.saved } : {}) };
        } catch (error) { return { ok: false, error: error.message }; }
      },
      presentResult: (_args, result) => ({ card: 'generic', title: result.meta?.memory?.message || '个人记忆操作完成。' }),
    })));
  }
  ctx.inject(['webServer', 'webStartup'], web => registerPanel(web, store));
}
