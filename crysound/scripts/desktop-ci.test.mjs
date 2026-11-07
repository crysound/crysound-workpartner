import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { lt } from 'semver'
import { buildSummary, companyDesktopVersion, prepareBuild, previewVersion } from './desktop-ci.mjs'
import { releaseVersion } from './mac-update-release.mjs'

const exec = promisify(execFile)
const automatic = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '17', DESKTOP_PLATFORM: 'mac', HAS_SIGNING: 'true' }

test('automatic versions stay below the configured next stable release, without changing stable validation', () => {
  for (const next of ['0.2.5', '1.0.0', '12.34.56']) {
    const values = prepareBuild(automatic, next)
    assert.equal(values.DESKTOP_CI_VERSION, `${next}-dev.17`)
    assert.equal(values.CRYSOUND_DESKTOP_VERSION, '')
    assert.equal(values.CRYSOUND_DESKTOP_UPDATE_URL, '')
    assert.equal(companyDesktopVersion(values), `${next}-dev.17`)
    assert.equal(lt(values.DESKTOP_CI_VERSION, next), true)
    assert.throws(() => releaseVersion(values.DESKTOP_CI_VERSION))
  }
  for (const invalid of ['0.2.5', '0.2.5-rc.17', '0.2.5-dev.0', '0.2.5-dev.017', '0.2.5-dev.17+1', '0.2.5-dev.9007199254740992']) {
    assert.throws(() => previewVersion(invalid))
  }
  assert.throws(() => prepareBuild({ ...automatic, GITHUB_RUN_NUMBER: '1\nINJECT=true' }, '0.2.5'))
  assert.throws(() => companyDesktopVersion({ CRYSOUND_DESKTOP_VERSION: '0.2.5', CRYSOUND_DESKTOP_PREVIEW_VERSION: '0.2.5-dev.17' }))
})

test('main Mac requires secrets while fork PRs and Windows can build unsigned previews', () => {
  assert.throws(() => prepareBuild({ ...automatic, HAS_SIGNING: 'false' }, '0.2.5'), /缺少完整签名和公证凭据/u)
  for (const event of ['pull_request', 'push']) {
    const env = { ...automatic, GITHUB_EVENT_NAME: event, HAS_SIGNING: 'false' }
    if (event === 'pull_request') assert.equal(prepareBuild(env, '0.2.5').DESKTOP_CI_VERSION, '0.2.5-dev.17')
    assert.equal(prepareBuild({ ...env, DESKTOP_PLATFORM: 'win' }, '0.2.5').DESKTOP_CI_VERSION, '0.2.5-dev.17')
  }
})

test('manual builds keep stable-only versions and the Mac update URL requirement', () => {
  const env = { ...automatic, GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: '0.2.5', REQUESTED_UPDATE_URL: 'https://gateway.example.test/_zp/updates/mac/' }
  const values = prepareBuild(env)
  assert.equal(values.CRYSOUND_DESKTOP_VERSION, '0.2.5')
  assert.equal(values.CRYSOUND_DESKTOP_PREVIEW_VERSION, '')
  assert.equal(values.CRYSOUND_DESKTOP_UPDATE_URL, env.REQUESTED_UPDATE_URL)
  assert.equal(companyDesktopVersion(values), '0.2.5')
  assert.throws(() => prepareBuild({ ...env, REQUESTED_VERSION: '0.2.5-dev.17' }))
  assert.throws(() => prepareBuild({ ...env, REQUESTED_UPDATE_URL: '' }))
  assert.equal(prepareBuild({ ...env, DESKTOP_PLATFORM: 'win', REQUESTED_UPDATE_URL: '' }).CRYSOUND_DESKTOP_VERSION, '0.2.5')
})

test('CI command exports preview-only inputs and summarizes actual artifact sizes and signing failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-ci-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const envFile = join(root, 'env')
  const summaryFile = join(root, 'summary')
  const dmg = join(root, 'crysound-workpartner-0.2.5-dev.17-mac-arm64-unsigned.dmg')
  await writeFile(dmg, 'preview bytes')
  const env = { ...process.env, ...automatic, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: summaryFile }
  const script = fileURLToPath(new URL('./desktop-ci.mjs', import.meta.url))
  await exec(process.execPath, [script, 'prepare'], { env })
  const exported = Object.fromEntries((await readFile(envFile, 'utf8')).trimEnd().split('\n').map(line => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
  assert.match(exported.DESKTOP_CI_VERSION, /^\d+\.\d+\.\d+-dev\.17$/u)
  assert.equal(exported.CRYSOUND_DESKTOP_VERSION, '')
  assert.equal(exported.CRYSOUND_DESKTOP_UPDATE_URL, '')
  await exec(process.execPath, [script, 'summary', dmg], {
    env: { ...env, ...exported, HAS_SIGNING: 'false', GITHUB_SHA: 'a'.repeat(40) },
  })
  const summary = await readFile(summaryFile, 'utf8')
  assert.match(summary, /未签名预览/u)
  assert.ok(summary.includes(exported.DESKTOP_CI_VERSION))
  assert.ok(summary.includes('a'.repeat(40)))
  assert.ok(summary.includes(`| ${basename(dmg)} | 13 |`))
  assert.match(summary, /不生成或上传更新清单/u)
  const failed = await buildSummary({ ...env, SIGNING_OUTCOME: 'failure' }, [dmg, join(root, 'absent.dmg')])
  assert.match(failed, /签名、公证或盖章失败/u)
  await assert.rejects(exec(process.execPath, [script, 'prepare'], { env: { ...env, HAS_SIGNING: 'false' } }))
  assert.match(await readFile(summaryFile, 'utf8'), /缺少完整签名和公证凭据/u)
})
