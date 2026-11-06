/** CRYSOUND WorkPartner: company plugins, plugin patches, and default configuration for the desktop profile. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { companyConfig } from './company-config.ts'

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
  /** Host environment, including CRYSOUND_LLM_BASE; the installer sees the same home and PATH. */
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
 * bundles once, seed defaults once, and refresh company models, market settings and skills.
 * Prepares user-only Feishu wrappers and the read-only pinned skills using packaged company resources.
 * Uses a complete gateway snapshot or the packaged fallback while the Host is stopped. A failed plugin
 * install is logged; invalid gateway settings, failed config refresh or a failed skill copy reject preparation.
 * @param options - Paths and environment of this run.
 */
export async function prepareCompanyWorkspace(options: WorkspaceOptions): Promise<void> {
  const { profile, cliEntry, execPath, userData } = options
  if (!options.environment.CRYSOUND_LLM_BASE) throw new Error('CRYSOUND: company gateway is missing')
  const marketOrigin = new URL(options.environment.CRYSOUND_LLM_BASE).origin
  const config = await companyConfig(options.assets, userData, options.environment)
  try {
    const list = await readJson(join(config.directory, 'plugins.json')) as unknown as PluginList
    const manifestPath = join(profile, 'package.json')
    const recorded = async (): Promise<Record<string, string>> =>
      ((await readJson(manifestPath)).dependencies ?? {}) as Record<string, string>
    const environment: NodeJS.ProcessEnv = { ...options.environment, ELECTRON_RUN_AS_NODE: '1' }
    await mkdir(userData, { recursive: true })

    for (const plugin of list.plugins) {
      if ((await recorded())[plugin.name] === plugin.want) continue
      const code = await run(execPath, ['--expose-internals', cliEntry, 'plugin', '--profile', 'desktop', 'add', plugin.spec], environment)
      // pnpm 11 exits 1 after a successful add when dependency build scripts were not approved; the manifest is the truth.
      if ((await recorded())[plugin.name] !== plugin.want) console.warn(`CRYSOUND: plugin ${plugin.name} failed to install (exit ${String(code)}); starting without it`)
    }

    const patches = join(config.directory, 'plugin-patches.mjs')
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
    const code = await run(execPath, [join(config.directory, 'profile-upgrades.mjs'), join(profile, 'cordis.patch.yml'),
      join(config.directory, 'partner.patch.yml'), cliEntry, ...(existsSync(seedMark) ? [] : ['--seed'])], environment)
    if (code !== 0) throw new Error('CRYSOUND: company model configuration refresh failed')
    await writeFile(seedMark, '')
    const market = join(config.directory, 'market-profile.mjs')
    if (existsSync(market)) {
      const code = await run(execPath, [market, join(profile, 'cordis.patch.yml'), manifestPath, `${marketOrigin}/_zp/market/index.json`], environment)
      if (code !== 0) console.warn('CRYSOUND: market configuration failed; check the profile patch')
    }
    await cp(join(config.directory, 'skills', 'publish-zhaohua-market'), join(dirname(dirname(profile)), 'skills', 'publish-zhaohua-market'), { recursive: true })

    const feishuPublic = await readJson(join(options.assets, 'config', 'public-host.json')).catch((error: unknown): Record<string, unknown> => {
      // Source launches can supply PUBLIC_HOST without generating packaged settings.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
      throw error
    })
    let projectHost = typeof feishuPublic.MEEGLE_HOST === 'string' ? feishuPublic.MEEGLE_HOST : ''
    if (options.environment.MAGPIE_API_KEY) {
      try {
        const response = await fetch(`${marketOrigin}/_zp/feishu/desktop-config`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${options.environment.MAGPIE_API_KEY}` }, signal: AbortSignal.timeout(8000) })
        const remote: unknown = await response.json()
        if (response.ok && typeof remote === 'object' && remote !== null && 'meegle_host' in remote && typeof remote.meegle_host === 'string') projectHost = remote.meegle_host
      } catch { console.warn('CRYSOUND: project host refresh failed; using bundled public settings') }
    }
    const feishuCode = await run(execPath, [join(options.assets, 'feishu', 'desktop-setup.mjs'), join(userData, 'company'), join(userData, 'partner-session.json'), marketOrigin, execPath, join(profile, 'cordis.patch.yml'), projectHost], environment)
    if (feishuCode !== 0) throw new Error('CRYSOUND: Feishu command and skill preparation failed')
  } finally { await config.dispose() }
}
