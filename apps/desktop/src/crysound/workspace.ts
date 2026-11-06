/** CRYSOUND WorkPartner: company plugins, plugin patches, and default configuration for the desktop profile. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
}

interface PluginList {
  readonly plugins: readonly { readonly name: string; readonly spec: string; readonly want: string }[]
  readonly defaultBundles: readonly string[]
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', () => { resolve(1) })
    child.once('close', (code) => { resolve(code ?? 1) })
  })
}

/**
 * Install the company plugins that the profile does not record yet, patch them, enable the experimental
 * bundles once, and seed the default configuration once. Runs while the Host is stopped; a failed install
 * is logged and does not block startup.
 * @param options - Paths and environment of this run.
 */
export async function prepareCompanyWorkspace(options: WorkspaceOptions): Promise<void> {
  const { assets, profile, cliEntry, execPath, userData } = options
  const list = await readJson(join(assets, 'config', 'plugins.json')) as unknown as PluginList
  const manifestPath = join(profile, 'package.json')
  const recorded = async (): Promise<Record<string, string>> =>
    ((await readJson(manifestPath)).dependencies ?? {}) as Record<string, string>
  const environment: NodeJS.ProcessEnv = { ...options.environment, ELECTRON_RUN_AS_NODE: '1' }
  await mkdir(userData, { recursive: true })

  for (const plugin of list.plugins) {
    if ((await recorded())[plugin.name] === plugin.want) continue
    const code = await run(execPath, ['--expose-internals', cliEntry, 'plugin', '--profile', 'desktop', 'add', plugin.spec], environment)
    if (code !== 0) console.warn(`CRYSOUND: plugin ${plugin.name} failed to install; starting without it`)
  }

  const patches = join(assets, 'config', 'plugin-patches.mjs')
  if (existsSync(patches)) await run(execPath, [patches, join(profile, 'node_modules')], environment)

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
}
