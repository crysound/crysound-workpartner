/* Native settings contribution; shipped unchanged to browser and desktop. */
window.__ModuleLoader__.load({
  id: '@crysound/feishu-settings',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const { Button, Switch, Modal, IconLinkOutlineMedium } = require('@deepseek-ai/dsh-client-ui-primitives');
    const sectionId = 'crysound-feishu';
    const desktop = location.protocol === 'dsh-app:';
    const embedded = /Lark|Feishu/i.test(navigator.userAgent);
    const base = '/_zp/feishu/';
    const namespace = 'crysound.feishu';
    const en = {
      dailyTitle: "Daily check",
      dailyIntro: "On weekdays, this uses your Feishu identity to read unread @mentions, today’s and tomorrow’s calendar events, and Feishu tasks. Summaries use your model credits. Reminders are only for you; nothing is replied to or changed for you. You can turn this off at any time.",
      dailyQuietIntro: "No new items means no interruptions. At most one attempt per day, with no repeated failure reminders.",
      dailyTrial: "This feature is being tried gradually and is not available to you yet.",
      dailyDisconnected: "Feishu is not connected. Checks will not run.",
      dailyConnect: "Connect Feishu",
      dailyOn: "On",
      dailyOff: "Off by default",
      dailyLoading: "Loading…",
      dailyTime: "Weekdays · Beijing time",
      dailySaveTime: "Save time",
      dailyBusy: "Processing…",
      dailyRun: "Check now",
      dailyHistory: "Run history",
      dailyEmpty: "No runs yet. Checks run Monday through Friday in Beijing time; missed checks run later the same day.",
      dailyQuiet: "No new items; no message sent",
      dailyFailed: "Check failed; no automatic retry today",
      dailyInterrupted: "Running; no retry today if interrupted",
      dailyPending: "Summary ready; waiting to save to a conversation",
      dailyDelivered: "Saved to a partner conversation",
      dailyCancelled: "Turned off; reminder cancelled",
      dailyNew: "● View new reminder",
      dailyView: "View conversation",
      dailyUnreadLabel: "View new partner reminder",
      dailyUnread: "● Partner reminder",
      dailyReadFailure: "Feishu data could not be read completely. Check your Feishu authorization and connection.",
      dailySummaryFailure: "Summary unavailable. Check your model credits and connection.",
      dailyUnavailable: "Unable to check right now. Check the run history; there is no automatic retry today.",
      dailyInvalidSettings: "Choose an on/off state and a valid Beijing time.",
      dailyNotAvailable: "This feature is not available to you yet.",
      dailyNeedsConnection: "Connect your Feishu account in authorization settings first.",
      dailyNeedsEnabled: "Connect Feishu and turn on daily checks first.",
      dailyAlreadyAttempted: "A check was already attempted today. Try tomorrow to avoid repeated reminders.",
      dailyRunning: "A check is running. View the history shortly.",
      dailyLogin: "Sign in to your work partner first.",
      dailyRequestError: "Unable to process the request. Reopen work partner settings and try again.",
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
      reminderTitle: 'Connect Feishu to let your assistant help',
      reminderIntro: 'Your assistant uses your Feishu identity to look up messages, calendars, and documents. It will ask before sending messages, submitting approvals, or taking similar actions.',
      later: 'Later', close: 'Close',
      confirm: 'Disconnecting stops your partner from using this authorization. Disconnect?', cancel: 'Cancel', code: 'Authorization code:',
      authorized: 'Authorized {time}', timeUnknown: 'Authorization time not recorded',
      validDays: '{days} days remaining', validLessThanDay: 'Less than 1 day remaining',
      projectRetry: 'Unable to check Feishu Project authorization. Retrying until this attempt expires.',
    };
    /** @type {Record<keyof typeof en, string>} */
    const zh = {
      dailyTitle: "每天帮我查一次",
      dailyIntro: "打开后，工作日会用你本人的飞书身份读取未读 @、今天和明天的日程、飞书任务。生成摘要会使用模型额度。只提醒你本人，不替你回复或操作，可以随时关闭。",
      dailyQuietIntro: "没有新事不打扰；同一天最多尝试一次，失败不反复提醒。",
      dailyTrial: "正在分批试用，暂未向你开放。",
      dailyDisconnected: "尚未连接飞书，检查不会运行。",
      dailyConnect: "去连接飞书",
      dailyOn: "已打开",
      dailyOff: "默认关闭",
      dailyLoading: "正在读取…",
      dailyTime: "工作日 · 北京时间",
      dailySaveTime: "保存时间",
      dailyBusy: "正在处理…",
      dailyRun: "现在查一次",
      dailyHistory: "运行记录",
      dailyEmpty: "还没有运行记录。周一至周五按北京时间检查；错过时间会在当天补查。",
      dailyQuiet: "没有新事，未发消息",
      dailyFailed: "检查失败，今天不会自动重试",
      dailyInterrupted: "运行中；若意外中断，今天不会重试",
      dailyPending: "摘要已生成，等待写入对话",
      dailyDelivered: "已放进伙伴对话",
      dailyCancelled: "已关闭，取消本次提醒",
      dailyNew: "● 查看新提醒",
      dailyView: "查看对话",
      dailyUnreadLabel: "查看新的伙伴提醒",
      dailyUnread: "● 伙伴提醒",
      dailyReadFailure: "飞书数据未能完整读取，请检查授权与连接",
      dailySummaryFailure: "摘要未能生成，请检查模型额度与连接",
      dailyUnavailable: "暂时无法检查，请查看运行记录；今天不会自动重试",
      dailyInvalidSettings: "请选择开关状态和有效的北京时间",
      dailyNotAvailable: "这项功能尚未向你开放试用",
      dailyNeedsConnection: "请先在飞书授权中连接本人账号",
      dailyNeedsEnabled: "请先连接飞书并打开每天帮我查一次",
      dailyAlreadyAttempted: "今天已经查过或尝试过了，明天再查，避免重复提醒",
      dailyRunning: "正在检查，请稍后查看记录",
      dailyLogin: "请先登录工作伙伴",
      dailyRequestError: "暂时无法处理请求，请重新打开工作伙伴设置后重试。",
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
      reminderTitle: '连接飞书，让助理帮你办事',
      reminderIntro: '连接后，助理可以用你本人的飞书身份查消息、日程和文档。发消息、审批等操作会先问你。',
      later: '稍后', close: '关闭',
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
.zp-feishu-banner{display:flex;align-items:center;gap:16px;width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:color-mix(in srgb,#5733e6 7%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;-webkit-app-region:no-drag}
.zp-feishu-banner p{margin:0}.zp-feishu-banner-copy{flex:1;min-width:0}.zp-feishu-banner button{flex:none}
@media(max-width:540px){.zp-feishu-banner{align-items:flex-start;flex-direction:column;gap:8px;padding:10px 12px}.zp-feishu-banner button{align-self:flex-end}}
@media(max-width:540px){.zp-feishu-row{align-items:flex-start;flex-direction:column;gap:12px}.zp-feishu-actions{align-self:flex-end}}
`;
    function DailyReminder({ eligible, onConnect, t }) {
      const [open, setOpen] = useState(false);
      const [covered, setCovered] = useState(true);
      const attempted = useRef(false);
      useEffect(() => {
        // Onboarding owns #root.inert; other native dialogs also keep priority.
        const update = () => setCovered(Boolean(document.getElementById('root')?.inert ||
          document.querySelector('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="feishu-reminder"])')));
        const observer = new MutationObserver(update);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
        update();
        return () => observer.disconnect();
      }, []);
      useEffect(() => {
        if (!eligible) { setOpen(false); return; }
        if (covered || attempted.current) return;
        attempted.current = true;
        const now = new Date();
        const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
        try {
          if (localStorage.getItem('zp-feishu-reminder-day') === day) return;
          localStorage.setItem('zp-feishu-reminder-day', day);
        } catch (error) { /* Storage may be disabled; the ref still limits this mounted reminder to one display. */ }
        setOpen(true);
      }, [eligible, covered]);
      return h(Modal, { open: open && eligible && !covered, title: t('reminderTitle'),
        closeLabel: t('close'), description: t('reminderIntro'), shortcutModal: 'feishu-reminder',
        onClose: () => setOpen(false),
        footer: h('div', { className: 'zp-feishu-actions' },
          h(Button, { variant: 'outline', onClick: () => setOpen(false) }, t('later')),
          h(Button, { variant: 'primary', onClick: () => { setOpen(false); onConnect(); } }, t('connectFeishu'))) });
    }
    /** @param {{t: FeishuTranslate, formatTime: (date: Date) => string, banner?: boolean}} props */
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
          h(DailyReminder, { eligible: !state.connected && !state.error && !unavailable, onConnect: () => connect('feishu'), t }),
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
    const dailyStyles = `
.zp-daily{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.zp-daily h2{font-size:16px;font-weight:500;margin:0 0 8px}
.zp-daily p{margin:8px 0}.zp-daily-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.zp-daily-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 0}
.zp-daily input[type=time]{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px}
.zp-daily label{display:flex;align-items:center;gap:8px}
.zp-daily-record{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
`;
    /** @type {Record<string, keyof typeof en>} */
    const outcomes = { quiet: 'dailyQuiet', failed: 'dailyFailed', interrupted: 'dailyInterrupted', pending: 'dailyPending', delivered: 'dailyDelivered', cancelled: 'dailyCancelled' };
    /** @type {Record<string, keyof typeof en>} */
    const dailyErrors = { invalid_settings: 'dailyInvalidSettings', not_available: 'dailyNotAvailable', needs_connection: 'dailyNeedsConnection', needs_enabled: 'dailyNeedsEnabled', already_attempted: 'dailyAlreadyAttempted', running: 'dailyRunning', login: 'dailyLogin', request: 'dailyRequestError' };
    async function dailyApi(route, body, signal) {
      const response = await fetch('/_zp/daily-check/' + route, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error('Daily check request failed'), { localeKey: dailyErrors[result.code] || 'dailyUnavailable' });
      return result;
    }
    /** @param {{openSession: (id: string) => void, t: FeishuTranslate}} props */
    function DailyPanel({ openSession, t }) {
      const [state, setState] = useState(null), [time, setTime] = useState('09:00');
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      const life = useRef(null);
      useEffect(() => {
        const controller = new AbortController(); life.current = controller;
        let timer;
        async function refresh() {
          try { const value = await dailyApi('status', undefined, controller.signal); if (!controller.signal.aborted) { setState(value); setTime(value.time); setError(''); } }
          catch (error) { if (!controller.signal.aborted) setError(error.localeKey || 'dailyUnavailable'); }
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
        catch (error) { if (!life.current.signal.aborted) setError(error.localeKey || 'dailyUnavailable'); }
        finally { if (!life.current.signal.aborted) setBusy(false); }
      }
      function view(record) {
        openSession(record.sessionId);
        void dailyApi('read', { id: record.id }, life.current.signal).then(() => {
          if (!life.current.signal.aborted) setState(previous => ({ ...previous, records: previous.records.map(item => item.id === record.id ? { ...item, unread: false } : item) }));
        }).catch(error => { if (!life.current.signal.aborted) setError(error.localeKey || 'dailyUnavailable'); });
      }
      return h('section', { className: 'zp-daily', 'aria-label': t('dailyTitle') },
        h('h2', null, t('dailyTitle')),
        h('p', { className: 'zp-daily-muted' }, t('dailyIntro')),
        h('p', { className: 'zp-daily-muted' }, t('dailyQuietIntro')),
        state && !state.available ? h('p', { role: 'status' }, t('dailyTrial')) : null,
        state && !state.connected ? h('p', { role: 'status' }, t('dailyDisconnected'), h('a', { href: '/?zp-settings=feishu' }, t('dailyConnect'))) : null,
        h('div', { className: 'zp-daily-controls' }, h('label', null,
          h(Switch, { label: t('dailyTitle'), checked: state?.enabled || false, disabled: busy || !state || (!state.enabled && (!state.available || !state.connected)), onChange: enabled => { void action('settings', { enabled, time }); } }), t('dailyTitle')),
          state ? h('span', { className: 'zp-daily-muted' }, state.enabled ? t('dailyOn') : t('dailyOff')) : h('span', null, t('dailyLoading'))),
        h('div', { className: 'zp-daily-controls' }, h('label', null, t('dailyTime'), h('input', { type: 'time', value: time, disabled: busy || !state, onChange: event => setTime(event.target.value) })),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy || !state || time === state.time || !time, onClick: () => { void action('settings', { enabled: state.enabled, time }); } }, t('dailySaveTime')),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy || !state?.enabled || !state.connected || !state.available, onClick: () => { void action('run', {}); } }, busy ? t('dailyBusy') : t('dailyRun'))),
        h('h3', null, t('dailyHistory')),
        state && !state.records.length ? h('p', { className: 'zp-daily-muted' }, t('dailyEmpty')) : null,
        ...(state?.records || []).map(record => h('div', { className: 'zp-daily-record', key: record.id },
          h('span', null, record.date + ' · ' + t(outcomes[record.outcome]) + (record.reason ? ' · ' + t(record.reason === 'read' ? 'dailyReadFailure' : 'dailySummaryFailure') : '')),
          record.outcome === 'delivered' ? h(Button, { size: 'sm', variant: 'outline', onClick: () => view(record) }, record.unread ? t('dailyNew') : t('dailyView')) : null)),
        error ? h('p', { role: 'alert' }, t(error)) : null);
    }
    /** @param {{openSession: (id: string) => void, t: FeishuTranslate}} props */
    function DailyUnread({ openSession, t }) {
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
      return record ? h(Button, { size: 'sm', variant: 'outline', 'aria-label': t('dailyUnreadLabel'), onClick: () => {
        openSession(record.sessionId);
        void dailyApi('read', { id: record.id }).then(() => setRecord(null)).catch(() => {});
      } }, t('dailyUnread')) : null;
    }

    function Banner(props) { return h(Panel, { ...props, banner: true }); }
    function Icon({ size }) { return h(IconLinkOutlineMedium, { size }); }
    return { name: '@crysound/feishu-settings', inject: ['slots', 'locale', 'uiWorkspace'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, 'en', en));
      ctx.effect(() => ctx.locale.register(namespace, 'zh', zh));
      const t = ctx.locale.bind(namespace);
      ctx.effect(() => { const sheet = document.createElement('style'); sheet.textContent = styles + dailyStyles; document.head.appendChild(sheet); return () => sheet.remove(); });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: sectionId, order: 65, label: () => t('title'), locale: namespace, inject: () => ({ formatTime: date => date.toLocaleString(ctx.locale.getSnapshot().active) }) }, Panel));
      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({ name: 'conversation.header.leading', id: 'crysound-feishu-reminder', locale: namespace, inject: () => ({ formatTime: date => date.toLocaleString(ctx.locale.getSnapshot().active) }) }, Banner));
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: sectionId }, Icon));
      if (!desktop) {
        const injectDaily = () => ({ openSession: id => {
          ctx.uiWorkspace.openSession(id);
          const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.store)?.store;
          shell?.create().actions.close();
        } });
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'crysound-daily-check', order: 66, label: () => t('dailyTitle'), locale: namespace, inject: injectDaily }, DailyPanel));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'crysound-daily-check' }, Icon));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'crysound-daily-unread', locale: namespace, inject: injectDaily }, DailyUnread));
      }
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
