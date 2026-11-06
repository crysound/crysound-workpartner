/**
 * Run with the installed Windows Electron executable in Node mode and tsx/esm.
 * SMOKE_APP is the installed executable. SMOKE_ROOT holds an isolated profile and the JSON report.
 * The production preparation runs twice, with plugin-install subprocesses forbidden before they start.
 * A negative control drops the template and must attempt installation, proving the guard is active.
 */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'

assert.equal(process.platform, 'win32', 'this smoke requires the installed Windows runtime')
const app = resolve(process.env.SMOKE_APP ?? '')
assert.equal(realpathSync(process.execPath), realpathSync(app), 'use the installed executable in Node mode')
assert.ok(process.env.SMOKE_ROOT, 'SMOKE_ROOT is required')
const root = resolve(process.env.SMOKE_ROOT)
const resources = join(dirname(app), 'resources')
const assets = join(resources, 'crysound')
const home = join(root, 'dsh')
const profile = join(home, 'profiles', 'desktop')
assert.ok(!existsSync(profile), 'the smoke requires a fresh profile')
mkdirSync(root, { recursive: true })
initProfile(profile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)

const forbiddenInstalls: string[][] = []
const spawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const argv = args[1]
  if (Array.isArray(argv) && argv.includes('plugin') && argv.includes('add')) {
    forbiddenInstalls.push([...argv])
    throw new Error('smoke: plugin installation is forbidden')
  }
  return spawn(...args)
}) as typeof spawn
syncBuiltinESMExports()
const { prepareCompanyWorkspace } = await import('../src/crysound/workspace.ts')
const environment = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  ELECTRON_RUN_AS_NODE: '1',
  MAGPIE_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  CRYSOUND_LLM_BASE: 'https://partner.example.test/_zp/llm/v1',
  npm_config_registry: 'http://127.0.0.1:9/',
  NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
  PATH: `${join(resources, 'runtime', 'bin')}${delimiter}${process.env.PATH ?? ''}`,
}
const options = {
  assets, profile, environment,
  userData: join(root, 'userdata'),
  execPath: app,
  cliEntry: join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
}
const report: Record<string, unknown> = { passed: false, runtime: process.execPath, platform: process.platform, arch: process.arch }
try {
  assert.ok(existsSync(join(assets, 'plugin-template', 'plugins.json')), 'plugin template must ship in the installer')
  const started = Date.now()
  const first = await prepareCompanyWorkspace(options)
  report.preparationMs = Date.now() - started
  assert.deepEqual(first.missing, [], 'all company plugins must be ready on first preparation')
  assert.equal(forbiddenInstalls.length, 0, 'first preparation must use the bundled template')
  const firstManifest = readFileSync(join(profile, 'package.json'), 'utf8')
  const second = await prepareCompanyWorkspace(options)
  assert.deepEqual(second.missing, [])
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), firstManifest, 'second preparation must preserve plugin records and bundles')
  assert.equal(forbiddenInstalls.length, 0, 'second preparation must not install plugins')

  const list = JSON.parse(readFileSync(join(assets, 'config', 'plugins.json'), 'utf8')) as {
    plugins: { name: string; want: string }[]
    defaultBundles: string[]
  }
  const manifest = JSON.parse(firstManifest) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
  assert.equal(list.plugins.length, 5, 'check the complete company plugin list')
  const require = createRequire(join(profile, 'package.json'))
  const modules = realpathSync(join(profile, 'node_modules'))
  report.plugins = list.plugins.map((plugin) => {
    assert.equal(manifest.dependencies[plugin.name], plugin.want, `${plugin.name}: recorded version`)
    const installed = JSON.parse(readFileSync(join(modules, plugin.name, 'package.json'), 'utf8')) as { name: string; version: string }
    const bundled = JSON.parse(readFileSync(join(assets, 'plugin-template', 'modules', plugin.name, 'package.json'), 'utf8')) as { version: string }
    assert.equal(installed.name, plugin.name)
    assert.equal(installed.version, bundled.version, `${plugin.name}: module version must match the bundle`)
    if (/^\d/u.test(plugin.want)) assert.equal(installed.version, plugin.want)
    const entry = realpathSync(require.resolve(plugin.name))
    const local = relative(modules, entry)
    assert.ok(!isAbsolute(local) && !local.startsWith('..'), `${plugin.name}: module must resolve inside the isolated profile`)
    assert.ok(readFileSync(entry).length > 0, `${plugin.name}: module entry must have content`)
    return { name: plugin.name, want: plugin.want, version: installed.version, entry }
  })
  for (const bundle of list.defaultBundles) assert.equal(manifest.dsh.profile.bundles.filter(name => name === bundle).length, 1)
  assert.ok(!existsSync(join(profile, 'node_modules.zp-tmp')), 'no staging directory remains')
  report.offlineInstallAttempts = forbiddenInstalls.length

  const control = join(root, 'negative-control')
  const controlAssets = join(control, 'assets')
  cpSync(join(assets, 'config'), join(controlAssets, 'config'), { recursive: true })
  cpSync(join(assets, 'feishu'), join(controlAssets, 'feishu'), { recursive: true })
  const controlHome = join(control, 'dsh')
  const controlProfile = join(controlHome, 'profiles', 'desktop')
  initProfile(controlProfile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)
  const negative = await prepareCompanyWorkspace({
    ...options, assets: controlAssets, profile: controlProfile, userData: join(control, 'userdata'),
    environment: { ...environment, DSH_HOME: controlHome },
  })
  assert.deepEqual(negative.missing, list.plugins.map(plugin => plugin.name), 'missing template must leave every plugin uninstalled')
  assert.equal(forbiddenInstalls.length, list.plugins.length, 'guard must intercept every attempted plugin install')
  report.negativeControl = { forbiddenInstalls: forbiddenInstalls.length, missing: negative.missing }
  report.passed = true
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  childProcess.spawn = spawn
  syncBuiltinESMExports()
  writeFileSync(join(root, 'plugins.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  // Keep the report, not the large disposable profiles, in the smoke artifact.
  rmSync(home, { recursive: true, force: true })
  rmSync(join(root, 'negative-control'), { recursive: true, force: true })
  rmSync(join(root, 'userdata'), { recursive: true, force: true })
}
