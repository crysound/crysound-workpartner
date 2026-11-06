/** Company background downloads using the upstream coordinator and polling lifecycle. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import { DesktopUpdateSchedule } from '../update-schedule.ts'
import type { DesktopUpdateCoordinator } from '../update-coordinator.ts'
import type { PartnerSession } from './partner.ts'

/** Chinese copy for the optional restart prompt, supplied to the shell's existing dialog owner. */
export const companyUpdateReadyPrompt = {
  type: 'info' as const,
  title: '兆华工作伙伴',
  message: '新版本已下载，重启后生效',
  buttons: ['立即重启', '稍后'],
  defaultId: 1,
  cancelId: 1,
}

/** Only installed macOS releases whose signing step sealed a feed may check for updates. */
export function companyUpdatesEnabled(packaged: boolean, platform: NodeJS.Platform, resourcesPath: string): boolean {
  return packaged && platform === 'darwin' && existsSync(join(resourcesPath, 'app-update.yml'))
}

/**
 * Refresh in-memory request headers from the same stored session used for company configuration.
 * @param updater - Process-owned updater; headers apply to metadata and archive requests.
 * @param readSession - Read the latest saved login; absence clears headers and skips network work.
 * @returns Whether a signed-in session permits the next update request.
 */
export async function authenticateCompanyUpdates(
  updater: Pick<AppUpdater, 'requestHeaders'>,
  readSession: () => Promise<Pick<PartnerSession, 'token'> | undefined>,
): Promise<boolean> {
  const session = await readSession()
  updater.requestHeaders = session === undefined ? null : { Authorization: `Bearer ${session.token}` }
  return session !== undefined
}

/**
 * Use as the shell's single polling owner; its launch check starts six-hour polling and transfer retries.
 * @param updates - Existing coordinator, including its task lock and clean shutdown before installation.
 * @param showReady - Resolve true only for an explicit restart choice; false keeps the running app.
 * @param authenticate - Refresh request headers before checking and downloading; false skips until the next poll.
 * @returns Checks and timer disposal, which also suppresses prompts and installation during shutdown.
 */
export function createCompanyAutoUpdateSchedule(
  updates: Pick<DesktopUpdateCoordinator, 'check' | 'download' | 'install' | 'state'>,
  showReady: () => Promise<boolean>,
  authenticate: () => Promise<boolean>,
): Pick<DesktopUpdateSchedule, 'check' | 'dispose'> {
  let disposed = false
  let prompted: string | undefined
  const schedule = new DesktopUpdateSchedule({
    get state() { return updates.state },
    async check(manual = false) {
      if (!await authenticate() || disposed) return updates.state
      let state = await updates.check(manual)
      // Explicit checks retain the shell's existing manual dialogs and download authorization.
      if (disposed || manual) return state
      if ((state.phase === 'available' || (state.phase === 'error' && state.failedOperation === 'download')) && state.version !== undefined) {
        if (!await authenticate() || disposed) return state
        state = await updates.download(state.version)
      }
      if (!disposed && state.phase === 'ready' && state.version !== undefined && state.version !== prompted) {
        const restart = await showReady()
        prompted = state.version
        if (restart && !disposed) state = await updates.install(state.version)
      }
      return state
    },
  }, { intervalMs: 6 * 60 * 60 * 1000, maxBackoffMs: 6 * 60 * 60 * 1000, jitter: 0 })
  return {
    check: (manual, force) => schedule.check(manual, force),
    dispose: () => { disposed = true; schedule.dispose() },
  }
}
