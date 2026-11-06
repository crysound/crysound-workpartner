/** CRYSOUND WorkPartner: company login and model gateway settings. */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'
import { resolveDesktopPaths } from '../paths.ts'
import { writeMarketNpmrc } from './npmrc.ts'
import { companyOrigin } from './origin.ts'

/** HTTPS gateway origin selected by PUBLIC_HOST. */
export const PARTNER_ORIGIN = companyOrigin(join(crysoundResources(), 'config'))
/** Company model gateway for authenticated desktop requests. */
export const LLM_BASE_URL = `${PARTNER_ORIGIN}/_zp/llm/v1`
const LOGIN_URL = `${PARTNER_ORIGIN}/_zp/desktop-login`
const DONE_URL = `${PARTNER_ORIGIN}/_zp/desktop-done`
const LOGIN_PARTITION = 'persist:crysound-login'

/** Brand files the web document may request from the application origin. */
export const BRAND_FILES: ReadonlySet<string> = new Set(['/brand.css', '/brand.js', '/pet.js', '/welcome.js', '/zp-mark.svg'])

/** A signed-in company user. */
export interface PartnerSession {
  readonly token: string
  readonly name: string
  readonly avatar: string
}

/** Company assets (brand layer, default configuration, plugin list, Host hook) shipped beside the application. */
export function crysoundResources(): string {
  return app.isPackaged ? join(process.resourcesPath, 'crysound') : join(app.getAppPath(), '..', '..', 'crysound')
}

const tokenFile = (): string => join(app.getPath('userData'), 'partner-session.json')

/** @returns the stored session, or undefined when the user is signed out. */
export async function readPartnerSession(): Promise<PartnerSession | undefined> {
  try {
    const value = JSON.parse(await readFile(tokenFile(), 'utf8')) as Partial<Record<keyof PartnerSession, unknown>> | null
    const text = (field: unknown): string => typeof field === 'string' ? field : ''
    if (value !== null && text(value.token) !== '') return { token: text(value.token), name: text(value.name), avatar: text(value.avatar) }
  } catch { /* A missing or unreadable file means signed out. */ }
  return undefined
}

async function writePartnerSession(value: PartnerSession): Promise<void> {
  await writeMarketNpmrc(resolveDesktopPaths().profile, PARTNER_ORIGIN, value.token)
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(tokenFile(), JSON.stringify(value), { mode: 0o600 })
  await chmod(tokenFile(), 0o600)
}

/** Forget the stored token and the Feishu cookies of the login window, so the next login can use another account. */
export async function clearPartnerSession(): Promise<void> {
  await writeMarketNpmrc(resolveDesktopPaths().profile, PARTNER_ORIGIN)
  await rm(tokenFile(), { force: true })
  await session.fromPartition(LOGIN_PARTITION).clearStorageData()
}

/**
 * Ask the gateway whether a token is still accepted.
 * @returns false only when the gateway answers 401; an unreachable gateway keeps the token.
 */
async function tokenAccepted(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LLM_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    await response.body?.cancel()
    return response.status !== 401
  } catch { return true }
}

function sessionFromDoneUrl(url: string): PartnerSession | undefined {
  if (!url.startsWith(DONE_URL)) return undefined
  const fragment = new URL(url).hash.replace(/^#/u, '')
  const params = new URLSearchParams(fragment)
  const token = params.get('token')
  if (token === null || token === '') return undefined
  return { token, name: params.get('name') ?? '', avatar: params.get('avatar') ?? '' }
}

/**
 * Open the Feishu login page in a window and wait for the server's hand-off redirect.
 * @returns the new session, or undefined when the user closes the window first.
 */
export function openLoginWindow(): Promise<PartnerSession | undefined> {
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 520, height: 760, title: '登录 兆华工作伙伴', autoHideMenuBar: true,
      webPreferences: { partition: LOGIN_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    let settled = false
    const finish = (value: PartnerSession | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!window.isDestroyed()) window.destroy()
    }
    const inspect = (event: { preventDefault: () => void }, url: string): void => {
      const found = sessionFromDoneUrl(url)
      if (found === undefined) return
      event.preventDefault()
      void writePartnerSession(found).then(() => { finish(found) }, () => { finish(undefined) })
    }
    window.webContents.on('will-redirect', (event) => { inspect(event, event.url) })
    window.webContents.on('will-navigate', (event) => { inspect(event, event.url) })
    window.webContents.on('did-navigate', (_event, url) => { inspect({ preventDefault: () => undefined }, url) })
    window.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
    window.on('closed', () => { finish(undefined) })
    void window.loadURL(LOGIN_URL).catch(() => undefined)
  })
}

/**
 * Return a usable session, opening the login window when none is stored or the stored token is rejected.
 * @returns the session, or undefined when the user abandons the login.
 */
export async function ensurePartnerSession(): Promise<PartnerSession | undefined> {
  // Company settings navigation and its loopback page stay in company resources.
  const settings: { installDesktopSettings: (options: { app: typeof app; BrowserWindow: typeof BrowserWindow; publicOrigin: string; configFile: string; identityFile: string; execPath: string }) => void } = await import(pathToFileURL(join(crysoundResources(), 'feishu', 'desktop.mjs')).href)
  settings.installDesktopSettings({ app, BrowserWindow, publicOrigin: PARTNER_ORIGIN, configFile: join(app.getPath('userData'), 'company', 'feishu.json'), identityFile: tokenFile(), execPath: process.execPath })
  const stored = await readPartnerSession()
  if (stored !== undefined) {
    if (await tokenAccepted(stored.token)) {
      await writeMarketNpmrc(resolveDesktopPaths().profile, PARTNER_ORIGIN, stored.token)
      return stored
    }
    await clearPartnerSession()
  }
  return openLoginWindow()
}

/** Environment that points every model route of the Host at the company gateway. */
export function partnerHostEnvironment(partner: PartnerSession): NodeJS.ProcessEnv {
  const company = join(app.getPath('userData'), 'company')
  const skillHash = createHash('sha256').update(readFileSync(join(crysoundResources(), 'feishu', 'official-skills.tar.gz'))).digest('hex').slice(0, 16)
  return {
    PATH: `${join(company, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    CRYSOUND_FEISHU_CONFIG: join(company, 'feishu.json'),
    CRYSOUND_COMPANY_SKILLS: join(company, `feishu-skills-${skillHash}`),
    LARKSUITE_CLI_STRICT_MODE: 'user',
    MAGPIE_API_KEY: partner.token,
    DEEPSEEK_API_KEY: partner.token,
    DEEPSEEK_BASE_URL: LLM_BASE_URL,
    CRYSOUND_LLM_BASE: LLM_BASE_URL,
    CRYSOUND_MARKET_REGISTRY: `${PARTNER_ORIGIN}/_zp/npm/`,
    CRYSOUND_NPM_USERCONFIG: join(resolveDesktopPaths().profile, '.npmrc'),
    CRYSOUND_HOST_HOOK: pathToFileURL(join(crysoundResources(), 'host-hook.mjs')).href,
    DSH_TELEMETRY_DISABLED: '1',
  }
}

const welcomeMark = (userData: string): string => join(userData, '.zp-welcome-v1')

/** @returns true until the workspace has opened once for this user; the Feishu welcome guide uses it. */
export function isFirstRun(userData: string): boolean {
  return !existsSync(welcomeMark(userData))
}

/** Record that the first workspace entry happened. */
export async function markFirstRunDone(userData: string): Promise<void> {
  await writeFile(welcomeMark(userData), '')
}
