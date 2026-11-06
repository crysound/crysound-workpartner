// Pinned company tarball shared by the web image and desktop resources.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const FEISHU = {
  name: '@aiwayds/dsh-feishu',
  file: 'aiwayds-dsh-feishu-0.17.0-crysound.1.tgz',
  url: 'https://partner-dl.corp.crysound.com/plugins/oqheD9rnauk8nFF3/aiwayds-dsh-feishu-0.17.0-crysound.1.tgz',
  integrity: 'sha512-sGKLuHf26IqTLP4maQiXlFOi6CHRHoFZ7IcrwVoVTb2aajQ/7riAyZQnVWy792eLSAoLROKOMkuIpzusEsFl3A==',
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

/** Repair only the known remote release; pnpm removes it when replacing it with the local archive. */
export function repairLockfile(file, yaml) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  if (!before.includes(FEISHU.url)) return;
  const document = yaml.parseDocument(before);
  if (document.errors.length) throw document.errors[0];
  const packages = document.get('packages', true);
  let changed = false;
  if (yaml.isMap(packages)) for (const { value } of packages.items) {
    if (!yaml.isMap(value)) continue;
    const resolution = value.get('resolution', true);
    if (!yaml.isMap(resolution) || resolution.get('tarball') !== FEISHU.url) continue;
    if (resolution.has('integrity')) {
      if (resolution.get('integrity') !== FEISHU.integrity) throw new Error('Unexpected company Feishu lockfile checksum');
    } else {
      resolution.set('integrity', FEISHU.integrity);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(`${file}.tmp`, String(document), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

if (import.meta.main) {
  const [command, directory, cliEntry] = process.argv.slice(2);
  if (command === 'download' && directory) await downloadArchive(directory);
  else if (command === 'repair' && directory && cliEntry) {
    const files = ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'].map(file => join(directory, file));
    if (files.some(file => existsSync(file) && readFileSync(file, 'utf8').includes(FEISHU.url))) {
      let require = createRequire(cliEntry);
      for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-config-editor/package.json']) require = createRequire(require.resolve(name));
      for (const file of files) repairLockfile(file, require('yaml'));
    }
  } else throw new Error('Usage: node plugin-artifacts.mjs download <directory> | repair <profile> <dsh CLI entry>');
}
