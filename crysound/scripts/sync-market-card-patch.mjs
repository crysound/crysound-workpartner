// Keep the standalone company startup script self-contained when downloaded by an older desktop.
import fs from 'node:fs';
const configFile = new URL('../config/plugins.json',import.meta.url);
const config = JSON.parse(fs.readFileSync(configFile,'utf8'));
let configText = fs.readFileSync(configFile,'utf8');
for (const [name,row] of Object.entries(config.officialPlugins)) {
  const svg = fs.readFileSync(new URL('../brand/market-icons/'+name.split('/').pop()+'.svg',import.meta.url),'utf8').trim();
  const icon = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  configText = configText.replace(JSON.stringify(row.icon),JSON.stringify(icon));
}
if (process.argv.includes('--check')) {
  if(configText !== fs.readFileSync(configFile,'utf8')) throw new Error('Regenerate official icon data from SVG sources');
} else fs.writeFileSync(configFile,configText);
const { patchThirdPartyCards, marketCardHelpers, marketCardCss } = await import('./patch-market-cards.mjs');
const file = new URL('../config/plugin-patches.mjs', import.meta.url);
const begin = '// BEGIN generated market cards';
const end = '// END generated market cards';
const source = fs.readFileSync(file, 'utf8');
const fn = patchThirdPartyCards.toString().replace('marketCardHelpers()', () => JSON.stringify(marketCardHelpers())).replace('marketCardCss +', () => JSON.stringify(marketCardCss) + ' +');
const generated = begin + '\n' + fn + '\n' + end;
const next = source.includes(begin) ? source.slice(0, source.indexOf(begin)) + generated + source.slice(source.indexOf(end) + end.length) : source.replace('// A DOM event', generated + '\n\n// A DOM event');
if (process.argv.includes('--check')) {
  if (source !== next) throw new Error('Run sync-market-card-patch.mjs after changing market helpers, copy or artwork');
} else if (source !== next) fs.writeFileSync(file, next);
