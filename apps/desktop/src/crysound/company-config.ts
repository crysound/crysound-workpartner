/** Download one complete company config snapshot, or keep using the packaged snapshot when offline. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CONFIG_FILES = ['plugins.json', 'partner.patch.yml', 'profile-upgrades.mjs', 'plugin-patches.mjs', 'market-profile.mjs', 'market-npmrc.mjs', 'skills/publish-zhaohua-market/SKILL.md'] as const

/**
 * Use a private per-run directory so incomplete downloads never replace a working configuration.
 * @returns The selected directory and cleanup for the temporary snapshot, if any.
 */
export async function companyConfig(
  assets: string, userData: string, environment: NodeJS.ProcessEnv,
): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const fallback = { directory: join(assets, 'config'), dispose: async (): Promise<void> => {} }
  const base = environment.CRYSOUND_LLM_BASE
  const token = environment.MAGPIE_API_KEY
  if (!base || !token) return fallback
  await mkdir(userData, { recursive: true })
  const directory = await mkdtemp(join(userData, 'company-config-'))
  try {
    const origin = new URL(base).origin
    const signal = AbortSignal.timeout(8000)
    // Finish all transfers before cleanup, including when one request fails.
    const files = await Promise.all(CONFIG_FILES.map(async (file) => {
      const response = await fetch(new URL(`/_zp/config/${file}`, origin), {
        headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error',
      })
      if (!response.ok) { await response.body?.cancel(); return undefined }
      return { file, text: await response.text() }
    }).map(promise => promise.catch(() => undefined)))
    if (files.some(file => file === undefined)) throw new Error('公司配置下载不完整')
    for (const file of files) {
      if (file === undefined) continue
      if (file.file === 'plugins.json') {
        const list: unknown = JSON.parse(file.text)
        if (typeof list !== 'object' || list === null || !('plugins' in list) || !Array.isArray(list.plugins)
          || !list.plugins.every((plugin: unknown) => typeof plugin === 'object' && plugin !== null
            && 'name' in plugin && typeof plugin.name === 'string' && 'spec' in plugin && typeof plugin.spec === 'string'
            && 'want' in plugin && typeof plugin.want === 'string')
          || !('defaultBundles' in list) || !Array.isArray(list.defaultBundles) || !list.defaultBundles.every((name: unknown) => typeof name === 'string')) {
          throw new Error('公司插件清单格式不正确')
        }
      }
      await mkdir(dirname(join(directory, file.file)), { recursive: true })
      await writeFile(join(directory, file.file), file.text, { mode: 0o600 })
    }
    return { directory, dispose: async (): Promise<void> => { await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    console.warn('CRYSOUND: gateway configuration unavailable; using packaged configuration', error)
    await rm(directory, { recursive: true, force: true })
    return fallback
  }
}
