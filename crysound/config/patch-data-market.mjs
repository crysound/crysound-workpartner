import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 此函数完整注入已发布的客户端模块；只使用原生 slot、安装对话框和新对话草稿 API。
function registerDataMarket(ctx, face, React, jsx) {
  ctx.inject(["uiWorkspace"], (dataCtx) => {
    function DataMarket(props) {
      const state = React.useSyncExternalStore(face.hooks.pluginManager.subscribe, face.hooks.pluginManager.getSnapshot);
      const [data, setData] = React.useState(null), [error, setError] = React.useState(""), [retry, setRetry] = React.useState(0);
      const [index, setIndex] = React.useState(null), [indexError, setIndexError] = React.useState(false);
      React.useEffect(() => {
        const abort = new AbortController();
        setError(""); setData(null); setIndex(null); setIndexError(false);
        const read = async (url) => {
          const response = await fetch(url, { credentials: "same-origin", signal: abort.signal });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || "数据目录暂时无法读取");
          return value;
        };
        read("/_zp/market/data.json").then(setData).catch((err) => { if (!abort.signal.aborted) setError(err.message); });
        read("/_zp/market/index.json").then(setIndex).catch((err) => { if (!abort.signal.aborted) setIndexError(true); });
        return () => abort.abort();
      }, [retry]);
      const installed = state.packages.find((pkg) => pkg.name === "@crysound/data");
      const active = installed?.enabled && installed.rows.some((row) => row.enabled);
      const published = index?.plugins?.find((pkg) => pkg.name === "@crysound/data");
      const version = published?.versions?.find((v) => !v.version.includes("-")) ?? published?.versions?.[0];
      const h = (tag, content, extra = {}) => jsx(tag, { children: content, ...extra });
      const muted = { color: "var(--text-secondary, #777)", fontSize: 13, lineHeight: 1.7 };
      const button = { border: "1px solid var(--border-color, #d7d3de)", borderRadius: 8, padding: "7px 16px", cursor: "pointer", color: "var(--text-primary, inherit)", background: "var(--surface-primary, transparent)" };
      const begin = (card) => {
        if (active) dataCtx.uiWorkspace.startSession(undefined, { prompt: card.prompt, whenDraftExists: "append" });
        else if (installed) props.openPackage("@crysound/data");
        else if (version) props.install({ spec: `@crysound/data@${version.version}`, version: version.version, title: "兆华数据", registry: data.registry });
      };
      return h("section", [
        h("header", [h("h2", "用数据，找到答案", { style: { margin: "0 0 6px", fontSize: 22 } }),
          h("p", "查搜索排名、找公司联系人、看社媒与电商。告诉工作伙伴你想了解什么。", { style: { ...muted, margin: "0 0 6px" } }),
          h("p", "由兆华数据提供 · 按实际接口费用计入个人额度", { style: { ...muted, margin: "0 0 24px" } })]),
        error ? h("div", [h("p", error, { role: "status" }), h("button", "重新加载", { style: button, onClick: () => setRetry(retry + 1) })]) : null,
        !data && !error ? h("p", "正在读取数据目录…", { role: "status" }) : null,
        data && indexError ? h("p", ["暂时无法确认插件是否已上架。", h("button", "重新加载", { style: button, onClick: () => setRetry(retry + 1) })], { role: "status", style: muted }) : null,
        data ? h("div", data.categories.map((card) => h("article", [
          h("h3", card.name, { style: { margin: "0 0 12px", fontSize: 17 } }),
          h("ul", card.examples.map((text) => h("li", text)), { style: { ...muted, paddingLeft: 18, margin: "0 0 14px" } }),
          h("p", card.platforms.slice(0, 6).map((p) => p.name).join(" · "), { style: { ...muted, fontSize: 12, minHeight: 40, margin: "0 0 12px" } }),
          h("footer", [h("span", card.priceFromUsd === null ? "价格待确认" : `$${card.priceFromUsd.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} 起`, { style: { fontSize: 14 } }),
            h("button", active ? "使用" : installed ? "启用插件" : version ? "安装后使用" : indexError ? "暂不可安装" : index ? "待插件上架" : "正在确认插件…", {
              style: button, disabled: !card.platforms.length || (!installed && !version) || state.status !== "ready",
              onClick: () => begin(card), "aria-label": `${card.name}：${active ? "使用" : "安装或启用兆华数据"}`,
            })], { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", gap: 10 } }),
        ], { key: card.id, style: { display: "flex", flexDirection: "column", border: "1px solid var(--border-color, #d7d3de)", borderRadius: 14, padding: 22, minWidth: 0 } })),
        { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 16 } }) : null,
        data ? h("p", "起步价按目录原始计价单位展示，实际费用以所选接口为准。点击“使用”只填入示例草稿，由你确认后发送。", { style: { ...muted, fontSize: 12, marginTop: 20 } }) : null,
      ], { "data-zp-data-market": "", style: { maxWidth: 1120, margin: "0 auto", padding: "24px 24px 40px", boxSizing: "border-box" } });
    }
    dataCtx.slots.inject("plugins.tab", () => dataCtx.slots.register({ name: "plugins.tab", id: "zp-data", order: 2, label: () => "数据" }, DataMarket));
  });
}

/** 对固定运行时注入数据专栏；重复执行不改变，入口变更时停止构建。 */
export function patchDataMarket(text) {
  const marker = "/* CRYSOUND data market v1 */";
  if (text.includes(marker)) return text;
  const needle = 'const face = controller.inject(configLedger, tabLedgerSource(ctx), (text) => ctx.locale.resolveText(text));';
  if (text.split(needle).length !== 2) throw new Error("数据专栏补丁未唯一命中，请核对 dsh 版本");
  return marker + "\n" + text.replace(needle, () => `${needle}\n(${registerDataMarket.toString()})(ctx, face, react, react_jsx_runtime.jsx);`);
}

export function patchDataMarketFile(file) {
  const text = fs.readFileSync(file, "utf8"), next = patchDataMarket(text);
  if (next === text) return;
  const mode = fs.statSync(file).mode;
  fs.unlinkSync(file); fs.writeFileSync(file, next, { mode });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw new Error("用法：patch-data-market.mjs <运行时 node_modules>");
  patchDataMarketFile(path.join(root, "@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js"));
}
