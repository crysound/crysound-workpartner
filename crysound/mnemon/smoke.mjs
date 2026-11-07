/** Exercise the native CLI through PATH with no external Node/npm or personal memory data. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const release = JSON.parse(readFileSync(new URL('./releases.json', import.meta.url), 'utf8'))

/**
 * Check version and persistence across separate CLI processes in a disposable memory store.
 * @param {string} bin - Directory containing only this target's native mnemon executable.
 * @returns {void} Throws if PATH lookup, version, storing, or recall fails.
 */
export function smokeMnemon(bin) {
  const data = mkdtempSync(join(tmpdir(), 'mnemon-smoke-'))
  // Preserve OS-required variables, but expose no other executables or user memory settings.
  const env = { PATH: resolve(bin), HOME: data, USERPROFILE: data,
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: data, TMP: data }
  const run = args => execFileSync('mnemon', args, { env, encoding: 'utf8', timeout: 30_000 })
  try {
    assert.equal(run(['--version']).trim(), `mnemon version ${release.version}`)
    run(['--data-dir', data, '--store', 'package-smoke', 'remember', 'PackageSmokeAlbatross prefers green tea', '--cat', 'fact'])
    const recalled = run(['--data-dir', data, '--store', 'package-smoke', 'recall', 'PackageSmokeAlbatross', '--basic'])
    assert.ok(recalled.includes('PackageSmokeAlbatross prefers green tea'), recalled)
    console.log(`mnemon ${release.version}: PATH, native launch, store and recall passed`)
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node smoke.mjs <bin-directory>')
  smokeMnemon(process.argv[2])
}
