/* Browser module consumed directly by dsh; no build step. */
window.__ModuleLoader__.load({
  id: '@crysound/memory',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef } = require('react');
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
      add: '添加一条', edit: '编辑', save: '保存', kind: '类别', factTitle: '标题', content: '内容',
      conversation: '对话中记下', manual: '手动添加', edited: '页面修改', created: '创建于', updated: '更新于',
      pending: '正在保存个人记忆…', failed: '个人记忆操作未完成。',
    };
    const style = { padding: '20px', maxWidth: '760px', lineHeight: 1.6 };
    const buttonStyle = { padding: '6px 12px', marginRight: '8px', marginBottom: '4px', border: '1px solid var(--border, #8885)', borderRadius: '6px', background: 'var(--background, transparent)', color: 'inherit', font: 'inherit', cursor: 'pointer' };
    const fieldStyle = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px', margin: '4px 0 12px', border: '1px solid var(--border, #8885)', borderRadius: '6px', background: 'transparent', color: 'inherit', font: 'inherit' };
    const date = value => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value));
    async function request(action, options = {}) {
      const response = await fetch('/crysound-memory/api/' + action, { ...options, cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || copy.retry);
      return value;
    }
    function MemoryPanel({ focusId } = {}) {
      const panel = useRef(null);
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
        return h('form', { onSubmit: event => { event.preventDefault(); void change('save', draft); } },
          h('h3', null, draft.id ? copy.edit : copy.add),
          h('fieldset', { disabled: busy, style: { border: 0, padding: 0 } },
            h('label', null, copy.kind, h('select', { value: draft.kind, onChange: event => setAction({ ...action, fact: { ...draft, kind: event.target.value } }) },
              ['preference', 'identity', 'project'].map(kind => h('option', { key: kind, value: kind }, copy[kind])))),
            h('label', { style: { display: 'block' } }, copy.factTitle,
              h('input', { style: fieldStyle, required: true, maxLength: 40, value: draft.title, onChange: event => setAction({ ...action, fact: { ...draft, title: event.target.value } }) })),
            h('label', { style: { display: 'block' } }, copy.content,
              h('textarea', { required: true, maxLength: 240, rows: 3, style: fieldStyle, value: draft.content, onChange: event => setAction({ ...action, fact: { ...draft, content: event.target.value } }) })),
            h('button', { style: buttonStyle, type: 'submit' }, busy ? copy.saving : copy.save),
            h('button', { style: buttonStyle, type: 'button', onClick: () => { setAction(null); setError(''); } }, copy.cancel)));
      }
      return h('section', { ref: panel, style, 'aria-label': copy.title },
        h('h2', null, copy.title), h('p', null, copy.description), h('p', null, copy.sync),
        h('button', { style: buttonStyle, onClick: refresh, disabled: busy }, copy.refresh),
        error ? h('p', { role: 'alert' }, error) : null,
        !data ? h('p', null, copy.loading) : h('div', null,
          focusId && !data.facts.some(fact => fact.id === focusId) ? h('p', { role: 'status' }, '这条记忆已被删除。你可以查看其他记忆。') : null,
          h('label', null, h('input', { type: 'checkbox', checked: data.enabled, disabled: busy || action !== null,
            onChange: event => change('enabled', { enabled: event.target.checked }) }), copy.enabled),
          !data.enabled ? h('p', { role: 'status' }, copy.disabled) : null,
          h('p', { role: 'status' }, `已用 ${data.usage.count}/${data.limits.maxMemories} 条、${data.usage.chars}/${data.limits.recallChars} 字。`),
          data.usage.nearCapacity ? h('p', null, copy.capacity) : null,
          h('button', { style: buttonStyle, disabled: busy, onClick: () => { setError(''); setAction({ type: 'edit', fact: { kind: 'preference', title: '', content: '' } }); } }, copy.add),
          h('button', { style: buttonStyle, disabled: busy || data.facts.length === 0, onClick: () => { setError(''); setAction({ type: 'clear' }); } }, copy.clear),
          action?.type === 'clear' ? h('div', { role: 'group', 'aria-label': copy.clearConfirm },
            h('p', null, copy.clearNote), h('p', null, copy.note),
            h('button', { style: buttonStyle, disabled: busy, onClick: () => change('clear', { confirmed: true }) }, copy.clearConfirm),
            h('button', { style: buttonStyle, disabled: busy, onClick: () => setAction(null) }, copy.cancel)) : null,
          editor(),
          data.facts.length === 0 ? h('p', null, copy.empty) :
            h('ul', { style: { padding: 0, listStyle: 'none' } }, data.facts.map(fact =>
              h('li', { key: fact.id, tabIndex: -1, 'data-memory-id': fact.id, style: { outline: fact.id === focusId ? '2px solid var(--border, #8885)' : undefined, borderBottom: '1px solid var(--border, #8885)', padding: '16px 0' } },
                h('small', { title: `${copy.created} ${new Date(fact.createdAt).toLocaleString('zh-CN')}；${copy.updated} ${new Date(fact.updatedAt).toLocaleString('zh-CN')}` },
                  `${copy[fact.kind]} · ${date(fact.updatedAt)} · ${copy[fact.source]}`),
                h('h3', { style: { margin: '4px 0' } }, fact.title), h('p', { style: { overflowWrap: 'anywhere' } }, fact.content),
                action?.type === 'delete' && action.id === fact.id ? h('div', null,
                  h('p', null, copy.note), h('button', { style: buttonStyle, disabled: busy, onClick: () => change('delete', { id: fact.id }) }, copy.confirm),
                  h('button', { style: buttonStyle, disabled: busy, onClick: () => setAction(null) }, copy.cancel)) : h('div', null,
                  h('button', { style: buttonStyle, disabled: busy, onClick: () => { setError(''); setAction({ type: 'edit', fact: { id: fact.id, kind: fact.kind, title: fact.title, content: fact.content } }); }, 'aria-label': copy.edit + '：' + fact.title }, copy.edit),
                  h('button', { style: buttonStyle, disabled: busy, onClick: () => { setError(''); setAction({ type: 'delete', id: fact.id }); }, 'aria-label': copy.remove + '：' + fact.title }, copy.remove)))))),
        h('p', null, copy.note));
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
        'aria-label': copy.title, style: { background: 'var(--dsw-alias-bg-layer-2, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', border: '1px solid var(--border, #8885)', borderRadius: '12px', width: 'min(800px, 90vw)', maxHeight: '85vh', padding: '16px' } },
        h('button', { type: 'button', style: buttonStyle, onClick: close }, '关闭'),
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
      return h('div', { role: 'status', style: { padding: '8px 12px', border: '1px solid var(--border, #8885)', borderRadius: '8px' } },
        memory?.message || (phase === 'result' ? copy.failed : copy.pending));
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
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of ['crysound_memory_list', 'crysound_memory_save', 'crysound_memory_forget']) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key }, MemoryToolCard);
          }
        });
      },
    };
  },
});
