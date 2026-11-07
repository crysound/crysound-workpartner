/* Browser module consumed directly by dsh; no build step. */
window.__ModuleLoader__.load({
  id: '@crysound/memory',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef, useId } = require('react');
    const { Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives');
    const copy = {
      title: '记忆', description: '这是你本人的记忆，只用于你自己的对话；同事看不到，也不会出现在别人的对话里。',
      sync: '网页版和桌面版各存一份，目前不同步。',
      empty: '还没有个人记忆。聊到你的工作或偏好时，伙伴会主动记下。',
      loading: '正在读取记忆…', refresh: '刷新', retry: '读取失败，请稍后刷新。',
      remove: '删除', confirm: '确认删除', cancel: '取消', saving: '正在保存…',
      note: '删除后，后续记忆召回不再包含这条。原聊天记录和既有备份会保留。',
      preference: '偏好', identity: '个人背景', project: '长期项目',
      capacity: '个人记忆接近或已达上限。伙伴会先提出合并或删除方案，得到你同意后再整理并记下新内容。',
      enabled: '使用记忆', disabled: '已关闭。新会话不再使用个人记忆，对话中也不会保存；已有条目保留。',
      clear: '清空全部', clearConfirm: '确认清空全部个人记忆', clearNote: '全部条目会被删除，无法在这里恢复。',
      add: '添加一条', listTitle: '我的记忆', edit: '编辑', save: '保存', kind: '类别', factTitle: '标题', content: '内容',
      conversation: '对话中记下', manual: '手动添加', edited: '页面修改', created: '创建于', updated: '更新于',
      pending: '正在保存个人记忆…', failed: '个人记忆操作未完成。',
    };
    const styles = `
.zp-memory{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);min-width:0}
.zp-memory h2{font-size:16px;font-weight:500;margin:0 0 8px}
.zp-memory h3{font-size:14px;font-weight:500;margin:0}
.zp-memory p{margin:8px 0}
.zp-memory-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.zp-memory-controls,.zp-memory-heading,.zp-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.zp-memory-controls{padding:16px 0}
.zp-memory-heading{justify-content:space-between;margin-top:24px}
.zp-memory-list{padding:0;margin:0;list-style:none}
.zp-memory-item{border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0}
.zp-memory-item:focus{outline:2px solid var(--dsw-alias-border-l2);outline-offset:2px}
.zp-memory-item p{overflow-wrap:anywhere}
.zp-memory-item h3{margin:4px 0}
.zp-memory-empty{padding:20px 0}
.zp-memory-editor,.zp-memory-confirm{padding:16px;margin:12px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.zp-memory fieldset{border:0;padding:0;margin:12px 0 0;min-width:0}
.zp-memory-editor label{display:block;font-size:13px}
.zp-memory-field{display:block;width:100%;box-sizing:border-box;padding:8px;margin:4px 0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.zp-memory-field:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
.zp-memory .zp-memory-danger{color:var(--dsw-alias-state-error-primary)}
.zp-memory-footer{margin-top:16px}
`;
    const buttonProps = { size: 'sm', variant: 'outline' };
    const date = value => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value));
    async function request(action, options = {}) {
      const response = await fetch('/crysound-memory/api/' + action, { ...options, cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || copy.retry);
      return value;
    }
    function MemoryPanel({ focusId } = {}) {
      const panel = useRef(null);
      const editorId = useId();
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      // Exactly one confirmation or editor is open; its revision is the displayed snapshot's.
      const [action, setAction] = useState(null);
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        const controller = new AbortController();
        request('list', { signal: controller.signal }).then(setData).catch(error => {
          if (!controller.signal.aborted) setError(error.message);
        });
        return () => controller.abort();
      }, []);
      useEffect(() => {
        if (!data || !focusId) return;
        const item = [...panel.current.querySelectorAll('[data-memory-id]')].find(item => item.dataset.memoryId === focusId);
        item?.scrollIntoView({ block: 'center' });
        item?.focus({ preventScroll: true });
      }, [data, focusId]);
      async function refresh() {
        setBusy(true); setError('');
        try { setData(await request('list')); setAction(null); }
        catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }
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
      function editor() {
        if (action?.type !== 'edit') return null;
        const draft = action.fact;
        return h('form', { className: 'zp-memory-editor', onSubmit: event => { event.preventDefault(); void change('save', draft); } },
          h('h3', null, draft.id ? copy.edit : copy.add),
          h('fieldset', { disabled: busy },
            h('label', { htmlFor: editorId + '-kind' }, copy.kind),
            h('select', { id: editorId + '-kind', className: 'zp-memory-field', value: draft.kind, onChange: event => setAction({ ...action, fact: { ...draft, kind: event.target.value } }) },
              ['preference', 'identity', 'project'].map(kind => h('option', { key: kind, value: kind }, copy[kind]))),
            h('label', { htmlFor: editorId + '-title' }, copy.factTitle),
            h('input', { id: editorId + '-title', className: 'zp-memory-field', required: true, maxLength: 40, value: draft.title, onChange: event => setAction({ ...action, fact: { ...draft, title: event.target.value } }) }),
            h('label', { htmlFor: editorId + '-content' }, copy.content),
            h('textarea', { id: editorId + '-content', required: true, maxLength: 240, rows: 3, className: 'zp-memory-field', value: draft.content, onChange: event => setAction({ ...action, fact: { ...draft, content: event.target.value } }) }),
            h('div', { className: 'zp-memory-actions' },
              h(Button, { ...buttonProps, type: 'submit' }, busy ? copy.saving : copy.save),
              h(Button, { ...buttonProps, type: 'button', onClick: () => { setAction(null); setError(''); } }, copy.cancel))));
      }
      return h('section', { ref: panel, className: 'zp-memory', 'aria-label': copy.title },
        h('style', null, styles),
        h('h2', null, copy.title),
        h('p', { className: 'zp-memory-muted' }, copy.description),
        h('p', { className: 'zp-memory-muted' }, copy.sync),
        error ? h('div', { role: 'alert' }, h('p', null, error), h(Button, { ...buttonProps, onClick: refresh, disabled: busy }, copy.refresh)) : null,
        !data ? h('p', { className: 'zp-memory-muted' }, copy.loading) : h('div', null,
          focusId && !data.facts.some(fact => fact.id === focusId) ? h('p', { role: 'status', className: 'zp-memory-muted' }, '这条记忆已被删除。你可以查看其他记忆。') : null,
          h('div', { className: 'zp-memory-controls' },
            h(Switch, { label: copy.enabled, checked: data.enabled, disabled: busy || action !== null,
              onChange: enabled => { void change('enabled', { enabled }); } }), h('span', null, copy.enabled)),
          !data.enabled ? h('p', { role: 'status', className: 'zp-memory-muted' }, copy.disabled) : null,
          h('p', { role: 'status', className: 'zp-memory-muted' }, `已用 ${data.usage.count}/${data.limits.maxMemories} 条、${data.usage.chars}/${data.limits.recallChars} 字`),
          data.usage.nearCapacity ? h('p', { className: 'zp-memory-muted' }, copy.capacity) : null,
          h('div', { className: 'zp-memory-heading' }, h('h3', null, copy.listTitle),
            h(Button, { ...buttonProps, disabled: busy, onClick: () => { setError(''); setAction({ type: 'edit', fact: { kind: 'preference', title: '', content: '' } }); } }, copy.add)),
          editor(),
          data.facts.length === 0 ? h('p', { className: 'zp-memory-empty zp-memory-muted' }, copy.empty) :
            h('ul', { className: 'zp-memory-list' }, data.facts.map(fact =>
              h('li', { key: fact.id, tabIndex: -1, 'data-memory-id': fact.id, className: 'zp-memory-item' },
                h('div', { className: 'zp-memory-muted', title: `${copy.created} ${new Date(fact.createdAt).toLocaleString('zh-CN')}；${copy.updated} ${new Date(fact.updatedAt).toLocaleString('zh-CN')}` },
                  `${copy[fact.kind]} · ${date(fact.updatedAt)} · ${copy[fact.source]}`),
                h('h3', null, fact.title), h('p', null, fact.content),
                action?.type === 'delete' && action.id === fact.id ? h('div', { className: 'zp-memory-confirm', role: 'group', 'aria-label': copy.confirm },
                  h('p', { className: 'zp-memory-muted' }, copy.note),
                  h('div', { className: 'zp-memory-actions' },
                    h(Button, { ...buttonProps, className: 'zp-memory-danger', disabled: busy, onClick: () => change('delete', { id: fact.id }) }, copy.confirm),
                    h(Button, { ...buttonProps, disabled: busy, onClick: () => setAction(null) }, copy.cancel))) : h('div', { className: 'zp-memory-actions' },
                  h(Button, { ...buttonProps, disabled: busy, onClick: () => { setError(''); setAction({ type: 'edit', fact: { id: fact.id, kind: fact.kind, title: fact.title, content: fact.content } }); }, 'aria-label': copy.edit + '：' + fact.title }, copy.edit),
                  h(Button, { ...buttonProps, variant: 'ghost', className: 'zp-memory-danger', disabled: busy, onClick: () => { setError(''); setAction({ type: 'delete', id: fact.id }); }, 'aria-label': copy.remove + '：' + fact.title }, copy.remove))))),
          data.facts.length ? h('div', { className: 'zp-memory-footer' },
            h(Button, { ...buttonProps, variant: 'ghost', className: 'zp-memory-danger', disabled: busy, onClick: () => { setError(''); setAction({ type: 'clear' }); } }, copy.clear),
            h('p', { className: 'zp-memory-muted' }, copy.note)) : null,
          action?.type === 'clear' ? h('div', { className: 'zp-memory-confirm', role: 'group', 'aria-label': copy.clearConfirm },
            h('h3', null, copy.clearConfirm), h('p', { className: 'zp-memory-muted' }, copy.clearNote),
            h('div', { className: 'zp-memory-actions' },
              h(Button, { ...buttonProps, className: 'zp-memory-danger', disabled: busy, onClick: () => change('clear', { confirmed: true }) }, copy.clearConfirm),
              h(Button, { ...buttonProps, disabled: busy, onClick: () => setAction(null) }, copy.cancel))) : null));
    }
    // The same management component is used in Settings and this fallback dialog.
    // dsh 0.2.2 has no public action for a plugin to select a Settings section.
    function MemoryDialog({ focusId, close }) {
      const dialog = useRef(null);
      useEffect(() => {
        const element = dialog.current;
        element.showModal();
        return () => element.close();
      }, []);
      return h('dialog', { ref: dialog, onCancel: event => { event.preventDefault(); close(); },
        'aria-label': copy.title, style: { background: 'var(--dsw-alias-bg-layer-2, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', width: 'min(800px, 90vw)', maxHeight: '85vh', padding: '16px' } },
        h(Button, { ...buttonProps, onClick: close }, '关闭'),
        h(MemoryPanel, { focusId }));
    }
    // Only traverse the closing Turn's indexed Tool nodes, including nested PTC calls.
    // No chat-window scan, raw arguments, or model prose can produce a receipt.
    function receipts(snapshot, turn) {
      if (!snapshot || !turn.end) return '';
      const saved = new Map();
      const visit = block => {
        const memory = block.kind === 'tool-result' && !block.isError ? block.meta?.memory : null;
        if (memory?.ok === true && memory.saved) saved.set(memory.saved.id, memory.saved);
        for (const child of block.subCalls || []) visit(child);
      };
      for (const key of snapshot.locations.getTurn(turn.turn)) {
        const node = snapshot.nodes.get(key);
        if (node?.kind === 'tool-call') visit(node.data.root);
      }
      return saved.size ? JSON.stringify([...saved.values()]) : '';
    }
    function MemoryReceipt({ turn, useMemoryChat }) {
      const value = useMemoryChat(snapshot => receipts(snapshot, turn));
      const [focusId, setFocusId] = useState(null);
      return value ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, GrayText)', lineHeight: 1.6 } },
        JSON.parse(value).map(saved => h('div', { key: saved.id },
          h('button', { type: 'button', onClick: () => setFocusId(saved.id),
            style: { border: 0, padding: 0, font: 'inherit', color: 'inherit', background: 'transparent', cursor: 'pointer', textAlign: 'start' },
            'aria-label': '查看记忆：' + saved.title }, '已记住：' + saved.title))),
        focusId ? h(MemoryDialog, { focusId, close: () => setFocusId(null) }) : null) : null;
    }
    // Render only persisted result metadata, never rejected raw arguments or credentials.
    function MemoryToolCard({ phase, block }) {
      const memory = phase === 'result' ? block.meta?.memory : null;
      if (memory?.ok === true && memory.saved) return null;
      return h('div', { role: 'status', style: { padding: '8px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' } },
        memory?.message || (phase === 'result' ? copy.failed : copy.pending));
    }
    function MemoryIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', 'aria-hidden': true, 'data-icon': 'crysound-memory-bookmark' },
        h('path', { d: 'M4 2.5h8v11l-4-2.7-4 2.7z' }));
    }
    return {
      name: '@crysound/memory', inject: ['slots', 'uiConversation'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: '@crysound/memory', order: 70,
          inject: sessionId => ({ hooks: { memoryChat: ctx.uiConversation.binding(sessionId).target('chat') } }),
        }, MemoryReceipt));
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
