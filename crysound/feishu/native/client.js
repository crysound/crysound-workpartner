/* Native settings contribution; shipped unchanged to browser and desktop. */
window.__ModuleLoader__.load({
  id: '@crysound/feishu-settings',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const { Button, Switch, IconLinkOutlineMedium } = require('@deepseek-ai/dsh-client-ui-primitives');
    const sectionId = 'crysound-feishu';
    const desktop = location.protocol === 'dsh-app:';
    const embedded = /Lark|Feishu/i.test(navigator.userAgent);
    const base = '/_zp/feishu/';
    const namespace = 'crysound.feishu';
    const en = {
      title: 'Feishu authorization', intro: 'Connect to let your partner work with Feishu as you. It will ask before sending messages or emails, submitting approvals, deleting content, or changing sharing permissions.',
      feishu: 'Feishu', project: 'Feishu Project', connect: 'Connect', reconnect: 'Reauthorize', disconnect: 'Disconnect',
      checking: 'Checking authorization…', unknown: 'Unable to verify right now', connected: 'Connected', disconnected: 'Not connected',
      disabled: 'Feishu authorization is disabled by your administrator', revoking: 'Access stopped. Remote revocation is pending; try disconnecting again.',
      returnHere: 'Return here when finished', waiting: 'Waiting for you to authorize', expired: 'Authorization expired. Connect again.',
      retry: 'Unable to process authorization. Reopen this page or return later to retry.',
      localNote: 'This connects Feishu Project on this device. Use the web app for cloud mode.',
      cloudNote: 'This connects Feishu Project in the cloud. Use the desktop app for local mode.',
      confirm: 'Disconnecting stops your partner from using this authorization. Disconnect?', cancel: 'Cancel', code: 'Authorization code:',
      authorized: 'Authorized {time}', timeUnknown: 'Authorization time not recorded',
      validDays: '{days} days remaining', validLessThanDay: 'Less than 1 day remaining',
      projectRetry: 'Unable to check Feishu Project authorization. Retrying until this attempt expires.',
    };
    /** @type {Record<keyof typeof en, string>} */
    const zh = {
      title: '飞书授权', intro: '连接后，伙伴可以用你的身份处理飞书里的内容；发消息、发邮件、提交审批、删除、改分享权限之前会先问你。',
      feishu: '飞书', project: '飞书项目', connect: '连接', reconnect: '重新授权', disconnect: '断开',
      checking: '正在检查授权…', unknown: '暂时无法核实', connected: '已连接', disconnected: '未连接',
      disabled: '管理员已停用飞书授权', revoking: '已停止使用，远端撤销待完成，请重试断开',
      returnHere: '完成后回到这里', waiting: '等待你完成授权', expired: '授权已过期，请重新连接',
      retry: '暂时无法处理授权，请重新打开页面或稍后切回重试。',
      localNote: '此处连接本机的飞书项目。云端模式请在网页版连接。',
      cloudNote: '此处连接云端的飞书项目。本机运行模式请在桌面版连接。',
      confirm: '断开后，伙伴将无法继续使用这项授权。确认断开？', cancel: '取消', code: '授权码：',
      authorized: '授权于 {time}', timeUnknown: '授权时间未记录',
      validDays: '还剩 {days} 天有效', validLessThanDay: '还剩不到 1 天有效',
      projectRetry: '暂时无法检查飞书项目授权，正在重试；本次授权到期后会停止。',
    };
    /** @typedef {(key: keyof typeof en, values?: Record<string, string | number>) => string} FeishuTranslate */
    const styles = `
.zp-feishu{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);width:100%}
.zp-feishu p,.zp-feishu h2,.zp-feishu h3{margin:0}
.zp-feishu h2{font-size:16px;font-weight:500;margin-bottom:8px}
.zp-feishu .zp-feishu-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.zp-feishu-intro{padding-bottom:16px}
.zp-feishu-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.zp-feishu-text{flex:1;min-width:0}.zp-feishu h3{font-size:14px;font-weight:500}
.zp-feishu-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.zp-feishu-feedback{margin-top:16px!important;overflow-wrap:anywhere}
@media(max-width:540px){.zp-feishu-row{align-items:flex-start;flex-direction:column;gap:12px}.zp-feishu-actions{align-self:flex-end}}
`;
    /** @param {{t: FeishuTranslate, formatTime: (date: Date) => string}} props */
    function Panel({ t, formatTime }) {
      async function api(route, method = 'GET', signal) {
        const response = await fetch(base + route, { method, credentials: 'same-origin', cache: 'no-store', signal,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : {} });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || t('retry'));
        return data;
      }
      function description(state, kind) {
        if (state === null) return t('checking');
        if (state.error) return t('unknown');
        if (state.enabled === false) return t('disabled');
        if (state.revoking) return t('revoking');
        if (!state.connected) return t('disconnected');
        if (kind === 'project') {
          const minutes = state.expiresInMinutes;
          return [t('connected'), Number.isFinite(minutes) && minutes >= 0 ? (minutes < 1440 ? t('validLessThanDay') : t('validDays', { days: Math.floor(minutes / 1440) })) : null].filter(Boolean).join(' · ');
        }
        const at = state.authorizedAt ? new Date(state.authorizedAt) : null;
        return [t('connected'), state.name, at && Number.isFinite(at.getTime()) ? t('authorized', { time: formatTime(at) }) : t('timeUnknown')].filter(Boolean).join(' · ');
      }
      const [states, setStates] = useState({ feishu: null, project: null });
      const [busy, setBusy] = useState(null);
      const [confirmation, setConfirmation] = useState(null);
      const [error, setError] = useState('');
      const [hint, setHint] = useState('');
      const [projectLink, setProjectLink] = useState(null);
      const [projectRetry, setProjectRetry] = useState(false);
      const lifecycle = useRef(null);
      useEffect(() => {
        const controller = new AbortController();
        const life = { controller, popup: null, watching: false, project: null, timer: null, generation: 0 };
        lifecycle.current = life;
        async function refresh() {
          if (controller.signal.aborted) return;
          const generation = ++life.generation; setError('');
          await Promise.all(['feishu', 'project'].map(async kind => {
            try {
              const value = await api(kind === 'feishu' ? 'status' : 'project/status', 'GET', controller.signal);
              if (!controller.signal.aborted && generation === life.generation) {
                setStates(previous => ({ ...previous, [kind]: value }));
                if (kind === 'feishu' && life.watching && value.connected && value.authorizedAt && value.authorizedAt !== life.authorizedAt) { life.watching = false; setHint(''); }
              }
            } catch (error) {
              if (!controller.signal.aborted && generation === life.generation) { setStates(previous => ({ ...previous, [kind]: { error: true } })); setError(error.message); }
            }
          }));
        }
        life.refresh = refresh;
        const focus = () => { void refresh(); };
        const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
        const message = event => {
          if (event.origin === location.origin && event.source === life.popup && event.data?.type === 'crysound.feishu.connected') {
            life.watching = false; life.popup = null; setHint(''); void refresh();
          }
        };
        const tick = async () => {
          if (controller.signal.aborted) return;
          if (life.project && Date.now() >= life.project.until) { life.project = null; sessionStorage.removeItem('zp-project-authorization'); setProjectLink(null); setHint('expired'); setProjectRetry(false); }
          if (life.project && Date.now() >= life.project.next) {
            const attempt = life.project;
            try {
              const result = await api('project/poll', 'POST', controller.signal);
              if (controller.signal.aborted) return;
              if (life.project === attempt) {
                setProjectRetry(false);
                if (result.state === 'pending') attempt.next = Date.now() + attempt.interval;
                else { life.project = null; life.watching = false; sessionStorage.removeItem('zp-project-authorization'); setProjectLink(null); setHint(result.state === 'connected' ? '' : 'expired'); await refresh(); }
              }
            } catch (error) { if (!controller.signal.aborted && life.project === attempt) { attempt.next = Date.now() + attempt.interval; setProjectRetry(true); } }
          }
          if (life.watching) {
            await refresh();
            if (life.popup?.closed || Date.now() >= life.until) { life.watching = false; life.popup = null; setHint(''); }
          }
          if (!controller.signal.aborted) life.timer = setTimeout(tick, 2000);
        };
        window.addEventListener('focus', focus); window.addEventListener('message', message);
        document.addEventListener('visibilitychange', visible);
        void refresh(); life.timer = setTimeout(tick, 2000);
        // Device-code authorization may finish while the app is away; resuming the settings page resumes polling.
        try {
          const saved = JSON.parse(sessionStorage.getItem('zp-project-authorization') || 'null');
          if (saved?.until > Date.now()) { life.project = saved; setHint('waiting'); }
        } catch (error) { setError(t('retry')); }
        return () => { if (life.project) sessionStorage.setItem('zp-project-authorization', JSON.stringify(life.project)); controller.abort(); clearTimeout(life.timer); window.removeEventListener('focus', focus); window.removeEventListener('message', message); document.removeEventListener('visibilitychange', visible); };
      }, []);
      async function action(kind, work) {
        setBusy(kind); setError(''); if (kind === 'project') setProjectRetry(false);
        try { await work(lifecycle.current); }
        catch (error) { if (!lifecycle.current.controller.signal.aborted) setError(error.message); }
        finally { if (!lifecycle.current.controller.signal.aborted) setBusy(null); }
      }
      function connect(kind) {
        // Reserve the window during the click, before the Device Code network request.
        let popup = !desktop && !embedded ? window.open('about:blank', '_blank', 'popup,width=540,height=760') : null;
        void action(kind, async life => {
          const fallback = !popup;
          life.authorizedAt = states.feishu?.authorizedAt;
          try {
            let target = base + 'connect?return=settings&display=popup';
            if (kind === 'project') {
              const result = await api('project/connect', 'POST', life.controller.signal);
              const url = new URL(result.authorization_url);
              if (url.protocol !== 'https:') throw new Error(t('retry'));
              target = url.href;
              const interval = Math.max(5, result.interval || 5) * 1000;
              life.project = { next: Date.now() + interval, interval, until: Date.now() + 600000 };
              sessionStorage.setItem('zp-project-authorization', JSON.stringify(life.project));
              setProjectLink({ url: target, code: result.user_code });
            }
            if (desktop) await api(kind === 'feishu' ? 'authorize' : 'project/authorize', 'POST', life.controller.signal);
            else if (embedded) {
              if (kind === 'project') sessionStorage.setItem('zp-project-authorization', JSON.stringify(life.project));
              else target = base + 'connect?return=settings&display=redirect';
              // A fixed marker, never an arbitrary redirect destination.
              sessionStorage.setItem('zp-feishu-return', '1'); location.assign(target); return;
            } else if (popup) popup.location.replace(target);
            else {
              popup = window.open(target, '_blank');
              setHint('returnHere');
              if (!popup) { setProjectLink({ url: target }); return; }
            }
            life.popup = popup; life.watching = true; life.until = Date.now() + 600000;
            setHint(fallback && !desktop ? 'returnHere' : 'waiting');
          } catch (error) { popup?.close(); throw error; }
        });
      }
      function disconnect(kind) {
        setConfirmation(null);
        void action(kind, async life => {
          try { await api(kind === 'feishu' ? 'disconnect' : 'project/disconnect', 'POST', life.controller.signal); }
          finally { await life.refresh(); }
          if (kind === 'project') { setProjectRetry(false); life.project = null; sessionStorage.removeItem('zp-project-authorization'); setProjectLink(null); }
        });
      }
      function row(kind) {
        const state = states[kind], connected = state?.connected, revoking = state?.revoking;
        return h('div', { className: 'zp-feishu-row', key: kind },
          h('div', { className: 'zp-feishu-text' }, h('h3', null, t(kind)), h('p', { className: 'zp-feishu-muted', role: 'status' }, description(state, kind)),
            kind === 'project' ? h('p', { className: 'zp-feishu-muted' }, desktop ? t('localNote') : t('cloudNote')) : null),
          h('div', { className: 'zp-feishu-actions' },
            confirmation === kind ? h('div', null, h('p', null, t('confirm')),
              h(Button, { size: 'sm', variant: 'outline', onClick: () => setConfirmation(null) }, t('cancel')),
              h(Button, { size: 'sm', variant: 'outline', onClick: () => disconnect(kind) }, t('disconnect'))) : h('div', { className: 'zp-feishu-actions' },
              h(Button, { size: 'sm', variant: connected ? 'outline' : 'primary', disabled: busy !== null || state === null || state?.error || state?.enabled === false || revoking, onClick: () => connect(kind) }, connected ? t('reconnect') : t('connect')),
              connected || revoking ? h(Button, { size: 'sm', variant: 'outline', disabled: busy !== null, onClick: () => setConfirmation(kind) }, t('disconnect')) : null)));
      }
      return h('section', { className: 'zp-feishu', 'aria-label': t('title') },
        h('h2', null, t('title')), h('p', { className: 'zp-feishu-muted zp-feishu-intro' }, t('intro')), row('feishu'), row('project'),
        hint ? h('p', { className: 'zp-feishu-feedback zp-feishu-muted', role: 'status' }, t(hint)) : null,
        projectLink ? h('p', { className: 'zp-feishu-feedback' }, h('a', { href: projectLink.url, target: '_blank', rel: 'noopener noreferrer' }, t('returnHere')), projectLink.code ? ' ' + t('code') + projectLink.code : null) : null,
        projectRetry ? h('p', { className: 'zp-feishu-feedback', role: 'alert' }, t('projectRetry')) : null,
        error ? h('p', { className: 'zp-feishu-feedback', role: 'alert' }, error) : null);
    }
    const dailyTitle = '每天帮我查一次';
    const dailyStyles = `
.zp-daily{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.zp-daily h2{font-size:16px;font-weight:500;margin:0 0 8px}
.zp-daily p{margin:8px 0}.zp-daily-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.zp-daily-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 0}
.zp-daily input[type=time]{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px}
.zp-daily label{display:flex;align-items:center;gap:8px}
.zp-daily-record{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
`;
    const outcomes = { quiet: '没有新事，未发消息', failed: '检查失败，今天不会自动重试', interrupted: '运行中；若意外中断，今天不会重试', pending: '摘要已生成，等待写入对话', delivered: '已放进伙伴对话', cancelled: '已关闭，取消本次提醒' };
    async function dailyApi(route, body, signal) {
      const response = await fetch('/_zp/daily-check/' + route, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '暂时无法查看每日检查，请稍后打开设置');
      return result;
    }
    function DailyPanel({ openSession }) {
      const [state, setState] = useState(null), [time, setTime] = useState('09:00');
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      const life = useRef(null);
      useEffect(() => {
        const controller = new AbortController(); life.current = controller;
        let timer;
        async function refresh() {
          try { const value = await dailyApi('status', undefined, controller.signal); if (!controller.signal.aborted) { setState(value); setTime(value.time); setError(''); } }
          catch (error) { if (!controller.signal.aborted) setError(error.message); }
        }
        void refresh();
        const focus = () => { void refresh(); };
        window.addEventListener('focus', focus);
        timer = setInterval(refresh, 60000);
        return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); };
      }, []);
      async function action(route, body) {
        setBusy(true); setError('');
        try { const result = await dailyApi(route, body, life.current.signal); if (!life.current.signal.aborted) { setState(result); setTime(result.time); } }
        catch (error) { if (!life.current.signal.aborted) setError(error.message); }
        finally { if (!life.current.signal.aborted) setBusy(false); }
      }
      function view(record) {
        openSession(record.sessionId);
        void dailyApi('read', { id: record.id }, life.current.signal).then(() => {
          if (!life.current.signal.aborted) setState(previous => ({ ...previous, records: previous.records.map(item => item.id === record.id ? { ...item, unread: false } : item) }));
        }).catch(error => { if (!life.current.signal.aborted) setError(error.message); });
      }
      return h('section', { className: 'zp-daily', 'aria-label': dailyTitle },
        h('h2', null, dailyTitle),
        h('p', { className: 'zp-daily-muted' }, '打开后，工作日会用你本人的飞书身份读取未读 @、今天和明天的日程、飞书任务。生成摘要会使用模型额度。只提醒你本人，不替你回复或操作，可以随时关闭。'),
        h('p', { className: 'zp-daily-muted' }, '没有新事不打扰；同一天最多尝试一次，失败不反复提醒。'),
        state && !state.available ? h('p', { role: 'status' }, '正在分批试用，暂未向你开放。') : null,
        state && !state.connected ? h('p', { role: 'status' }, '尚未连接飞书，检查不会运行。', h('a', { href: '/?zp-settings=feishu' }, '去连接飞书')) : null,
        h('div', { className: 'zp-daily-controls' }, h('label', null,
          h(Switch, { label: dailyTitle, checked: state?.enabled || false, disabled: busy || !state || (!state.enabled && (!state.available || !state.connected)), onChange: enabled => { void action('settings', { enabled, time }); } }), dailyTitle),
          state ? h('span', { className: 'zp-daily-muted' }, state.enabled ? '已打开' : '默认关闭') : h('span', null, '正在读取…')),
        h('div', { className: 'zp-daily-controls' }, h('label', null, '工作日 · 北京时间', h('input', { type: 'time', value: time, disabled: busy || !state, onChange: event => setTime(event.target.value) })),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy || !state || time === state.time || !time, onClick: () => { void action('settings', { enabled: state.enabled, time }); } }, '保存时间'),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy || !state?.enabled || !state.connected || !state.available, onClick: () => { void action('run', {}); } }, busy ? '正在处理…' : '现在查一次')),
        h('h3', null, '运行记录'),
        state && !state.records.length ? h('p', { className: 'zp-daily-muted' }, '还没有运行记录。周一至周五按北京时间检查；错过时间会在当天补查。') : null,
        ...(state?.records || []).map(record => h('div', { className: 'zp-daily-record', key: record.id },
          h('span', null, record.date + ' · ' + outcomes[record.outcome] + (record.reason ? '：' + record.reason : '')),
          record.outcome === 'delivered' ? h(Button, { size: 'sm', variant: 'outline', onClick: () => view(record) }, record.unread ? '● 查看新提醒' : '查看对话') : null)),
        error ? h('p', { role: 'alert' }, error) : null);
    }
    function DailyUnread({ openSession }) {
      const [record, setRecord] = useState(null);
      useEffect(() => {
        const controller = new AbortController();
        async function refresh() {
          try { const result = await dailyApi('status', undefined, controller.signal); if (!controller.signal.aborted) setRecord(result.records.find(item => item.unread) || null); }
          catch { /* Settings owns visible errors; unread polling never interrupts. */ }
        }
        void refresh(); const timer = setInterval(refresh, 60000);
        window.addEventListener('focus', refresh);
        return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); };
      }, []);
      return record ? h(Button, { size: 'sm', variant: 'outline', 'aria-label': '查看新的伙伴提醒', onClick: () => {
        openSession(record.sessionId);
        void dailyApi('read', { id: record.id }).then(() => setRecord(null)).catch(() => {});
      } }, '● 伙伴提醒') : null;
    }

    function Icon({ size }) { return h(IconLinkOutlineMedium, { size }); }
    return { name: '@crysound/feishu-settings', inject: ['slots', 'locale', 'uiWorkspace'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, 'en', en));
      ctx.effect(() => ctx.locale.register(namespace, 'zh', zh));
      const t = ctx.locale.bind(namespace);
      ctx.effect(() => { const sheet = document.createElement('style'); sheet.textContent = styles + dailyStyles; document.head.appendChild(sheet); return () => sheet.remove(); });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: sectionId, order: 65, label: () => t('title'), locale: namespace, inject: () => ({ formatTime: date => date.toLocaleString(ctx.locale.getSnapshot().active) }) }, Panel));
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: sectionId }, Icon));
      if (!desktop) {
        const injectDaily = () => ({ openSession: id => {
          ctx.uiWorkspace.openSession(id);
          const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.store)?.store;
          shell?.create().actions.close();
        } });
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'crysound-daily-check', order: 66, label: dailyTitle, inject: injectDaily }, DailyPanel));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'crysound-daily-check' }, Icon));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'crysound-daily-unread', inject: injectDaily }, DailyUnread));
      }
      ctx.effect(() => {
        const reopen = () => {
          if (new URLSearchParams(location.search).get('zp-settings') !== 'feishu' && sessionStorage.getItem('zp-feishu-return') !== '1') return;
          // The native shell deliberately returns its one shared instance from this registered store's create().
          const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.store)?.store;
          if (!shell) return;
          shell.create().actions.openSection(sectionId);
          sessionStorage.removeItem('zp-feishu-return');
          const url = new URL(location.href); url.searchParams.delete('zp-settings'); history.replaceState(null, '', url);
        };
        const stop = ctx.slots.subscribe('sidebar.settings', reopen); reopen(); return stop;
      });
    } };
  },
});
