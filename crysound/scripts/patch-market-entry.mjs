// Move the existing sidebar Creator action to the market header; the native draft behavior stays intact.
/**
 * Move the pinned sidebar Creator action to the market header.
 * @param {string} text Published entry-customization browser module.
 * @returns {string} Patched module; changed entry points throw before returning.
 */
export function patchMarketEntry(text) {
  const marker = "/* CRYSOUND market creator v1 */";
  if (text.includes(marker)) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error("市场创作入口补丁未唯一命中");
    text = text.replace(needle, () => next);
  };
  const start = text.indexOf('\n\t\t\t\tbrowsable &&');
  const end = text.indexOf('\n\t\t\t] });', start);
  if (start < 0 || end < 0) throw new Error("市场更多菜单补丁未命中");
  replace(text.slice(start, end), "");
  replace('name: "sidebar.panellist.actions",', 'name: "plugins.company.create",');
  replace('ctx.slots.inject("sidebar.panellist.actions",', 'ctx.slots.inject("plugins.company.create",');
  replace('}, EntryMenuContent));\n\t\t\tctx.slots.inject("conversation.', '}, CompanyCreatorButton));\n\t\t\tctx.slots.inject("conversation.');
  replace('function apply(ctx) {', `function CompanyCreatorButton({ createPlugin, t }) {
    return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
      variant: "outline", size: "sm", onClick: createPlugin,
      "data-company-create-plugin": true, children: t("zpCreate")
    });
  }
  function apply(ctx) {
    Object.assign(zh, { zpCreate: "做一个插件" });
    Object.assign(en, { zpCreate: "Create plugin" });`);
  // Other More menus still own their folded views; empty sidebar menus have no registration.
  return marker + "\n" + text;
}
