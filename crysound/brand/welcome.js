// 新开通的人第一次进来时（网关带 ?zp-welcome=1）：新建会话，自动启动飞书接入向导。
(() => {
  const url = new URL(location.href);
  if (!url.searchParams.has("zp-welcome")) return;
  url.searchParams.delete("zp-welcome");
  history.replaceState(null, "", url);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(250)) { const el = fn(); if (el) return el; } return null; };
  const enter = (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  (async () => {
    const input = await find(() => [...document.querySelectorAll("[contenteditable=true],textarea")].find((e) => e.offsetParent), 30000);
    if (!input) return;
    input.focus();
    document.execCommand("insertText", false, "/feishu-onboard");
    await find(() => [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "feishu-onboard" && e.offsetParent), 5000);
    enter(input);
    await wait(500);
    if ((input.innerText || input.value || "").trim()) enter(input);
  })();
})();
