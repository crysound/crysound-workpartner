import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'
import { prepareCompanyWorkspace } from '../src/crysound/workspace.ts'

const app = process.env.SMOKE_APP as string
const userData = process.env.SMOKE_USERDATA as string
const profile = join(process.env.DSH_HOME as string, 'profiles', 'desktop')
const assets = join(app, 'Contents', 'Resources', 'crysound')
initProfile(profile, (PROFILE_TEMPLATES.web as ProfileTemplate).bundles)

const environment = { ...process.env, DSH_TELEMETRY_DISABLED: '1', MAGPIE_API_KEY: '' }
const options = {
  assets, profile, userData, environment,
  execPath: join(app, 'Contents', 'MacOS', 'CRYSOUND WorkPartner'),
  cliEntry: join(app, 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
}
await prepareCompanyWorkspace(options)
// A second run must not repeat the once-only steps.
await prepareCompanyWorkspace(options)

const list = JSON.parse(readFileSync(join(assets, 'config', 'plugins.json'), 'utf8')) as {
  plugins: { name: string; want: string }[]
  defaultBundles: string[]
}
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}
let failed = false
const check = (ok: boolean, message: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); if (!ok) failed = true }
for (const plugin of list.plugins) check(manifest.dependencies?.[plugin.name] === plugin.want, `plugin ${plugin.name} installed (${plugin.want})`)
const bundles = manifest.dsh?.profile?.bundles ?? []
for (const name of list.defaultBundles) check(bundles.filter(bundle => bundle === name).length === 1, `bundle ${name} enabled once`)
const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
for (const id of ['llm-pi-ai', 'agent-default-model', 'ui-settings-general']) {
  check(new RegExp(`^- id: ${id}\\s*$`, 'mu').test(patch) && patch.split(`- id: ${id}`).length === 2, `seed entry ${id}`)
}
check(patch.includes('baseURL: !!js process.env.CRYSOUND_LLM_BASE || process.env.DEEPSEEK_BASE_URL'), 'seed baseURL uses the startup model gateway')
const feishu = join(profile, 'node_modules', '@aiwayds', 'dsh-feishu', 'lib', 'bot.js')
check(readFileSync(feishu, 'utf8').includes('auto-new failed'), 'feishu plugin patch applied')
process.exit(failed ? 1 : 0)
