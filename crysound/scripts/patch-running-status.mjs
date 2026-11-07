// Patch the pinned published client; leave upstream source and Session behavior untouched.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '0.2.2-rc.1';
const MARKER = '/* CRYSOUND neutral running status v1 */';
const COPY = [
  ['深度求索中', '深度求索中，用时 {duration} ···', '处理中', '处理中，用时 {duration} ···'],
  ['Deep diving', 'Deep diving for {duration} ···', 'Working', 'Working for {duration} ···'],
  ['深掘り中', '{duration} の間深く分析中 ···', '処理中', '処理中、経過時間 {duration} ···'],
  ['Razonamiento profundo', 'Razonando a fondo durante {duration} ···', 'Procesando', 'Procesando durante {duration} ···'],
  ['Réflexion approfondie', 'Réflexion approfondie depuis {duration} ···', 'Traitement en cours', 'Traitement en cours depuis {duration} ···'],
  ['Gründliches Nachdenken', 'Gründliches Nachdenken seit {duration} ···', 'In Bearbeitung', 'In Bearbeitung seit {duration} ···'],
  ['Глубокое размышление', 'Глубокое размышление в течение {duration} ···', 'Обработка', 'Обработка в течение {duration} ···'],
  ['Raciocínio profundo', 'Raciocínio profundo há {duration} ···', 'Processando', 'Processando há {duration} ···'],
];

/** Transform a recognized published ui-chat module, rejecting drift before writing. */
export function patchRunningStatusModule(text) {
  if (text.startsWith(MARKER + '\n')) return text;
  const replace = (needle, next) => {
    if (text.split(needle).length !== 2) throw new Error('Running status: expected one match for ' + needle.slice(0, 100));
    text = text.replace(needle, () => next);
  };
  for (const [oldLabel, oldDuration, label, duration] of COPY) {
    replace('"chat.deepDiving": ' + JSON.stringify(oldLabel), '"chat.deepDiving": ' + JSON.stringify(label));
    replace('"chat.deepDivingFor": ' + JSON.stringify(oldDuration), '"chat.deepDivingFor": ' + JSON.stringify(duration));
  }
  replace('--dsw-alias-label-shimmer:var(--dsw-alias-label-deep-diving-shimmer);color:var(--dsw-alias-label-deep-diving)',
    '--dsw-alias-label-shimmer:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-secondary)');

  // Remove the whale CSS, including its asset request, rather than hiding it behind an override.
  const styles = text.match(/\.([\w-]+)_runningWhaleAnimated\{display:none;position:absolute;inset:0\}.*?\.\1_runningWhaleStill\{display:none\}\}\}/g);
  if (styles?.length !== 1) throw new Error('Running status: whale styles not unique');
  const prefix = styles[0].match(/^\.([\w-]+)_/)[1];
  replace(styles[0], `.${prefix}_runningIcon:after{content:'';position:absolute;inset:2px;border:1.25px solid currentColor;border-right-color:transparent;border-radius:50%;box-sizing:border-box}@media (prefers-reduced-motion:no-preference) and (forced-colors:none){.${prefix}_runningIcon:after{animation:zp-running-spin 1.6s linear infinite}}@keyframes zp-running-spin{to{transform:rotate(1turn)}}.${prefix}_running[data-holding] .${prefix}_runningIcon:after{animation:none}`);

  const iconStart = text.indexOf('\t\tconst REST_PATH = ');
  const iconEnd = text.indexOf('\n\t\t//#endregion', iconStart);
  if (iconStart < 0 || iconEnd < iconStart || !text.slice(iconStart, iconEnd).includes('function RunningWhaleTail()')) {
    throw new Error('Running status: whale component not found');
  }
  const icon = `function RunningActivity() {
      return (0, react_jsx_runtime.jsx)("span", {
        className: ChatView_module_css_default.runningIcon,
        "aria-hidden": "true"
      });
    }`;
  replace(text.slice(iconStart, iconEnd), icon);
  replace('(0, react_jsx_runtime.jsx)(RunningWhaleTail, {})', '(0, react_jsx_runtime.jsx)(RunningActivity, {})');
  return MARKER + '\n' + text;
}

/** Patch a materialized runtime before Desktop integrity records or image publication. */
export function patchCompanyRunningStatusRuntime(root) {
  const dir = path.join(root, '@deepseek-ai/dsh-client-ui-chat');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (manifest.version !== VERSION) throw new Error('Running status: unsupported version ' + manifest.version);
  const file = path.join(dir, 'lib/client.js');
  const before = fs.readFileSync(file, 'utf8');
  const after = patchRunningStatusModule(before);
  if (before === after) return;
  const mode = fs.statSync(file).mode;
  // Break pnpm hard links, preserving the store and permissions.
  fs.unlinkSync(file);
  fs.writeFileSync(file, after, { mode });
  fs.chmodSync(file, mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: patch-running-status.mjs <runtime node_modules>');
  patchCompanyRunningStatusRuntime(process.argv[2]);
}
