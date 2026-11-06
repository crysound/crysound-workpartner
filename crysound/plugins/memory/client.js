/* Browser module format consumed directly by dsh; no client build step. */
window.__ModuleLoader__.load({
  id: '@crysound/memory',
  factory(require) {
    const { createElement: h, useState, useEffect } = require('react');
    const copy = {
      title: '兆华记忆', description: '记住稳定的个人事实与偏好，新会话自动用上。',
      empty: '还没有长期记忆。聊到你的工作或偏好时，伙伴会主动记下。',
      loading: '正在读取记忆…', refresh: '刷新', retry: '读取失败，请稍后刷新。',
      remove: '删除', confirm: '确认删除', cancel: '取消', saving: '正在删除…',
      note: '删除后，后续记忆召回不再包含这条。原聊天记录和既有备份会保留。',
      preference: '偏好', identity: '个人背景', project: '长期项目',
    };
    const style = { padding: '20px', maxWidth: '760px', lineHeight: 1.6 };
    async function request(action, options = {}) {
      const response = await fetch('/crysound-memory/api/' + action, { ...options, cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || copy.retry);
      return value;
    }
    function MemoryPanel() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        const controller = new AbortController();
        request('list', { signal: controller.signal }).then(setData).catch(error => {
          if (!controller.signal.aborted) setError(error.message);
        });
        return () => controller.abort();
      }, []);
      async function refresh() {
        setBusy(true); setError('');
        try { setData(await request('list')); setPending(null); }
        catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }
      async function remove(id) {
        setBusy(true); setError('');
        try {
          setData(await request('delete', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, revision: data.revision }),
          }));
          setPending(null);
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }
      return h('section', { style, 'aria-label': copy.title },
        h('h2', null, copy.title), h('p', null, copy.description),
        h('button', { onClick: refresh, disabled: busy }, copy.refresh),
        error ? h('p', { role: 'alert' }, error) : null,
        !data ? h('p', null, copy.loading) : data.facts.length === 0 ? h('p', null, copy.empty) :
          h('ul', { style: { padding: 0, listStyle: 'none' } }, data.facts.map(fact =>
            h('li', { key: fact.id, style: { borderBottom: '1px solid var(--border, #8885)', padding: '16px 0' } },
              h('small', null, copy[fact.kind]), h('h3', { style: { margin: '4px 0' } }, fact.title),
              h('p', { style: { overflowWrap: 'anywhere' } }, fact.content),
              pending === fact.id ? h('div', null,
                h('p', null, copy.note),
                h('button', { disabled: busy, onClick: () => remove(fact.id) }, busy ? copy.saving : copy.confirm),
                h('button', { disabled: busy, onClick: () => setPending(null) }, copy.cancel)) :
                h('button', { disabled: busy, onClick: () => setPending(fact.id), 'aria-label': copy.remove + '：' + fact.title }, copy.remove),
            ))), h('p', null, copy.note));
    }
    return {
      name: '@crysound/memory', inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'crysound-memory', order: 70, label: () => copy.title, locale: 'crysound-memory',
        }, MemoryPanel));
      },
    };
  },
});
