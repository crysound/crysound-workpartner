/** Company release inputs and electron-updater metadata; importing this module has no side effects. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Validate the stable version used by the installed app and its update feed. */
export function releaseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('Release version must be a stable version, for example 0.2.3')
  }
  if (value.split('.').some(part => !Number.isSafeInteger(Number(part)))) throw new Error('Release version component is too large')
  return value
}

/** Validate a fixed public HTTPS directory without credentials or query parameters. */
export function updateDirectory(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Update URL must be a public HTTPS directory without credentials, query, or fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

/** Change only the desktop manifest version in an ephemeral CI checkout, before packaging. */
export async function prepareRelease(root, version, url) {
  releaseVersion(version)
  updateDirectory(url)
  const path = join(root, 'apps/desktop/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.version = version
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Embed the generic feed before Developer ID signing; unsigned artifacts never call this. */
export async function configureSignedApp(appPath, url) {
  const config = {
    provider: 'generic', url: updateDirectory(url), channel: 'latest',
    updaterCacheDirName: 'crysound-workpartner-updater',
  }
  // JSON is valid YAML and avoids a second YAML serialization dependency.
  await writeFile(join(appPath, 'Contents/Resources/app-update.yml'), `${JSON.stringify(config, null, 2)}\n`)
}

/** Hash the final stapled-app ZIP and write its latest-mac.yml sibling. */
export async function writeUpdateMetadata(zipPath, version) {
  releaseVersion(version)
  const name = basename(zipPath)
  if (name !== `crysound-workpartner-${version}-mac-arm64.zip`) throw new Error('ZIP filename must match the release version and mac-arm64 target')
  const info = await stat(zipPath)
  if (!info.isFile() || info.size === 0) throw new Error('Update ZIP must be a nonempty regular file')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(zipPath)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const metadata = {
    version, files: [{ url: name, sha512, size: info.size }], path: name, sha512,
  }
  const output = join(zipPath, '..', 'latest-mac.yml')
  const temporary = `${output}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, output)
  return output
}

/** Reject a feed whose version, filenames, size, or SHA-512 differs from the final archive. */
export async function verifyUpdateMetadata(zipPath, version) {
  releaseVersion(version)
  const feed = JSON.parse(await readFile(join(zipPath, '..', 'latest-mac.yml'), 'utf8'))
  const info = await stat(zipPath)
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(zipPath)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const filename = `crysound-workpartner-${version}-mac-arm64.zip`
  if (basename(zipPath) !== filename || feed.version !== version || feed.path !== filename || feed.sha512 !== sha512
    || !Array.isArray(feed.files) || feed.files.length !== 1 || feed.files[0]?.url !== filename
    || feed.files[0]?.sha512 !== sha512 || feed.files[0]?.size !== info.size || info.size === 0) {
    throw new Error('Update feed does not describe the final release ZIP')
  }
}

async function main() {
  const [command, path, versionOrUrl, url] = process.argv.slice(2)
  switch (command) {
    case 'validate': releaseVersion(path); updateDirectory(versionOrUrl); break
    case 'prepare': await prepareRelease(path, versionOrUrl, url); break
    case 'configure': await configureSignedApp(path, versionOrUrl); break
    case 'metadata': await writeUpdateMetadata(path, versionOrUrl); break
    case 'verify': await verifyUpdateMetadata(path, versionOrUrl); break
    default: throw new Error('Usage: mac-update-release.mjs prepare ROOT VERSION URL | configure APP URL | metadata ZIP VERSION')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
