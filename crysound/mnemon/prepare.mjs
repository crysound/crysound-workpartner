/** Download the pinned npm native payload without running npm or package scripts. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const release = JSON.parse(readFileSync(new URL('./releases.json', import.meta.url), 'utf8'))

/**
 * Prepare one target's native executable, package metadata, and license in a private build directory.
 * @param {string} destination - Target-specific output directory owned by this build.
 * @param {string} platform - Node platform of the artifact, not necessarily the build host.
 * @param {string} arch - Node architecture of the artifact.
 * @returns {Promise<void>} Resolves after integrity and package identity checks succeed.
 */
export async function prepareMnemon(destination, platform, arch) {
  const target = `${platform}-${arch}`
  const integrity = release.integrities[target]
  if (integrity === undefined) throw new Error(`Unsupported mnemon target: ${target}`)
  const version = `${release.version}-${target}`
  const response = await fetch(`https://registry.npmjs.org/@mnemon-dev/mnemon/-/mnemon-${version}.tgz`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`mnemon download failed: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== integrity) {
    throw new Error(`mnemon integrity mismatch: ${target}`)
  }
  const output = resolve(destination)
  mkdirSync(dirname(output), { recursive: true })
  const temporary = mkdtempSync(join(dirname(output), '.mnemon-'))
  try {
    const file = join(temporary, 'payload.tgz')
    writeFileSync(file, archive)
    execFileSync('tar', ['-xzf', file, '-C', temporary], { stdio: 'pipe' })
    const payload = join(temporary, 'package')
    const manifest = JSON.parse(readFileSync(join(payload, 'package.json'), 'utf8'))
    if (manifest.name !== '@mnemon-dev/mnemon' || manifest.version !== version
      || manifest.os?.[0] !== platform || manifest.cpu?.[0] !== arch) {
      throw new Error(`mnemon package identity mismatch: ${target}`)
    }
    const binary = join(payload, 'bin', platform === 'win32' ? 'mnemon.exe' : 'mnemon')
    chmodSync(binary, 0o755)
    // Build outputs are readable to the unprivileged container user and packaged app.
    chmodSync(payload, 0o755)
    chmodSync(join(payload, 'bin'), 0o755)
    rmSync(output, { recursive: true, force: true })
    renameSync(payload, output)
    console.log(`mnemon ${release.version}: prepared ${target}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destination, platform = process.platform, arch = process.arch] = process.argv.slice(2)
  if (!destination) throw new Error('Usage: node prepare.mjs <destination> [platform] [arch]')
  await prepareMnemon(destination, platform, arch)
}
