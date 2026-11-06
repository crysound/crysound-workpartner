/** Company registry settings owned by the desktop profile. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Replace the company's two npm settings, preserving other profile settings. A missing token removes them.
 * @param profile - Desktop profile directory; never the user's home directory.
 * @param origin - Company gateway origin.
 * @param token - Literal desktop token, or undefined on logout.
 */
export async function writeMarketNpmrc(profile: string, origin: string, token?: string): Promise<void> {
  const file = join(profile, '.npmrc')
  const registry = `${origin}/_zp/npm/`
  const auth = `//${new URL(origin).host}/_zp/npm/:_authToken`
  let previous = ''
  try { previous = await readFile(file, 'utf8') } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const previousRegistry = previous.split(/\r?\n/u).find(line => /^\s*@crysound:registry\s*=/u.test(line))?.split('=').slice(1).join('=').trim()
  const previousUrl = previousRegistry === undefined || !URL.canParse(previousRegistry) ? undefined : new URL(previousRegistry)
  const previousAuth = previousUrl?.pathname === '/_zp/npm/' ? `//${previousUrl.host}/_zp/npm/:_authToken` : undefined
  const lines = previous.split(/\r?\n/u).filter((line) => {
    const key = line.split('=', 1)[0]?.trim()
    return key !== '@crysound:registry' && key !== auth && key !== previousAuth
  })
  if (token !== undefined) {
    if (/[\r\n]/u.test(token)) throw new Error('Invalid company token')
    lines.push(`@crysound:registry=${registry}`, `${auth}=${token}`)
  }
  if (token === undefined && previous === '') return
  await mkdir(profile, { recursive: true })
  const temp = `${file}.${randomBytes(12).toString('hex')}`
  try {
    await writeFile(temp, `${lines.join('\n').replace(/^\n+|\n+$/gu, '')}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}
