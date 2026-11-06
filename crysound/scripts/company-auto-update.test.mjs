import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { companyUpdateReadyPrompt, companyUpdatesEnabled, createCompanyAutoUpdateSchedule } from '../../apps/desktop/src/crysound/auto-update.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from '../../apps/desktop/src/update-schedule.ts'

const sixHours = 6 * 60 * 60 * 1000

function coordinator() {
  return {
    state: { phase: 'idle' }, checks: 0, downloads: [], installs: [], version: '0.2.3',
    async check() {
      this.checks++
      if (this.state.phase !== 'ready') this.state = { phase: 'available', version: this.version }
      return this.state
    },
    async download(version) { this.downloads.push(version); return this.state = { phase: 'ready', version } },
    async install(version) { this.installs.push(version); return this.state = { phase: 'installing', version } },
  }
}

test('only installed macOS builds with a sealed update source enable checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-update-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(companyUpdatesEnabled(true, 'darwin', root), false)
  await writeFile(join(root, 'app-update.yml'), '{}')
  assert.equal(companyUpdatesEnabled(false, 'darwin', root), false)
  assert.equal(companyUpdatesEnabled(true, 'win32', root), false)
  assert.equal(companyUpdatesEnabled(true, 'darwin', root), true)
})

test('the actual main-process wiring selects one company schedule and shows the approved restart choice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-main-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await readFile(new URL('../../apps/desktop/src/main.ts', import.meta.url), 'utf8')
  // Run the shell's actual initialization block without starting Electron, login or the workspace.
  const start = source.indexOf('  const companyUpdateEnabled =')
  const end = source.indexOf('  const downloadUpdate =', start)
  assert.ok(start >= 0 && end > start)
  const initialize = new Function('dependencies', `
    const { app, process, manifest, desktopUpdateChannel, DesktopUpdateCoordinator, publishUpdate,
      companyUpdatesEnabled, companyUpdateReadyPrompt, createCompanyAutoUpdateSchedule,
      DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig, windowShown, ordinaryMessageBox, quitting } = dependencies
    ${stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })}
    return { updates, updateSchedule, updateChannel, companyUpdateEnabled }
  `)
  let prompts = 0
  class ShellCoordinator {
    constructor(publish, beforeRestart, updater, enabled, currentVersion, downloadResult, channel) {
      Object.assign(this, coordinator())
      this.channel = channel
      const check = this.check
      this.check = async () => enabled() ? check.call(this) : this.state
    }
  }
  const dependencies = {
    app: { isPackaged: true }, process: { platform: 'darwin', resourcesPath: root, env: {} }, manifest: {},
    desktopUpdateChannel: () => 'nightly', DesktopUpdateCoordinator: ShellCoordinator, publishUpdate: state => state,
    companyUpdatesEnabled, companyUpdateReadyPrompt, createCompanyAutoUpdateSchedule,
    DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig, quitting: false,
    windowShown: async () => {}, ordinaryMessageBox: async options => {
      assert.equal(options.message, '新版本已下载，重启后生效')
      assert.deepEqual(options.buttons, ['立即重启', '稍后'])
      prompts++
      return { response: 1 }
    },
  }
  const unsigned = initialize(dependencies)
  t.after(() => unsigned.updateSchedule.dispose())
  assert.equal(unsigned.companyUpdateEnabled, false)
  await unsigned.updateSchedule.check()
  assert.equal(unsigned.updates.checks, 0)
  await writeFile(join(root, 'app-update.yml'), '{}')
  const development = initialize({ ...dependencies, app: { isPackaged: false } })
  t.after(() => development.updateSchedule.dispose())
  assert.equal(development.companyUpdateEnabled, false)
  const signed = initialize(dependencies)
  t.after(() => signed.updateSchedule.dispose())
  assert.equal(signed.updateChannel, 'latest')
  assert.equal(signed.updates.channel, 'latest')
  await signed.updateSchedule.check()
  assert.deepEqual(signed.updates.downloads, ['0.2.3'])
  assert.deepEqual(signed.updates.installs, [])
  assert.equal(prompts, 1)
})

test('startup downloads automatically, Later never installs or repeats the same prompt, polling waits six hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const updates = coordinator()
  let prompts = 0
  const owner = createCompanyAutoUpdateSchedule(updates, async () => { prompts++; return false })
  t.after(() => owner.dispose())
  void owner.check()
  await setImmediate()
  assert.deepEqual(updates.downloads, ['0.2.3'])
  assert.equal(prompts, 1)
  assert.deepEqual(updates.installs, [])
  t.mock.timers.tick(sixHours - 1)
  await setImmediate()
  assert.equal(updates.checks, 1)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(updates.checks, 2)
  assert.equal(prompts, 1)
  assert.deepEqual(updates.installs, [])
  owner.dispose()
  t.mock.timers.tick(sixHours)
  await setImmediate()
  assert.equal(updates.checks, 2)
  assert.equal(companyUpdateReadyPrompt.message, '新版本已下载，重启后生效')
  assert.deepEqual(companyUpdateReadyPrompt.buttons, ['立即重启', '稍后'])
  assert.equal(companyUpdateReadyPrompt.cancelId, 1)
})

test('explicit restart delegates to the upstream installation safety checks', async t => {
  const updates = coordinator()
  const owner = createCompanyAutoUpdateSchedule(updates, async () => true)
  t.after(() => owner.dispose())
  void owner.check()
  await setImmediate()
  assert.deepEqual(updates.installs, ['0.2.3'])
})

test('a failed background transfer retries on the next poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const updates = coordinator()
  let attempts = 0
  updates.check = async function () {
    this.checks++
    if (this.state.phase !== 'error') this.state = { phase: 'available', version: this.version }
    return this.state
  }
  updates.download = async function (version) {
    this.downloads.push(version)
    this.state = ++attempts === 1 ? { phase: 'error', failedOperation: 'download', version } : { phase: 'ready', version }
    return this.state
  }
  let prompts = 0
  const owner = createCompanyAutoUpdateSchedule(updates, async () => { prompts++; return false })
  t.after(() => owner.dispose())
  void owner.check()
  await setImmediate()
  assert.equal(prompts, 0)
  t.mock.timers.tick(sixHours)
  await setImmediate()
  assert.deepEqual(updates.downloads, ['0.2.3', '0.2.3'])
  assert.equal(prompts, 1)
})

test('shutdown during download suppresses the prompt and installation', async () => {
  const updates = coordinator()
  let finish
  updates.download = async function (version) { return new Promise(resolve => { finish = () => resolve(this.state = { phase: 'ready', version }) }) }
  let prompts = 0
  const owner = createCompanyAutoUpdateSchedule(updates, async () => { prompts++; return true })
  void owner.check()
  await setImmediate()
  owner.dispose()
  finish()
  await setImmediate()
  assert.equal(prompts, 0)
  assert.deepEqual(updates.installs, [])
})
