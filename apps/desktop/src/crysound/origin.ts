/** Public company gateway configuration for a packaged desktop installation. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the gateway from PUBLIC_HOST or the public configuration generated before packaging.
 * @param config - Company configuration directory shipped with the desktop assets.
 * @param environment - Runtime overrides; absent PUBLIC_HOST uses the packaged configuration.
 * @returns HTTPS origin without a path or credentials.
 */
export function companyOrigin(config: string, environment: NodeJS.ProcessEnv = process.env): string {
  let host: unknown = environment.PUBLIC_HOST
  if (host === undefined) {
    const settings: unknown = JSON.parse(readFileSync(join(config, 'public-host.json'), 'utf8'))
    if (typeof settings === 'object' && settings !== null && 'PUBLIC_HOST' in settings) host = settings.PUBLIC_HOST
  }
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?$/iu.test(host)
    || new URL(`https://${host}`).host !== host.toLowerCase()) {
    throw new Error('CRYSOUND: configure PUBLIC_HOST before launching or packaging the desktop app')
  }
  return `https://${host.toLowerCase()}`
}
