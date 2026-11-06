import { DESKTOP_WANT, FEISHU, WEB_SPEC, isMarketPlugin, verifyArchive } from '../../../crysound/plugin-artifacts.mjs'
import childProcess from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'
import { prepareCompanyWorkspace } from '../src/crysound/workspace.ts'

const app = process.env.SMOKE_APP as string
const userData = process.env.SMOKE_USERDATA as string
const profile = join(process.env.DSH_HOME as string, 'profiles', 'desktop')
const assets = join(app, 'Contents', 'Resources', 'crysound')
const list = JSON.parse(readFileSync(join(assets, 'config', 'plugins.json'), 'utf8')) as {
  plugins: { name: string; spec: string; want: string }[]
  defaultBundles: string[]
}
const onlinePlugins = list.plugins.filter(isMarketPlugin)
const onlineNames = onlinePlugins.map(plugin => plugin.name)
initProfile(profile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)

// The registry points at a closed port: any plugin that still needed the network would fail to install.
const environment = {
  ...process.env, DSH_TELEMETRY_DISABLED: '1', MAGPIE_API_KEY: '',
  npm_config_registry: 'http://127.0.0.1:9/', NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
}
const options = {
  assets, profile, userData, environment,
  execPath: join(app, 'Contents', 'MacOS', 'CRYSOUND WorkPartner'),
  cliEntry: join(app, 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
}
const started = Date.now()
// Company packages need a desktop login; this offline packaging smoke must not contact their registry.
const spawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const argv = args[1]
  if (Array.isArray(argv) && argv.includes('plugin') && argv.includes('add') && onlinePlugins.some(plugin => plugin.spec === argv.at(-1))) {
    throw new Error('smoke: company market plugin requires login')
  }
  return spawn(...args)
}) as typeof spawn
syncBuiltinESMExports()
let missing: readonly string[] = []
let secondMissing: readonly string[] = []
try {
  missing = (await prepareCompanyWorkspace(options)).missing
  // A second run must not repeat the once-only steps; online plugins remain pending login.
  secondMissing = (await prepareCompanyWorkspace(options)).missing
} finally {
  childProcess.spawn = spawn
  syncBuiltinESMExports()
}
const seconds = (Date.now() - started) / 1000
console.log(`two preparation runs (bundled plugins, no network): ${seconds.toFixed(1)} s`)
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}
let failed = false
const check = (ok: boolean, message: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); if (!ok) failed = true }
check(JSON.stringify(missing) === JSON.stringify(onlineNames), 'first run defers only company market plugins until login')
check(JSON.stringify(secondMissing) === JSON.stringify(onlineNames), 'second run still reports company market plugins pending login')
for (const plugin of list.plugins) {
  if (isMarketPlugin(plugin)) {
    check(manifest.dependencies?.[plugin.name] === undefined, `plugin ${plugin.name}: online installation after login (not verified by this offline smoke)`)
    continue
  }
  const want = plugin.name === FEISHU.name && plugin.want === WEB_SPEC ? DESKTOP_WANT : plugin.want
  check(manifest.dependencies?.[plugin.name] === want, `plugin ${plugin.name} installed (${want})`)
}
verifyArchive(readFileSync(join(profile, 'company-plugins', FEISHU.file)))
const bundles = manifest.dsh?.profile?.bundles ?? []
for (const name of list.defaultBundles) check(bundles.filter(bundle => bundle === name).length === 1, `bundle ${name} enabled once`)
const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
for (const id of ['llm-pi-ai', 'agent-default-model', 'ui-settings-general']) {
  check(new RegExp(`^- id: ${id}\\s*$`, 'mu').test(patch) && patch.split(`- id: ${id}`).length === 2, `seed entry ${id}`)
}
check(patch.includes('baseURL: !!js process.env.CRYSOUND_LLM_BASE || process.env.DEEPSEEK_BASE_URL'), 'seed baseURL uses the startup model gateway')
const feishu = join(profile, 'node_modules', '@aiwayds', 'dsh-feishu', 'lib', 'bot.js')
check(readFileSync(feishu, 'utf8').includes('auto-new failed'), 'feishu plugin patch applied')
check(existsSync(join(assets, 'plugin-template', 'package.json')), 'plugin template shipped in the package')
check(!existsSync(join(profile, 'node_modules.zp-tmp')), 'no staging directory left behind')

// Reference: the same preparation without the template, installing from the registry (informational; needs network).
if (process.env.SMOKE_ONLINE_BASELINE === '1') {
  const online = join(process.env.DSH_HOME as string, 'online-baseline')
  const onlineAssets = join(online, 'assets')
  mkdirSync(onlineAssets, { recursive: true })
  for (const part of ['config', 'company-plugins', 'feishu', 'plugin-artifacts.mjs']) cpSync(join(assets, part), join(onlineAssets, part), { recursive: true })
  const onlineProfile = join(online, 'profiles', 'desktop')
  initProfile(onlineProfile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)
  const onlineStart = Date.now()
  await prepareCompanyWorkspace({
    ...options, assets: onlineAssets, profile: onlineProfile, userData: join(online, 'userdata'),
    environment: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_HOME: online },
  })
  console.log(`first-run preparation (online install, before this change): ${((Date.now() - onlineStart) / 1000).toFixed(1)} s`)
}
process.exit(failed ? 1 : 0)
