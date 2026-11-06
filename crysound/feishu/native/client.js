/* Native settings contribution; shipped unchanged to browser and desktop. */
window.__ModuleLoader__.load({
  id: '@crysound/feishu-settings',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const { Button, IconLinkOutlineMedium } = require('@deepseek-ai/dsh-client-ui-primitives');
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
      banner: 'Feishu is not connected. Your assistant cannot look up messages, calendars, or documents for you.', connectFeishu: 'Connect Feishu',
      checkAgain: 'Check again', statusError: 'Unable to verify the Feishu connection. Please check again.',
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
      banner: '还没连接飞书，助理无法替你查消息、日程、文档。', connectFeishu: '连接飞书',
      checkAgain: '重新检查', statusError: '暂时无法核实飞书连接，请重新检查。',
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
[data-conversation-header-leading]:has(.zp-feishu-banner){grid-column:1/-1;grid-row:2;min-width:0;padding:8px 0 10px}
.zp-feishu-banner{display:flex;align-items:center;gap:16px;width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;border-inline-start:3px solid #5733e6;background:color-mix(in srgb,#5733e6 7%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;-webkit-app-region:no-drag}
.zp-feishu-banner p{margin:0}.zp-feishu-banner-copy{flex:1;min-width:0}.zp-feishu-banner button{flex:none}
@media(max-width:540px){.zp-feishu-banner{align-items:flex-start;flex-direction:column;gap:8px;padding:10px 12px}.zp-feishu-banner button{align-self:flex-end}}
@media(max-width:540px){.zp-feishu-row{align-items:flex-start;flex-direction:column;gap:12px}.zp-feishu-actions{align-self:flex-end}}
`;
    /** @param {{t: FeishuTranslate, formatTime: (date: Date) => string}} props */
    function Panel({ t, formatTime, banner = false }) {
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
        const life = { controller, popup: null, watching: false, project: null, timer: null, generation: 0, nextRefresh: Date.now() + 60000 };
        lifecycle.current = life;
        async function refresh() {
          if (controller.signal.aborted) return;
          const generation = ++life.generation; setError('');
          await Promise.all((banner ? ['feishu'] : ['feishu', 'project']).map(async kind => {
            try {
              const value = await api(kind === 'feishu' ? 'status' : 'project/status', 'GET', controller.signal);
              if (!controller.signal.aborted && generation === life.generation) {
                setStates(previous => ({ ...previous, [kind]: value }));
                if (kind === 'feishu' && life.watching && value.connected && (banner || (value.authorizedAt && value.authorizedAt !== life.authorizedAt))) { life.watching = false; setHint(''); }
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
          if (life.watching || (banner && document.visibilityState === 'visible' && Date.now() >= life.nextRefresh)) {
            life.nextRefresh = Date.now() + 60000;
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
          const saved = banner ? null : JSON.parse(sessionStorage.getItem('zp-project-authorization') || 'null');
          if (saved?.until > Date.now()) { life.project = saved; setHint('waiting'); }
        } catch (error) { setError(t('retry')); }
        return () => { if (life.project) sessionStorage.setItem('zp-project-authorization', JSON.stringify(life.project)); controller.abort(); clearTimeout(life.timer); window.removeEventListener('focus', focus); window.removeEventListener('message', message); document.removeEventListener('visibilitychange', visible); };
      }, [banner]);
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
            if (kind === 'feishu' && !desktop && !popup) {
              if (banner) sessionStorage.setItem('zp-feishu-home-return', '1');
              sessionStorage.setItem('zp-feishu-return', '1');
              location.assign(base + 'connect?return=settings&display=redirect'); return;
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
      if (banner) {
        const state = states.feishu;
        if (state === null || (state.connected && !state.revoking && state.enabled !== false)) return null;
        const unavailable = state.enabled === false || state.revoking;
        return h('aside', { className: 'zp-feishu-banner', 'aria-label': t('title') },
          h('div', { className: 'zp-feishu-banner-copy', role: 'status' },
            h('p', null, state.error ? t('statusError') : unavailable ? description(state, 'feishu') : t('banner')),
            hint ? h('p', null, t(hint)) : null, error ? h('p', { role: 'alert' }, error) : null),
          h(Button, { size: 'sm', variant: 'primary', disabled: busy !== null || unavailable,
            onClick: () => state.error ? lifecycle.current.refresh() : connect('feishu') }, state.error ? t('checkAgain') : t('connectFeishu')));
      }
      return h('section', { className: 'zp-feishu', 'aria-label': t('title') },
        h('h2', null, t('title')), h('p', { className: 'zp-feishu-muted zp-feishu-intro' }, t('intro')), row('feishu'), row('project'),
        hint ? h('p', { className: 'zp-feishu-feedback zp-feishu-muted', role: 'status' }, t(hint)) : null,
        projectLink ? h('p', { className: 'zp-feishu-feedback' }, h('a', { href: projectLink.url, target: '_blank', rel: 'noopener noreferrer' }, t('returnHere')), projectLink.code ? ' ' + t('code') + projectLink.code : null) : null,
        projectRetry ? h('p', { className: 'zp-feishu-feedback', role: 'alert' }, t('projectRetry')) : null,
        error ? h('p', { className: 'zp-feishu-feedback', role: 'alert' }, error) : null);
    }
    function Banner(props) { return h(Panel, { ...props, banner: true }); }
    function Icon({ size }) { return h(IconLinkOutlineMedium, { size }); }
    return { name: '@crysound/feishu-settings', inject: ['slots', 'locale'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, 'en', en));
      ctx.effect(() => ctx.locale.register(namespace, 'zh', zh));
      const t = ctx.locale.bind(namespace);
      ctx.effect(() => { const sheet = document.createElement('style'); sheet.textContent = styles; document.head.appendChild(sheet); return () => sheet.remove(); });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: sectionId, order: 65, label: () => t('title'), locale: namespace, inject: () => ({ formatTime: date => date.toLocaleString(ctx.locale.getSnapshot().active) }) }, Panel));
      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({ name: 'conversation.header.leading', id: 'crysound-feishu-reminder', locale: namespace, inject: () => ({ formatTime: date => date.toLocaleString(ctx.locale.getSnapshot().active) }) }, Banner));
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: sectionId }, Icon));
      ctx.effect(() => {
        const reopen = () => {
          if (new URLSearchParams(location.search).get('zp-settings') !== 'feishu' && sessionStorage.getItem('zp-feishu-return') !== '1') return;
          if (sessionStorage.getItem('zp-feishu-home-return') === '1') {
            sessionStorage.removeItem('zp-feishu-home-return'); sessionStorage.removeItem('zp-feishu-return');
            const url = new URL(location.href); url.searchParams.delete('zp-settings'); history.replaceState(null, '', url); return;
          }
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
