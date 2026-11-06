/* Browser module consumed directly by dsh; native controls need no build step. */
window.__ModuleLoader__.load({
  id: '@crysound/memory',
  factory(require) {
    const { createElement: h, useState, useEffect } = require('react');
    const { Button, Switch, Input, Modal, Menu, IconPinOutlineMedium, IconEditOutlineRegular, IconTrashOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const copy = {
      title: '个人记忆', description: '伙伴记住的你的工作和偏好，只用于你自己的对话，同事看不到。',
      sync: '网页版和桌面版各存一份，目前不同步。',
      empty: '还没有个人记忆', example: '在对话里说“记住我写报告喜欢用表格”',
      loading: '正在读取记忆…', retry: '读取失败，请重新打开页面或稍后切回重试。',
      remove: '删除', confirm: '确认删除', cancel: '取消', saving: '正在保存…',
      note: '删除后，后续记忆召回不再包含这条。原聊天记录和既有备份会保留。',
      preference: '偏好', identity: '个人背景', project: '长期项目',
      capacity: '记忆空间接近上限，整理后可继续记录。',
      enabled: '使用个人记忆', disabled: '关闭后，新会话不再使用个人记忆，对话中也不会保存；已有条目保留。',
      clear: '清空全部', clearConfirm: '清空全部个人记忆？', clearNote: '全部条目会被删除，无法在这里恢复。删除后，后续记忆召回不再包含这些条目。原聊天记录和既有备份会保留。',
      add: '添加一条', edit: '编辑', save: '保存', kind: '类型', factTitle: '标题', content: '内容',
      conversation: '对话中记下', manual: '手动添加', edited: '页面修改', created: '创建于', updated: '更新于',
      pending: '正在保存个人记忆…', failed: '个人记忆操作未完成。',
    };
    // Same spacing, type sizes and theme tokens as native General / PreferenceRow;
    // Button, Switch, Input, Menu and Modal own all control styling and behavior.
    const styles = `
.zp-memory{width:100%;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.zp-memory h2,.zp-memory h3,.zp-memory p{margin:0}
.zp-memory-header{display:flex;align-items:flex-start;gap:16px;padding:0 0 16px}
.zp-memory-header>div,.zp-memory-text{flex:1;min-width:0}
.zp-memory-header h2{font-size:16px;line-height:24px;font-weight:500;margin-bottom:4px}
.zp-memory-muted{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.zp-memory-row{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.zp-memory-text{display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.zp-memory h3{font-size:14px;line-height:22px;font-weight:500}
.zp-memory-actions{display:flex;flex:none;gap:4px}
.zp-memory-list{list-style:none;margin:0;padding:0}
.zp-memory-usage{padding:16px 0 0}
.zp-memory-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:40px 0}
.zp-memory-empty>button{margin-top:8px}
.zp-memory-footer{display:flex;flex-direction:column;align-items:flex-start;gap:16px;padding:16px 0}
.zp-memory-danger{color:var(--dsw-alias-state-error-primary)}
.zp-memory-form{display:flex;flex-direction:column;gap:16px}
.zp-memory-field{display:flex;flex-direction:column;gap:8px}
.zp-memory-field>span{width:100%;box-sizing:border-box}
.zp-memory-kind{display:flex;align-items:center;justify-content:space-between;gap:16px}
.zp-memory-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 0}
@media(max-width:480px){.zp-memory-header{flex-wrap:wrap}.zp-memory-row{gap:8px}}
`;
    const date = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
    async function request(action, options = {}) {
      const response = await fetch('/crysound-memory/api/' + action, { ...options, cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || copy.retry);
      return value;
    }
    function MemoryPanel() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      // An open editor/confirmation keeps its displayed revision until dismissed.
      const [action, setAction] = useState(null);
      const [busy, setBusy] = useState(false);
      const [kindOpen, setKindOpen] = useState(false);
      useEffect(() => {
        if (busy || action !== null) return;
        let controller;
        const refresh = async () => {
          if (document.visibilityState === 'hidden') return;
          controller?.abort();
          controller = new AbortController();
          const current = controller;
          try {
            const value = await request('list', { signal: current.signal });
            if (!current.signal.aborted) { setData(value); setError(''); }
          } catch (error) { if (!current.signal.aborted) setError(error.message); }
        };
        void refresh();
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          controller?.abort();
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [busy, action]);
      async function change(path, input) {
        setBusy(true); setError('');
        try {
          setData(await request(path, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, revision: data.revision }),
          }));
          setAction(null);
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }
      const close = () => { if (!busy) { setAction(null); setKindOpen(false); setError(''); } };
      const add = () => { setError(''); setAction({ type: 'edit', fact: { kind: 'preference', title: '', content: '' } }); };
      function editor() {
        if (action?.type !== 'edit') return null;
        const draft = action.fact;
        const update = (key, value) => setAction({ ...action, fact: { ...draft, [key]: value } });
        return h(Modal, { open: true, title: draft.id ? copy.edit : copy.add, closeLabel: copy.cancel, onClose: close,
          footer: h('div', { className: 'zp-memory-actions' },
            h(Button, { variant: 'outline', disabled: busy, onClick: close }, copy.cancel),
            h(Button, { variant: 'primary', type: 'submit', form: 'zp-memory-editor', disabled: busy }, busy ? copy.saving : copy.save)) },
          h('form', { id: 'zp-memory-editor', className: 'zp-memory-form', onSubmit: event => { event.preventDefault(); void change('save', draft); } },
            h('div', { className: 'zp-memory-kind' }, h('span', null, copy.kind),
              h(Menu, { open: kindOpen, onClose: () => setKindOpen(false), portal: true, selectedId: draft.kind,
                items: ['preference', 'identity', 'project'].map(id => ({ id, label: copy[id], disabled: busy })),
                onSelect: id => { update('kind', id); setKindOpen(false); },
                anchor: h(Button, { variant: 'outline', size: 'sm', disabled: busy, 'aria-label': copy.kind, 'aria-haspopup': 'menu', 'aria-expanded': kindOpen, onClick: () => setKindOpen(!kindOpen) }, copy[draft.kind]) })),
            h('label', { className: 'zp-memory-field' }, copy.factTitle,
              h(Input, { required: true, maxLength: 40, disabled: busy, 'data-modal-autofocus': true, value: draft.title, onChange: event => update('title', event.target.value) })),
            h('label', { className: 'zp-memory-field' }, copy.content,
              h(Input, { required: true, maxLength: 240, disabled: busy, value: draft.content, onChange: event => update('content', event.target.value) })),
            error ? h('p', { className: 'zp-memory-error', role: 'alert' }, error) : null));
      }
      function confirmation() {
        if (!['delete', 'clear'].includes(action?.type)) return null;
        const clear = action.type === 'clear';
        return h(Modal, { open: true, title: clear ? copy.clearConfirm : copy.confirm, closeLabel: copy.cancel, onClose: close,
          description: clear ? copy.clearNote : copy.note,
          footer: h('div', { className: 'zp-memory-actions' },
            h(Button, { variant: 'outline', disabled: busy, 'data-modal-autofocus': true, onClick: close }, copy.cancel),
            h(Button, { variant: 'outline', className: 'zp-memory-danger', disabled: busy,
              onClick: () => change(clear ? 'clear' : 'delete', clear ? { confirmed: true } : { id: action.id }) }, busy ? copy.saving : clear ? copy.clear : copy.confirm)) },
          error ? h('p', { className: 'zp-memory-error', role: 'alert' }, error) : null);
      }
      const nearCapacity = data && (data.usage.count > data.limits.maxMemories * 0.8 || data.usage.chars > data.limits.recallChars * 0.8);
      return h('section', { className: 'zp-memory', 'aria-label': copy.title },
        h('header', { className: 'zp-memory-header' },
          h('div', null, h('h2', null, copy.title), h('p', { className: 'zp-memory-muted' }, copy.description)),
          h(Button, { variant: 'primary', size: 'sm', disabled: !data || busy || action !== null, onClick: add }, copy.add)),
        error && action === null ? h('p', { role: 'alert', className: 'zp-memory-error' }, error) : null,
        !data ? h('p', { className: 'zp-memory-muted', role: 'status' }, copy.loading) : h('div', null,
          h('div', { className: 'zp-memory-row' },
            h('div', { className: 'zp-memory-text' }, h('span', null, copy.enabled), h('p', { className: 'zp-memory-muted' }, copy.disabled)),
            h(Switch, { checked: data.enabled, disabled: busy || action !== null, label: copy.enabled, onChange: enabled => change('enabled', { enabled }) })),
          h('div', { className: 'zp-memory-usage', role: 'status' },
            h('p', { className: 'zp-memory-muted' }, `已记 ${data.usage.count} 条`),
            nearCapacity ? h('p', { className: 'zp-memory-muted' }, `${copy.capacity}（最多 ${data.limits.maxMemories} 条）`) : null),
          data.facts.length === 0 ? h('div', { className: 'zp-memory-empty' },
            h('p', null, copy.empty), h('p', { className: 'zp-memory-muted' }, copy.example),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy || action !== null, onClick: add }, copy.add)) :
            h('ul', { className: 'zp-memory-list' }, data.facts.map(fact =>
              h('li', { key: fact.id, className: 'zp-memory-row' },
                h('div', { className: 'zp-memory-text' }, h('h3', null, fact.title), h('p', null, fact.content),
                  h('p', { className: 'zp-memory-muted', title: `${copy.created} ${new Date(fact.createdAt).toLocaleString('zh-CN')}；${copy.updated} ${new Date(fact.updatedAt).toLocaleString('zh-CN')}` },
                    `${copy[fact.kind]} · ${date(fact.updatedAt)} · ${copy[fact.source]}`)),
                h('div', { className: 'zp-memory-actions' },
                  h(Button, { size: 'sm', disabled: busy || action !== null, title: copy.edit, 'aria-label': copy.edit + '：' + fact.title, icon: h(IconEditOutlineRegular, { size: 16 }),
                    onClick: () => { setError(''); setAction({ type: 'edit', fact: { id: fact.id, kind: fact.kind, title: fact.title, content: fact.content } }); } }),
                  h(Button, { size: 'sm', disabled: busy || action !== null, title: copy.remove, 'aria-label': copy.remove + '：' + fact.title, icon: h(IconTrashOutlineRegular, { size: 16 }),
                    onClick: () => { setError(''); setAction({ type: 'delete', id: fact.id }); } }))))),
          h('footer', { className: 'zp-memory-footer' },
            data.facts.length > 0 ? h(Button, { size: 'sm', className: 'zp-memory-danger', disabled: busy || action !== null, onClick: () => { setError(''); setAction({ type: 'clear' }); } }, copy.clear) : null,
            h('p', { className: 'zp-memory-muted' }, copy.sync))),
        editor(), confirmation());
    }
    function MemoryIcon({ size }) { return h(IconPinOutlineMedium, { size }); }
    // Render only persisted result metadata, never rejected raw arguments or credentials.
    function MemoryToolCard({ phase, block }) {
      const memory = phase === 'result' ? block.meta?.memory : null;
      return h('div', { role: 'status', style: { padding: '8px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)' } },
        memory?.message || (phase === 'result' ? copy.failed : copy.pending));
    }
    return {
      name: '@crysound/memory', inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => { const sheet = document.createElement('style'); sheet.textContent = styles; document.head.appendChild(sheet); return () => sheet.remove(); });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'crysound-memory', order: 70, label: () => copy.title, locale: 'crysound-memory',
        }, MemoryPanel));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'crysound-memory' }, MemoryIcon));
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of ['crysound_memory_list', 'crysound_memory_save', 'crysound_memory_forget']) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key }, MemoryToolCard);
          }
        });
      },
    };
  },
});
