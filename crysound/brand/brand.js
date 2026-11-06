// 兆华工作伙伴品牌层：把首页大标题和标签页标题换成“兆华工作伙伴”，隐藏首页的预览版角标，插件的英文名换成中文名，侧栏按公司顺序排列。
(() => {
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
  const apply = () => {
    if (document.title !== NAME) document.title = NAME;
    orderSidebar();

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
