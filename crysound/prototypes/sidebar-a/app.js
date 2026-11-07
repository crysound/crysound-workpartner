// Standalone review prototype. All records are fictional; no API calls or persistence.
(() => {
  const $ = (selector) => document.querySelector(selector);
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    new: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M14 4l6 6M10 14l2-6 6-6 4 4-6 6Z"/>',
    market: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><path d="M14 17h6m-3-3v6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    works: '<rect x="4" y="7" width="12" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/>',
    filter: '<path d="M4 7h10m4 0h2M4 17h2m4 0h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    more: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
    settings: '<path d="m12 3 2 2 3-.5 1 3L21 9l-1 3 1 3-3 1.5-1 3-3-.5-2 2-2-2-3 .5-1-3L3 15l1-3-1-3 3-1.5 1-3 3 .5Z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    arrow: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
    folder: '<path d="M3 7V5h7l2 2h9v13H3Z"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const hydrate = () => document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  const titles = ['季度方案汇报', '整理产品调研记录', '本周项目进展', '活动页面的设计方向', '客户问题清单', '制作产品介绍动画', '展会物料初稿', '整理会议纪要', '对比两版宣传文案', '项目报价说明', '下周工作安排', '产品演示脚本', '设计系统参考', '售后问题整理', '渠道沟通计划', '年度培训大纲', '测试报告摘要', '首页视觉探索'];
  const conversations = titles.map((title, id) => ({ id, title, workspace: id % 3 === 0 ? '产品项目' : '日常工作', archived: id === 17 }));
  let page = 'new', activeId = null, toastTimer;
  const query = new URLSearchParams(location.search);
  $('#theme').value = query.get('theme') === 'dark' ? 'dark' : 'light';
  $('#shell').value = query.get('shell') === 'desktop' ? 'desktop' : 'web';
  $('#workspace-mode').value = query.get('workspaces') === 'multi' ? 'multi' : 'single';
  const plugins = [
    { id: 'workbench', label: '我的工作台', icon: 'folder' },
    { id: 'references', label: '资料收藏', icon: 'works' },
    { id: 'notes', label: '团队笔记', icon: 'new' },
  ];
  $('#plugin-count').value = ['0', '1', '2', '3'].includes(query.get('plugins')) ? query.get('plugins') : '1';
  const installedPlugins = () => plugins.slice(0, Number($('#plugin-count').value));
  function renderPlugins() {
    const entries = installedPlugins();
    const row = p => `<button class="nav-row" data-page="${p.id}" title="${p.label}">${icon(p.icon)}<span>${p.label}</span></button>`;
    $('#plugin-entries').hidden = entries.length === 0;
    $('#plugin-entries').innerHTML = entries.length > 2 ? `<button class="nav-row" id="plugins-more" title="更多插件入口" aria-haspopup="dialog">${icon('more')}<span>更多</span></button>` : entries.map(row).join('');
    $('#plugin-menu').innerHTML = entries.map(row).join('');
  }
  document.documentElement.dataset.theme = $('#theme').value;
  if (query.has('collapsed') && !matchMedia('(max-width:700px)').matches) document.body.classList.add('collapsed');
  const toast = (text) => { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200); };
  function renderConversations() {
    let rows = conversations.filter(c => $('#archive').value === 'show' || !c.archived);
    if ($('#sort').value === 'title') rows = [...rows].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    const row = c => `<div class="conversation-row ${activeId === c.id ? 'selected' : ''}"><button class="conversation-title" data-conversation="${c.id}" title="${c.title}" ${activeId === c.id ? 'aria-current="page"' : ''}>${c.title}${c.archived ? ' · 已归档' : ''}</button><button class="row-more" data-more="${c.id}" aria-label="${c.title}的更多操作">${icon('more')}</button></div>`;
    $('#conversation-list').innerHTML = $('#workspace-mode').value === 'single' ? rows.map(row).join('') : ['日常工作', '产品项目'].map(name => `<div class="workspace-group">${icon('folder')}${name}</div>${rows.filter(c => c.workspace === name).map(row).join('')}`).join('');
  }
  function closeDrawer() { document.body.classList.remove('drawer-open'); $('.scrim').hidden = true; $('#sidebar').removeAttribute('role'); $('#sidebar').removeAttribute('aria-modal'); $('#sidebar').inert = matchMedia('(max-width:700px)').matches; }
  function openDrawer() { document.body.classList.remove('collapsed'); document.body.classList.add('drawer-open'); $('.scrim').hidden = false; $('#sidebar').inert = false; $('#sidebar').setAttribute('role', 'dialog'); $('#sidebar').setAttribute('aria-modal', 'true'); $('.search-trigger').focus(); }
  const home = () => `<section class="home"><div class="home-inner"><img class="hero-mark" src="../../brand/zp-mark.svg" alt=""><p class="eyebrow">一起，把想法变成成果</p><h1>今天，我们从哪里开始？</h1><p class="intro">整理思路，推进项目，或做一点新的尝试。</p><form class="composer"><textarea aria-label="和伙伴聊聊" placeholder="和伙伴聊聊你想做的事…"></textarea><div class="composer-footer"><span>＋</span><span>标准模式</span><span>·</span><span>自动审查</span><span>·</span><span>GPT</span><button class="send" aria-label="发送示例消息">${icon('arrow')}</button></div></form><div class="suggestions"><button data-prompt="帮我设计一页产品介绍">${icon('works')}兆华设计</button><button data-prompt="帮我做一段介绍动画">${icon('market')}兆华动画</button><button data-page="market">去市场看看 →</button></div></div></section>`;
  const works = () => `<section class="content-page"><p class="eyebrow">你的想法，你的成果</p><h1>作品</h1><p class="muted">找到做过的设计、幻灯片和动画，接着创作。</p><div class="cards"><article class="card"><div class="art-preview">CRYSOUND</div><h2>产品介绍 · 幻灯片</h2><p>今天更新 · 12 页</p><button data-preview="产品介绍">打开作品 →</button></article><article class="card"><div class="art-preview" style="letter-spacing:8px">◌ ◌ ◌</div><h2>品牌介绍 · 动画</h2><p>昨天更新 · 30 秒</p><button data-preview="品牌介绍">打开作品 →</button></article></div></section>`;
  const pluginPage = p => `<section class="content-page"><p class="eyebrow">已安装的插件</p><h1>${p.label}</h1>${p.id === 'workbench' ? `<p class="muted">个人插件示例 · 待办、日程与项目跟进</p><div class="cards"><article class="card"><span class="badge">我的飞书待办</span><h2>还有两件事，接着推进</h2><p>○ 整理产品方案初稿</p><p>○ 确认下周演示安排</p></article><article class="card"><span class="badge">本周日程</span><h2>留出时间，专注重要的事</h2><p>周一 10:00 · 项目进展讨论</p><p>周三 14:00 · 产品方案评审</p></article><article class="card"><span class="badge">项目跟进</span><h2>六个项目，三件待跟进</h2><p>产品方案 · 需求确认</p><p>演示安排 · 方案准备</p></article></div>` : `<p class="muted">插件面板示例，展示独立入口的打开位置。</p><div class="empty-box">这是“${p.label}”示例。</div>`}</section>`;
  const market = () => `<section class="content-page"><p class="eyebrow">给工作多一点可能</p><h1>市场</h1><p class="muted">找到顺手的插件和技能，交给伙伴一起完成。</p><div class="cards">${['兆华设计', '兆华动画', '兆华幻灯片', '兆华数据'].map((name, i) => `<article class="card"><span class="badge">兆华官方</span><h2>${name}</h2><p>${['把想法变成可用的设计', '让创意动起来', '从内容到完整演示', '查找、整理与分析数据'][i]}</p><button data-prompt="试试${name}">试试看 →</button></article>`).join('')}</div></section>`;
  const automation = () => `<section class="content-page"><p class="eyebrow">让日常工作，按时发生</p><h1>自动化</h1><p class="muted">这里仍然是原来的自动化任务入口。</p><article class="card"><span class="badge">已开启 · 示例</span><h2>每周项目摘要</h2><p>每周一 09:00 · 使用个人设置中的时区</p><button data-preview="每周项目摘要">查看任务 →</button></article></section>`;
  function navigate(next) {
    const fromDrawer = document.body.classList.contains('drawer-open');
    page = next; const plugin = installedPlugins().find(p => p.id === page); $('#page-label').textContent = { new: '新对话', market: '市场', automation: '自动化', works: '作品', conversation: conversations[activeId]?.title }[page] ?? plugin?.label;
    $('#page-content').innerHTML = page === 'new' ? home() : page === 'works' ? works() : page === 'market' ? market() : page === 'automation' ? automation() : plugin ? pluginPage(plugin) : `<section class="content-page"><p class="eyebrow">接着上次的想法</p><h1>${conversations[activeId].title}</h1><div class="empty-box">这是示例对话。正式开发将打开原会话，保留全部历史记录。</div></section>`;
    document.querySelectorAll('nav [data-page]').forEach(el => { const selected = el.dataset.page === page; el.classList.toggle('active', selected); if (selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    $('#plugins-more')?.classList.toggle('active', !!plugin);
    closeDrawer(); hydrate(); renderConversations();
    if (fromDrawer) { $('#page-label').tabIndex = -1; $('#page-label').focus(); }
  }
  function renderSearch() {
    const q = $('#search-input').value.trim().toLocaleLowerCase();
    const matches = conversations.filter(c => c.title.toLocaleLowerCase().includes(q));
    $('#search-results').innerHTML = matches.length ? matches.map(c => `<button data-conversation="${c.id}">${c.title}<small>${$('#workspace-mode').value === 'multi' ? c.workspace + ' · ' : ''}${c.archived ? '已归档' : '最近对话'}</small></button>`).join('') : '<p class="muted">没有找到匹配的对话，试试其他关键词。</p>';
  }
  function openSearch() { $('#search-input').value = ''; renderSearch(); $('#search-dialog').showModal(); $('#search-input').focus(); }
  function updateShell() { $('#download').hidden = $('#shell').value === 'desktop'; }
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.page) { if ($('#plugins-dialog').open) $('#plugins-dialog').close(); if (target.dataset.page === 'new') activeId = null; navigate(target.dataset.page); }
    else if (target.dataset.conversation !== undefined) { activeId = Number(target.dataset.conversation); if ($('#search-dialog').open) $('#search-dialog').close(); navigate('conversation'); }
    else if (target.dataset.more !== undefined) toast('正式开发保留原会话菜单：重命名、置顶、归档与分组。');
    else if (target.dataset.prompt) { navigate('new'); $('.composer textarea').value = target.dataset.prompt; $('.composer textarea').focus(); }
    else if (target.dataset.preview) toast(`“${target.dataset.preview}”为示例，原型不打开真实内容。`);
    else if (target.matches('.search-trigger')) openSearch();
    else if (target.matches('.collapse-trigger')) { if (matchMedia('(max-width:700px)').matches) { closeDrawer(); $('#mobile-open').focus(); } else { const collapsed = document.body.classList.toggle('collapsed'); target.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏'); target.title = collapsed ? '展开侧栏' : '收起侧栏'; } }
    else if (target.id === 'mobile-open') openDrawer();
    else if (target.matches('.scrim')) { closeDrawer(); $('#mobile-open').focus(); }
    else if (target.id === 'account-trigger') { const menu = $('.account-menu'); menu.hidden = !menu.hidden; target.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button').focus(); }
    else if (target.id === 'review-options') $('#options-dialog').showModal();
    else if (target.id === 'plugins-more') $('#plugins-dialog').showModal();
    else if (target.id === 'view-options') $('#list-dialog').showModal();
    else if (target.matches('.dialog-close')) target.closest('dialog').close();
    else if (target.id === 'download') toast('正式版将打开客户端下载页；本原型不发起下载。');
    else if (target.id === 'settings') toast('正式版保留原个人设置；原型外观请用右下角“查看方式”。');
  });
  document.addEventListener('click', event => { if (!event.target.closest('.account-area')) { $('.account-menu').hidden = true; $('#account-trigger').setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('submit', event => { if (!event.target.matches('.composer')) return; event.preventDefault(); toast('原型只演示界面，不发送消息。'); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) openSearch(); }
    if (event.key === 'Escape') { if (!$('.account-menu').hidden) { $('.account-menu').hidden = true; $('#account-trigger').setAttribute('aria-expanded', 'false'); $('#account-trigger').focus(); } if (document.body.classList.contains('drawer-open') && !document.querySelector('dialog[open]')) { closeDrawer(); $('#mobile-open').focus(); } }
    if (event.key === 'Tab' && document.body.classList.contains('drawer-open') && !document.querySelector('dialog[open]')) {
      const controls = [...$('#sidebar').querySelectorAll('button')].filter(el => el.getClientRects().length && !el.closest('[hidden]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  $('#search-input').addEventListener('input', renderSearch);
  $('#theme').addEventListener('change', () => { document.documentElement.dataset.theme = $('#theme').value; });
  $('#shell').addEventListener('change', updateShell);
  $('#plugin-count').addEventListener('change', () => { renderPlugins(); navigate(installedPlugins().some(p => p.id === page) || !plugins.some(p => p.id === page) ? page : 'new'); });
  $('#workspace-mode').addEventListener('change', renderConversations);
  for (const id of ['sort', 'archive']) $(`#${id}`).addEventListener('change', renderConversations);
  const mobile = matchMedia('(max-width:700px)');
  mobile.addEventListener('change', () => { closeDrawer(); document.body.classList.remove('collapsed'); $('.collapse-trigger').setAttribute('aria-label', '收起侧栏'); });
  if (query.get('page') === 'works') page = 'works';
  renderPlugins(); navigate(page); updateShell();
})();
