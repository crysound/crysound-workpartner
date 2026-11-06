/** CRYSOUND WorkPartner: company plugins, plugin patches, and default configuration for the desktop profile. */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Inputs of one preparation run; everything is a plain path so the run can also be smoke-tested outside Electron. */
export interface WorkspaceOptions {
  /** Company assets directory (`config/plugins.json`, `config/partner.patch.yml`, `config/plugin-patches.mjs`). */
  readonly assets: string
  /** Desktop profile directory, already initialized. */
  readonly profile: string
  /** Bundled dsh command entry (the desktop Host's cli.js). */
  readonly cliEntry: string
  /** Electron executable, run in Node mode. */
  readonly execPath: string
  /** Directory holding the once-only markers. */
  readonly userData: string
  /** Environment the Host will run with; the installer sees the same home and PATH. */
  readonly environment: NodeJS.ProcessEnv
  /** Called once, before the first step that can take long (template copy or online install); the app shows its loading window here. */
  readonly onBusy?: () => void
  /** Time bounds in milliseconds; the defaults apply in the app. */
  readonly limits?: Partial<WorkspaceLimits>
}

/** Time bounds of one preparation run, in milliseconds. */
export interface WorkspaceLimits {
  /** One online `plugin add`. */
  readonly install: number
  /** All online installs of one run together; the rest are skipped and retried at the next launch. */
  readonly installTotal: number
  /** Copying the bundled plugin template. */
  readonly copy: number
  /** Running the plugin patches. */
  readonly patch: number
}

const DEFAULT_LIMITS: WorkspaceLimits = { install: 120_000, installTotal: 180_000, copy: 120_000, patch: 60_000 }

/** What a preparation run could not finish. */
export interface WorkspaceResult {
  /** Company plugins still not recorded in the profile; the next launch retries them. */
  readonly missing: readonly string[]
}

