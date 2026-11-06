// 兆华工作伙伴品牌层：把首页大标题和标签页标题换成“兆华工作伙伴”，隐藏首页的预览版角标，插件的英文名换成中文名，侧栏按公司顺序排列；
// 左下角账号按钮显示本人飞书头像和姓名（账号由飞书登录，不用 DeepSeek 账号），上方加“下载客户端”（桌面客户端里不显示）。
(() => {
  // Load the same optional component in both shells; keep the image if it fails.
  const petScript = document.createElement("script");
  petScript.src = new URL("./pet.js" + new URL(document.currentScript.src).search, document.currentScript.src).href;
  document.head.appendChild(petScript);
  const NAME = "兆华工作伙伴";
  const TITLES = new Set(["探索未至之境", "Into the Unknown"]);
  const BADGES = new Set(["预览版", "Preview"]);
  const RENAME = new Map([["dsh-video-editor", "视频剪辑"]]);
  // 侧栏顺序：演示文稿、视频剪辑、插件在前，其余保持原有先后排在后面。
  const SIDEBAR_ORDER = [["演示文稿", "Slides"], ["视频剪辑"], ["插件", "Plugins"]];
  const orderSidebar = () => {
    for (const nav of document.querySelectorAll("nav")) {
      const items = [...nav.children];
      const rank = (el) => SIDEBAR_ORDER.findIndex((names) => names.includes(el.textContent.trim()));
      if (!items.some((el) => rank(el) >= 0)) continue;
      items.forEach((el) => { const r = rank(el); const v = String(r >= 0 ? r : SIDEBAR_ORDER.length); if (el.style.order !== v) el.style.order = v; });
    }
  };
  const DESKTOP = location.protocol === "dsh-app:";
  let me = null;
  const avatar = () => {
    const el = document.createElement(me.avatar ? "img" : "span");
    el.className = "zp-avatar";
    if (me.avatar) { el.src = me.avatar; el.alt = ""; el.referrerPolicy = "no-referrer"; } else el.textContent = me.name.slice(-2);
    return el;
  };
  const showAccount = () => {
    const trigger = document.querySelector("button[data-signed-out]");
    if (!trigger) return;
    if (me && trigger.dataset.zpName !== me.name) {
      trigger.dataset.zpName = me.name;
      trigger.querySelectorAll(":scope > svg, :scope > .zp-avatar").forEach((n) => n.remove());
      trigger.prepend(avatar());
    }
    const label = trigger.querySelector("span:last-child");
    if (me && label && label.textContent !== me.name) label.textContent = me.name;
    if (!DESKTOP && !document.querySelector(".zp-download")) {
      const a = document.createElement("a");
      a.className = `${trigger.className} zp-download`;
      a.href = "/_zp/download";
      a.target = "_blank";
      a.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10"/></svg><span>下载客户端</span>';
      (trigger.closest(".yHnPSG_anchor") || trigger).before(a);
    }
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      const text = item.querySelector("span:last-child");
      if (!me || !text || !["Sign in", "登录"].includes(text.textContent.trim())) continue;
      text.textContent = me.name;
      item.disabled = true;
      item.classList.add("zp-account-item");
    }
  };
  fetch("/_zp/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.name) { me = j; showAccount(); } }).catch(() => {});

  const apply = () => {
    if (document.title !== NAME) document.title = NAME;
    orderSidebar();
    showAccount();

    const hero = document.querySelector('[data-slot="conversation.hero.brand.mark"]');
    let scope = hero;
    for (let i = 0; scope && i < 3; i++) scope = scope.parentElement;
    if (!scope) return;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.data.trim();
      if (TITLES.has(t)) n.data = NAME;
      else if (BADGES.has(t) && n.parentElement) n.parentElement.style.display = "none";
    }
  };
  const rename = (root) => {
    if (root.nodeType === Node.TEXT_NODE) { const to = RENAME.get(root.data.trim()); if (to) root.data = to; return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const to = RENAME.get(n.data.trim()); if (to) n.data = to; }
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") rename(r.target);
      else r.addedNodes.forEach(rename);
    }
    apply();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  rename(document.documentElement);
  apply();
})();
