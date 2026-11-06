// 复用原生市场卡片，只为已安装的兆华数据提供“使用”；不注册标签或目录页。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 点使用只打开草稿；插件停用或状态读取失败时进入原生设置，不安装、不自动发送。 */
export async function useData(ctx, openSettings) {
  try {
    const [bundles, plugins] = await Promise.all([
      ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins(),
    ]);
    const bundle = bundles.find((item) => item.name === "@crysound/data");
    const active = bundle?.enabled && !bundle.error && bundle.rows.some((row) =>
      plugins.some((plugin) => plugin.entryId === row.entryId && plugin.enabled));
    if (!active) return openSettings();
    ctx.uiWorkspace.startSession(undefined, {
      prompt: "使用兆华数据。请先列出插件内的七类数据和示例提问，供我选择；先不要发起付费查询。",
      whenDraftExists: "append",
    });
  } catch (error) {
    // Host 断开或插件状态未知时交回原生设置，不能假定插件已启用。
    openSettings();
  }
}

/** 修补已发布的原生市场卡片；入口变化则失败，重复执行不改变结果。 */
export function patchDataUse(text) {
  const marker = "/* CRYSOUND data use v1 */";
  if (text.includes(marker)) return text;
  const replace = (needle, value) => {
    if (text.split(needle).length !== 2) throw new Error("数据使用按钮补丁未唯一命中，请核对 dsh 版本");
    text = text.replace(needle, () => value);
  };
  replace('"remote.pluginRegistryProbe"\n', '"remote.pluginRegistryProbe", "remote.pluginManager", "uiWorkspace"\n');
  replace('ctx.effect(() => ctx.locale.register(NS, {',
    'Object.assign(zh, { zpUseData: "使用" }); Object.assign(en, { zpUseData: "Use" });\nctx.effect(() => ctx.locale.register(NS, {');
  const face = 'const face = controller.face((text) => ctx.locale.resolveText(text));';
  replace(face, `${face}\nface.useCompanyData = (openSettings) => (${useData.toString()})(ctx, openSettings);`);
  replace('const { t, install, openPackage } = props;',
    'const { t, install } = props;\nconst openPackage = (name) => name === "@crysound/data" ? props.useCompanyData(() => props.openPackage(name)) : props.openPackage(name);');
  replace('"aria-label": t("openInstalled", { name: title }),',
    '"aria-label": entry.name === "@crysound/data" ? t("zpUseData") : t("openInstalled", { name: title }),');
  replace('children: t(status === "update-available" ? "statusUpdate" : status === "provided" ? "statusProvided" : "statusInstalled")',
    'children: entry.name === "@crysound/data" ? t("zpUseData") : t(status === "update-available" ? "statusUpdate" : status === "provided" ? "statusProvided" : "statusInstalled")');
  return marker + "\n" + text;
}

/** 保留文件权限并断开包管理器硬链接，只改目标副本。 */
export function patchDataUseFile(file) {
  const text = fs.readFileSync(file, "utf8"), next = patchDataUse(text);
  if (text === next) return;
  const mode = fs.statSync(file).mode;
  fs.unlinkSync(file);
  fs.writeFileSync(file, next, { mode });
  fs.chmodSync(file, mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw new Error("用法：patch-data-use.mjs <运行时 node_modules>");
  patchDataUseFile(path.join(root, "@deepseek-ai/dsh-client-ui-plugin-market/lib/client.js"));
}
