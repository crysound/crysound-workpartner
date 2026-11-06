// Deliberately small company CLI: no server, narration, sample download, sharing or asset-grabbing command.
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject, readSource, scan } from './lib/project.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `@crysound/motion — company motion films (Linux)
om new <workspace-directory> [--template company]
om templates
om scan <project>
om check <project> [--source]
om still <project> [--at 0,2,12,23] [--out file.png]
om sound <project>
om render <project> [--format mp4|gif] [--fps 24|25|30] [--workers 1|2]
Limits: one job per container, 2 render browsers, 30s film, 1920x1080 pixels, 5 minute job deadline.
Studio, voice, samples and downloads are disabled. GIF has no audio; deliver MP4 for music.`;

function parse(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (value === '--source') { flags.source = true; continue; }
    const key = value.slice(2);
    if (!['template', 'format', 'fps', 'workers', 'at', 'out'].includes(key)) throw new Error(`Unsupported option: ${value}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${value}`);
    flags[key] = argv[++i];
  }
  if (positional.length > 1) throw new Error('Pass one workspace project directory.');
  return { flags, directory: positional[0] || '.' };
}

// Canonicalize the existing ancestor too: a symlink must not redirect exports outside the workspace.
function insideWorkspace(path) {
  const target = resolve(path);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const canonical = resolve(realpathSync(existing), relative(existing, target));
  const rel = relative(realpathSync(process.cwd()), canonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Keep projects and outputs inside the current workspace.');
  return target;
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return console.log(help);
  if (['version', '--version'].includes(command)) return console.log('0.1.0');
  if (command === 'templates') return console.log('company — 24 second CRYSOUND product film, Chinese fonts and synthesized music');
  const allowed = { new: ['template'], scan: [], check: ['source'], still: ['at', 'out'], sound: [], render: ['format', 'fps', 'workers'] };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Command disabled or unknown: ${command}. Run om help.`);
  const { flags, directory } = parse(args);
  for (const key of Object.keys(flags)) if (!allowed[command].includes(key)) throw new Error(`Option --${key} is not supported by ${command}.`);
  const dir = insideWorkspace(directory);
  if (command === 'new') {
    if (directory === '.' || existsSync(dir)) throw new Error('Choose a new project directory; existing directories are never overwritten.');
    if (flags.template && flags.template !== 'company') throw new Error('Only the company template is bundled.');
    cpSync(join(root, 'templates/company'), dir, { recursive: true });
    cpSync(join(root, 'templates/blank/vendor'), join(dir, 'vendor'), { recursive: true });
    cpSync(join(root, 'templates/blank/assets/fonts'), join(dir, 'assets/fonts'), { recursive: true });
    cpSync(join(root, 'runtime/om.js'), join(dir, 'vendor/om.js'));
    return console.log(`Created ${dir}. Edit index.html, then om still and om render; files stay in the workspace.`);
  }
  const project = openProject(dir);
  const info = scan(readSource(project).html);
  if (info.width > 1920 || info.height > 1920 || info.width * info.height > 1920 * 1080) throw new Error('Company limit: at most 1920x1080 pixels (portrait allowed).');
  if (command === 'scan') return console.log(JSON.stringify(info, null, 2));
  if (command === 'check') {
    const { check, report } = await import('./lib/check.js');
    const findings = await check(project, { page: !flags.source, samples: 6 });
    console.log(report(findings, { root: dir }));
    if (findings.some((finding) => finding.level === 'error')) process.exitCode = 1;
    return;
  }
  if (command === 'still') {
    const times = String(flags.at || '0').split(',').map(Number);
    if (times.length > 8 || times.some((t) => !Number.isFinite(t) || t < 0 || t > 30)) throw new Error('Choose at most 8 still times, between 0 and 30 seconds.');
    const out = flags.out ? insideWorkspace(flags.out)
      : times.length === 1 ? join(dir, 'out/stills', `index-${times[0].toFixed(2)}s.png`) : join(dir, 'out/stills');
    if (flags.out && (times.length !== 1 || !out.endsWith('.png') || existsSync(out))) throw new Error('--out requires one time and a new .png file.');
    mkdirSync(dirname(out), { recursive: true });
    const { still } = await import('./lib/still.js');
    return console.log(await still(dir, { at: times.join(','), out }));
  }
  if (command === 'sound') {
    const { sound } = await import('./lib/sound.js');
    return console.log(await sound(project));
  }
  const format = flags.format || 'mp4';
  const fps = Number(flags.fps || 24);
  const workers = Number(flags.workers || 2);
  if (!['mp4', 'gif'].includes(format)) throw new Error('Use --format mp4 or gif.');
  if (![24, 25, 30].includes(fps)) throw new Error('Use --fps 24, 25 or 30.');
  if (![1, 2].includes(workers)) throw new Error('Use --workers 1 or 2.');
  const { sound, refreshRuntime } = await import('./lib/sound.js');
  const { render } = await import('./lib/render.js');
  refreshRuntime(project, console.error);
  // Score is generated from the same timeline that will be rendered; no silent default film.
  const prepare = format === 'gif' ? null : async (page) => {
    let changed = false;
    console.error(await sound(project, { page, onWrite: () => { changed = true; } }));
    return changed;
  };
  console.log(await render(project, { format, fps, workers, prepare, video: 'seek', onLog: console.error, onNote: console.error }));
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
