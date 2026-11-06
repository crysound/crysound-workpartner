/**
 * CRYSOUND: install the company plugins once at build time into a throwaway desktop profile and keep the result
 * as `plugin-template/` (package.json, pnpm-lock.yaml, modules/). The installer ships it under
 * `Resources/crysound/plugin-template`; the first launch copies it into the user's profile instead of downloading.
 * `modules/` stands for the profile's `node_modules`, because electron-builder drops a source directory's root `node_modules`.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const paths = resolveDesktopTargetBuildPaths()
const target = desktopTargetPlatform(resolveDesktopBuildTarget())
const nativeWindows = target.platform === 'win32' && process.platform === 'win32' && target.arch === 'x64'
if ((target.platform !== 'darwin' && !nativeWindows) || target.arch !== process.arch) {
  console.log(`plugin template: skipped for ${target.platform}-${target.arch} on ${process.platform}-${process.arch}; the app installs plugins online`)
  process.exit(0)
}

const listPath = resolve(import.meta.dirname, '../../../crysound/config/plugins.json')
const listText = readFileSync(listPath, 'utf8')
const list = JSON.parse(listText) as { plugins: { name: string; spec: string; want: string }[] }
const out = join(paths.root, 'plugin-template')
const stamp = join(out, 'plugins.json')
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === listText) {
  console.log('plugin template: up to date')
  process.exit(0)
}
rmSync(out, { recursive: true, force: true })

const electron = join(paths.electron, target.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const cli = join(paths.dsh, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const home = mkdtempSync(join(tmpdir(), 'zp-plugin-template-'))
const profile = join(home, 'profiles', 'desktop')
initProfile(profile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  ELECTRON_RUN_AS_NODE: '1',
  PATH: `${join(paths.runtime, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
}
const recorded = (): Record<string, string> =>
  (JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}

for (const plugin of list.plugins) {
  const code = await new Promise<number>((done) => {
    const child = spawn(electron, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', plugin.spec], { env: environment, stdio: 'inherit' })
    child.once('error', () => { done(1) })
    child.once('close', (status) => { done(status ?? 1) })
  })
  // pnpm 11 exits 1 after a successful add when dependency build scripts were not approved; the manifest is the truth.
  if (recorded()[plugin.name] !== plugin.want) throw new Error(`plugin template: ${plugin.name} was not installed (exit ${String(code)})`)
}

mkdirSync(out, { recursive: true })
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ dependencies: manifest.dependencies ?? {} }, null, 2)}\n`)
cpSync(join(profile, 'pnpm-lock.yaml'), join(out, 'pnpm-lock.yaml'))
cpSync(join(profile, 'node_modules'), join(out, 'modules'), { recursive: true, verbatimSymlinks: true })
// pnpm's own state files record this machine's store path; the user's pnpm writes its own on the next install.
for (const name of readdirSync(join(out, 'modules'))) {
  if (name === '.modules.yaml' || name.startsWith('.pnpm-workspace-state')) rmSync(join(out, 'modules', name), { force: true })
}
writeFileSync(stamp, listText)
rmSync(home, { recursive: true, force: true })
console.log(`plugin template: ${list.plugins.length} plugins in ${out}`)