interface PluginList {
  readonly plugins: readonly { readonly name: string; readonly spec: string; readonly want: string }[]
  readonly defaultBundles: readonly string[]
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/**
 * Stop a child and everything it started. POSIX children run in their own process group, so one signal reaches pnpm and its workers.
 * @param child - The running child.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', () => {})
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

/**
 * Run a command to completion, or kill it and its descendants after `timeoutMs`.
 * @param command - Executable.
 * @param args - Arguments.
 * @param environment - Child environment.
 * @param timeoutMs - Longest time the command may run.
 * @returns The exit code, or 1 when the command failed to start or was killed on timeout.
 */
export function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try { child = spawn(command, args, { env: environment, stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' }) }
    catch { resolve(1); return }
    const timer = setTimeout(() => {
      console.warn(`CRYSOUND: ${command} ran longer than ${String(timeoutMs)} ms; stopping it`)
      killTree(child)
      resolve(1)
    }, timeoutMs)
    child.once('error', () => { clearTimeout(timer); resolve(1) })
    child.once('close', (code) => { clearTimeout(timer); resolve(code ?? 1) })
  })
}

/**
 * Copy the plugins pre-installed at build time (`assets/plugin-template`) into a profile that has none of them.
 * `node_modules` is copied beside its final place and renamed, and the manifest is written last, so an interrupted
 * copy leaves nothing recorded and the online install below takes over.
 * @param assets - Company assets directory.
 * @param profile - Desktop profile directory.
 * @param list - Company plugin list.
 * @param limits - Time bounds.
 * @param onBusy - Called before the copy starts.
 * @returns Whether the template was applied.
 */
async function applyPluginTemplate(assets: string, profile: string, list: PluginList, limits: WorkspaceLimits, onBusy: () => void): Promise<boolean> {
  const template = join(assets, 'plugin-template')
  if (!existsSync(join(template, 'package.json'))) return false
  const modules = join(profile, 'node_modules')
  const staging = join(profile, 'node_modules.zp-tmp')
  try {
    const manifestPath = join(profile, 'package.json')
    const profileManifest = await readJson(manifestPath) as { dependencies?: Record<string, string> }
    const dependencies = profileManifest.dependencies ?? {}
    if (list.plugins.some(plugin => dependencies[plugin.name] !== undefined)) return false
    if (existsSync(modules) && (await readdir(modules)).length > 0) return false
    const bundled = ((await readJson(join(template, 'package.json'))).dependencies ?? {}) as Record<string, string>
    const missing = list.plugins.filter(plugin => bundled[plugin.name] !== plugin.want)
    if (missing.length > 0) throw new Error(`template lacks ${missing.map(plugin => plugin.name).join(', ')}`)
    onBusy()
    const started = Date.now()
    await rm(staging, { recursive: true, force: true })
    // ditto copies tens of thousands of small files several times faster than fs.cp.
    if (process.platform === 'darwin') {
      if (await run('/usr/bin/ditto', ['--noextattr', '--noqtn', join(template, 'modules'), staging], process.env, limits.copy) !== 0) throw new Error('ditto failed or timed out')
    } else await cp(join(template, 'modules'), staging, { recursive: true, verbatimSymlinks: true })
    await rm(modules, { recursive: true, force: true })
    await rename(staging, modules)
    if (!existsSync(join(profile, 'pnpm-lock.yaml'))) await copyFile(join(template, 'pnpm-lock.yaml'), join(profile, 'pnpm-lock.yaml'))
    for (const plugin of list.plugins) dependencies[plugin.name] = bundled[plugin.name] as string
    await writeFile(manifestPath, `${JSON.stringify({ ...profileManifest, dependencies }, null, 2)}\n`)
    console.info(`CRYSOUND: installed ${String(list.plugins.length)} bundled plugins in ${String(Date.now() - started)} ms`)
    return true
  } catch (error) {
    console.warn('CRYSOUND: bundled plugins could not be copied; installing online', error)
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

/**
 * Install the company plugins that the profile does not record yet (from the bundled template, else online), patch them, enable the experimental
 * bundles once, and seed the default configuration once. Runs while the Host is stopped; a failed install
 * is logged and does not block startup.
 * @param options - Paths and environment of this run.
 * @returns The company plugins that are still missing, for a notice to the user.
 */
export async function prepareCompanyWorkspace(options: WorkspaceOptions): Promise<WorkspaceResult> {
  const { assets, profile, cliEntry, execPath, userData } = options
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  let busy = false
  const onBusy = (): void => { if (!busy) { busy = true; options.onBusy?.() } }
  const list = await readJson(join(assets, 'config', 'plugins.json')) as unknown as PluginList
  const manifestPath = join(profile, 'package.json')
  const recorded = async (): Promise<Record<string, string>> =>
    ((await readJson(manifestPath)).dependencies ?? {}) as Record<string, string>
  const environment: NodeJS.ProcessEnv = { ...options.environment, ELECTRON_RUN_AS_NODE: '1' }
  await mkdir(userData, { recursive: true })

  await applyPluginTemplate(assets, profile, list, limits, onBusy)
  const deadline = Date.now() + limits.installTotal
  const skipped: string[] = []
  for (const plugin of list.plugins) {
    if ((await recorded())[plugin.name] === plugin.want) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) { skipped.push(plugin.name); continue }
    onBusy()
    const code = await run(execPath, ['--expose-internals', cliEntry, 'plugin', '--profile', 'desktop', 'add', plugin.spec], environment, Math.min(limits.install, remaining))
    // pnpm 11 exits 1 after a successful add when dependency build scripts were not approved; the manifest is the truth.
    if ((await recorded())[plugin.name] !== plugin.want) console.warn(`CRYSOUND: plugin ${plugin.name} failed to install (exit ${String(code)}); starting without it`)
  }
  if (skipped.length > 0) console.warn(`CRYSOUND: online install budget used up; skipped ${skipped.join(', ')}; they are retried at the next launch`)

  const patches = join(assets, 'config', 'plugin-patches.mjs')
  if (existsSync(patches)) await run(execPath, [patches, join(profile, 'node_modules')], environment, limits.patch)

  const defaultsMark = join(userData, '.zp-default-plugins-v1')
  if (!existsSync(defaultsMark)) {
    const manifest = await readJson(manifestPath) as { dsh?: { profile?: { bundles?: string[] } } }
    const bundles = ((manifest.dsh ??= {}).profile ??= {}).bundles ??= []
    for (const name of list.defaultBundles) if (!bundles.includes(name)) bundles.push(name)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(defaultsMark, '')
  }

  const seedMark = join(userData, '.zp-seed-v1')
  if (!existsSync(seedMark)) {
    const target = join(profile, 'cordis.patch.yml')
    const head = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
    let mine = (existsSync(target) ? await readFile(target, 'utf8') : head).replace(/^\[\]\s*$/mu, '')
    const seed = await readFile(join(assets, 'config', 'partner.patch.yml'), 'utf8')
    for (const entry of seed.split(/^(?=- id: )/mu).filter(part => part.startsWith('- id: '))) {
      const id = /^- id: (\S+)/u.exec(entry)?.[1]
      if (id === undefined) continue
      if (!new RegExp(`^- id: ["']?${id}["']?\\s*$`, 'mu').test(mine)) mine = `${mine.replace(/\n*$/u, '\n')}${entry.replace(/\n*$/u, '\n')}`
    }
    await writeFile(target, mine, { mode: 0o600 })
    await writeFile(seedMark, '')
  }
  const done = await recorded()
  return { missing: list.plugins.filter(plugin => done[plugin.name] !== plugin.want).map(plugin => plugin.name) }
}
