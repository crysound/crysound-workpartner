import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCompanyWorkspace, run } from '../src/crysound/workspace.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zp-workspace-')); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function gone(pids: number[]): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pids.every(pid => !alive(pid))) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

function makeAssets(names: readonly string[]): { assets: string; profile: string; userData: string } {
  const assets = join(root, 'assets')
  const profile = join(root, 'home', 'profiles', 'desktop')
  mkdirSync(join(assets, 'config', 'skills', 'publish-zhaohua-market'), { recursive: true })
  mkdirSync(join(assets, 'feishu'), { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(assets, 'config', 'plugins.json'), JSON.stringify({
    plugins: names.map(name => ({ name, spec: `${name}@1.0.0`, want: '1.0.0' })), defaultBundles: [],
  }))
  writeFileSync(join(assets, 'config', 'partner.patch.yml'), '- id: seed-entry\n  value: 1\n')
  // The company config steps that follow the plugin install are stubs here; they have their own tests.
  writeFileSync(join(assets, 'config', 'profile-upgrades.mjs'), 'process.exit(0)\n')
  writeFileSync(join(assets, 'config', 'skills', 'publish-zhaohua-market', 'SKILL.md'), '# stub\n')
  writeFileSync(join(assets, 'config', 'public-host.json'), '{}\n')
  writeFileSync(join(assets, 'feishu', 'desktop-setup.mjs'), 'process.exit(0)\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))
  return { assets, profile, userData: join(root, 'userdata') }
}

// No gateway token: the packaged company config is used and nothing is fetched.
const environment = { ...process.env, CRYSOUND_LLM_BASE: 'http://127.0.0.1:9/v1', MAGPIE_API_KEY: '' }

describe.skipIf(process.platform === 'win32')('run', () => {
  it('kills a command that never exits, together with what it started', async () => {
    const pids = join(root, 'pids.json')
    const grandchild = 'setInterval(() => {}, 1000)'
    const script = `const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid]));
      setInterval(() => {}, 1000)`
    const started = Date.now()
    const code = await run(process.execPath, ['-e', script], process.env, 1500)
    expect(code).toBe(1)
    expect(Date.now() - started).toBeLessThan(5000)
    const [parent, child] = JSON.parse(readFileSync(pids, 'utf8')) as [number, number]
    expect(await gone([parent, child])).toBe(true)
  })

  it('returns the exit code of a command that finishes', async () => {
    expect(await run(process.execPath, ['-e', 'process.exit(3)'], process.env, 5000)).toBe(3)
  })
})

describe('prepareCompanyWorkspace', () => {
  it('finishes within the install budget when installs hang, and reports what is missing', async () => {
    const { assets, profile, userData } = makeAssets(['p-one', 'p-two', 'p-three'])
    const stub = join(root, 'cli.js')
    // The stub installs nothing and never exits, like a pnpm that waits on a dead network.
    writeFileSync(stub, 'setInterval(() => {}, 1000)')
    const busy = vi.fn()
    const started = Date.now()
    const result = await prepareCompanyWorkspace({
      assets, profile, userData, execPath: process.execPath, cliEntry: stub, environment, onBusy: busy,
      limits: { install: 600, installTotal: 1000, patch: 500 },
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.missing).toEqual(['p-one', 'p-two', 'p-three'])
    expect(busy).toHaveBeenCalledTimes(1)
    // The remaining steps still ran after the hang.
    expect(existsSync(join(userData, '.zp-seed-v1'))).toBe(true)
    const warnings = vi.mocked(console.warn).mock.calls.map(call => String(call[0])).join('\n')
    expect(warnings).toContain('skipped p-three')
  })

  it('takes the plugins from the bundled template without an online install', async () => {
    const { assets, profile, userData } = makeAssets(['p-one', 'p-two'])
    const template = join(assets, 'plugin-template')
    mkdirSync(join(template, 'modules', 'p-one'), { recursive: true })
    mkdirSync(join(template, 'modules', 'p-two'), { recursive: true })
    writeFileSync(join(template, 'modules', 'p-one', 'package.json'), '{}')
    writeFileSync(join(template, 'modules', 'p-two', 'package.json'), '{}')
    writeFileSync(join(template, 'package.json'), JSON.stringify({ dependencies: { 'p-one': '1.0.0', 'p-two': '1.0.0' } }))
    writeFileSync(join(template, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const installed = join(root, 'installed')
    const stub = join(root, 'cli.js')
    writeFileSync(stub, `require('node:fs').writeFileSync(${JSON.stringify(installed)}, '')`)
    const busy = vi.fn()
    const result = await prepareCompanyWorkspace({
      assets, profile, userData, execPath: process.execPath, cliEntry: stub, environment, onBusy: busy,
    })
    expect(existsSync(installed)).toBe(false)
    expect(result.missing).toEqual([])
    expect(busy).toHaveBeenCalledTimes(1)
    expect(existsSync(join(profile, 'node_modules', 'p-two', 'package.json'))).toBe(true)
    expect(existsSync(join(profile, 'pnpm-lock.yaml'))).toBe(true)
    expect(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies).toEqual({ 'p-one': '1.0.0', 'p-two': '1.0.0' })
    expect(existsSync(join(profile, 'node_modules.zp-tmp'))).toBe(false)
  })

  it('falls back to the online install when the profile already has other node_modules content', async () => {
    const { assets, profile, userData } = makeAssets(['p-one'])
    const template = join(assets, 'plugin-template')
    mkdirSync(join(template, 'modules', 'p-one'), { recursive: true })
    writeFileSync(join(template, 'package.json'), JSON.stringify({ dependencies: { 'p-one': '1.0.0' } }))
    mkdirSync(join(profile, 'node_modules', 'other'), { recursive: true })
    const stub = join(root, 'cli.js')
    writeFileSync(stub, `const fs = require('node:fs'); const p = ${JSON.stringify(join(profile, 'package.json'))};
      const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.dependencies['p-one'] = '1.0.0'; fs.writeFileSync(p, JSON.stringify(m))`)
    const result = await prepareCompanyWorkspace({ assets, profile, userData, execPath: process.execPath, cliEntry: stub, environment })
    expect(result.missing).toEqual([])
    expect(existsSync(join(profile, 'node_modules', 'p-one'))).toBe(false)
  })
})

