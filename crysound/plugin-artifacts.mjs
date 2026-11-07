// Pinned company tarball shared by the web image and desktop resources.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const FEISHU = {
  name: '@aiwayds/dsh-feishu',
  file: 'aiwayds-dsh-feishu-0.17.0-crysound.7.tgz',
  url: 'https://partner-dl.corp.crysound.com/plugins/GdIDOj8kNqAK1mrp/aiwayds-dsh-feishu-0.17.0-crysound.7.tgz',
  integrity: 'sha512-ZsP7V36CFEYJN1n53XU2ySKz0KNp2FBKE+7XjM1WRfeu7CUACUYYwiv3npP9bNB1WbPbQVGX1stP2Fab0I0/6Q==',
};
export const WEB_SPEC = `file:/opt/company-plugins/${FEISHU.file}`;
export const DESKTOP_WANT = `file:company-plugins/${FEISHU.file}`;

/** Registry packages in the company scope need the signed-in desktop token; local archives can be bundled. */
export function isMarketPlugin(plugin) {
  return plugin.name.startsWith('@crysound/') && (plugin.spec === plugin.name || plugin.spec.startsWith(`${plugin.name}@`));
}

/** Reject a modified or incomplete release archive before it is used. */
export function verifyArchive(bytes) {
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== FEISHU.integrity) {
    throw new Error('Company Feishu archive checksum mismatch');
  }
}

/** Download once during packaging; a matching existing archive is reused. */
export async function downloadArchive(directory) {
  const file = join(directory, FEISHU.file);
  if (existsSync(file)) { verifyArchive(readFileSync(file)); return; }
  const response = await fetch(FEISHU.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Company Feishu archive download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArchive(bytes);
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${file}.tmp`, bytes);
  renameSync(`${file}.tmp`, file);
}

/** Keep desktop's tarball in the profile, independent of install location and build machine. */
export function desktopPlugins(plugins, artifacts, profile) {
  return plugins.map(plugin => {
    if (plugin.name !== FEISHU.name || ![WEB_SPEC, FEISHU.url].includes(plugin.spec)) return plugin;
    const bytes = readFileSync(join(artifacts, FEISHU.file));
    verifyArchive(bytes);
    const directory = join(profile, 'company-plugins');
    const target = join(directory, FEISHU.file);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      writeFileSync(`${target}.tmp`, bytes);
      renameSync(`${target}.tmp`, target);
    }
    return { ...plugin, spec: DESKTOP_WANT, want: DESKTOP_WANT };
  });
}

/** Recognize company release archives, including peer-qualified pnpm package IDs. */
function isOldRelease(value, want) {
  if (typeof value !== 'string') return false;
  const spec = value.replace(`${FEISHU.name}@`, '').split('(')[0];
  if (spec === want) return false;
  if (/^file:(?:\/opt\/company-plugins\/|company-plugins\/)aiwayds-dsh-feishu-[^/]+\.tgz$/.test(spec)) return true;
  try {
    const url = new URL(spec);
    return url.origin === new URL(FEISHU.url).origin && /^\/plugins\/[^/]+\/aiwayds-dsh-feishu-[^/]+\.tgz$/.test(url.pathname);
  } catch { return false; }
}

/**
 * Forget superseded company Feishu install records before pnpm add, with the Host stopped.
 * Parse every file before writing; keep other plugins, installed files and all dsh configuration.
 * Locks are written before the manifest so interrupted preparation still retries the install.
 */
export function repairProfile(profile, yaml, want = WEB_SPEC) {
  if (!want) return;
  const updates = [];
  for (const relative of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
    const file = join(profile, relative);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const document = yaml.parseDocument(before);
    if (document.errors.length) throw document.errors[0];
    let changed = false;
    const importers = document.get('importers', true);
    if (yaml.isMap(importers)) for (const { value: importer } of importers.items) {
      if (!yaml.isMap(importer)) continue;
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const dependencies = importer.get(section, true);
        if (!yaml.isMap(dependencies)) continue;
        const entry = dependencies.get(FEISHU.name, true);
        if (yaml.isMap(entry) && [entry.get('specifier'), entry.get('version')].some(value => isOldRelease(value, want))) {
          dependencies.delete(FEISHU.name);
          changed = true;
        }
      }
    }
    for (const section of ['packages', 'snapshots']) {
      const entries = document.get(section, true);
      if (!yaml.isMap(entries)) continue;
      for (const { key, value } of [...entries.items]) {
        const id = String(key);
        const tarball = yaml.isMap(value) ? value.getIn(['resolution', 'tarball']) : undefined;
        if (isOldRelease(id, want) || isOldRelease(tarball, want)) {
          entries.delete(key);
          changed = true;
        }
      }
    }
    if (changed) updates.push([file, String(document)]);
  }
  const manifestFile = join(profile, 'package.json');
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    let changed = false;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (isOldRelease(manifest[section]?.[FEISHU.name], want)) {
        delete manifest[section][FEISHU.name];
        changed = true;
      }
    }
    if (changed) updates.push([manifestFile, `${JSON.stringify(manifest, null, 2)}\n`]);
  }
  for (const [file, text] of updates) {
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

if (import.meta.main) {
  const [command, directory, cliEntry, want = WEB_SPEC] = process.argv.slice(2);
  if (command === 'download' && directory) await downloadArchive(directory);
  else if (command === 'repair' && directory && cliEntry) {
    const files = ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'].map(file => join(directory, file));
    if (files.some(file => existsSync(file) && readFileSync(file, 'utf8').includes('aiwayds-dsh-feishu-'))) {
      let require = createRequire(cliEntry);
      for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
      repairProfile(directory, require('yaml'), want);
    }
  } else throw new Error('Usage: node plugin-artifacts.mjs download <directory> | repair <profile> <dsh CLI entry> [target spec]');
}
