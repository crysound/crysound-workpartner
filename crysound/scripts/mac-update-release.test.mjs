import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { configureSignedApp, releaseVersion, updateDirectory, verifyUpdateMetadata, writeUpdateMetadata } from './mac-update-release.mjs'

test('release inputs reject versions the updater cannot order and unsafe feed URLs', () => {
  assert.equal(releaseVersion('0.2.3'), '0.2.3')
  for (const value of ['v0.2.3', '0.2.3-rc.1', '0.2.3+1', '01.2.3', '', '1.2', '1.2.9007199254740992']) {
    assert.throws(() => releaseVersion(value))
  }
  assert.equal(updateDirectory('https://gateway.example.test/_zp/updates/mac'), 'https://gateway.example.test/_zp/updates/mac/')
  for (const value of ['http://downloads.example.test/', 'https://user:password@example.test/', 'https://example.test/?key=x', 'https://example.test/#x', 'https://example.test/_zp/download/', 'https://example.test/public/mac/', '']) {
    assert.throws(() => updateDirectory(value))
  }
})

test('the real desktop builder numbers stable and preview shells without changing source/runtime manifests', async t => {
  // This configuration check never signs, notarizes, or loads Windows-specific build tools.
  const unavailable = () => { throw new Error('Config check must not invoke signing or packaging tools') }
  const replace = (path, namedExports) => {
    const handle = mock.module(path, { namedExports })
    t.after(() => handle.restore())
  }
  replace('../../apps/desktop/scripts/windows-sign.mjs', {
    createWindowsTokenSigner: unavailable, installWindowsNsisBootstrapSigner: unavailable,
    resolveWindowsUpdatePublisher: unavailable, scrubWindowsSigningEnvironment: unavailable,
  })
  replace('../../apps/desktop/scripts/windows-directory-installer.mjs', { installWindowsDirectoryInstaller() {} })
  replace('../../apps/desktop/scripts/windows-asar-unpack.mjs', { prepareWindowsAsarUnpack: unavailable, verifyWindowsAsarUnpack: unavailable })
  replace('../../apps/desktop/scripts/notarize-macos.mjs', { notarizeMacOS: unavailable })
  const { createElectronBuilderConfig } = await import('../../apps/desktop/scripts/electron-builder-config.mjs')
  const manifests = ['../../package.json', '../../apps/desktop/package.json'].map(path => new URL(path, import.meta.url))
  const before = await Promise.all(manifests.map(path => readFile(path, 'utf8')))
  const env = {
    DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.crysound.workpartner', CRYSOUND_DESKTOP_VERSION: '0.2.3',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://gateway.example.test',
  }
  const config = createElectronBuilderConfig(env, 'darwin', 'arm64')
  assert.equal(config.extraMetadata.version, '0.2.3')
  assert.equal(config.publish, null)
  assert.equal(createElectronBuilderConfig(env, 'darwin', 'arm64').extraMetadata.version, '0.2.3')
  assert.deepEqual(await Promise.all(manifests.map(path => readFile(path, 'utf8'))), before)
  assert.equal(JSON.parse(before[0]).version, JSON.parse(before[1]).version)
  assert.throws(() => createElectronBuilderConfig({ ...env, CRYSOUND_DESKTOP_VERSION: '0.2.3-rc.1' }, 'darwin', 'arm64'))
  assert.equal(createElectronBuilderConfig({ ...env, CRYSOUND_DESKTOP_VERSION: undefined }, 'darwin', 'arm64').extraMetadata.version, undefined)
  for (const platform of ['darwin', 'win32']) {
    const preview = createElectronBuilderConfig({ ...env, CRYSOUND_DESKTOP_VERSION: '', CRYSOUND_DESKTOP_PREVIEW_VERSION: '0.2.5-dev.17' }, platform, platform === 'darwin' ? 'arm64' : 'x64')
    assert.equal(preview.extraMetadata.version, '0.2.5-dev.17')
    assert.equal(preview.publish, null)
    assert.equal(preview.extraMetadata.dshDesktopUpdateChannel, 'nightly')
  }
  assert.equal(createElectronBuilderConfig(env, 'win32', 'x64').extraMetadata.version, '0.2.3')
  assert.deepEqual(await Promise.all(manifests.map(path => readFile(path, 'utf8'))), before)
})

test('signed-app configuration and feed describe the exact final ZIP bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'CRYSOUND WorkPartner.app')
  await mkdir(join(app, 'Contents/Resources'), { recursive: true })
  await configureSignedApp(app, 'https://gateway.example.test/_zp/updates/mac')
  assert.deepEqual(JSON.parse(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8')), {
    provider: 'generic', url: 'https://gateway.example.test/_zp/updates/mac/', channel: 'latest',
    updaterCacheDirName: 'crysound-workpartner-updater',
  })
  const zip = join(root, 'crysound-workpartner-0.2.3-mac-arm64.zip')
  const bytes = Buffer.from('fixture representing the final ZIP bytes')
  await writeFile(zip, bytes)
  const metadata = await writeUpdateMetadata(zip, '0.2.3')
  const first = await readFile(metadata, 'utf8')
  const feed = JSON.parse(first)
  const downloaded = await readFile(join(root, feed.files[0].url))
  assert.equal(feed.version, '0.2.3')
  assert.equal(feed.path, 'crysound-workpartner-0.2.3-mac-arm64.zip')
  assert.equal(feed.files[0].size, downloaded.length)
  assert.equal(feed.files[0].sha512, createHash('sha512').update(downloaded).digest('base64'))
  assert.equal(feed.sha512, feed.files[0].sha512)
  await writeUpdateMetadata(zip, '0.2.3')
  assert.equal(await readFile(metadata, 'utf8'), first)
  await verifyUpdateMetadata(zip, '0.2.3')
  await writeFile(zip, 'changed after hashing')
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await writeFile(zip, bytes)
  await writeFile(metadata, JSON.stringify({ ...feed, version: '0.2.4' }))
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await writeFile(metadata, JSON.stringify({ ...feed, files: [{ ...feed.files[0], size: 1 }] }))
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await assert.rejects(writeUpdateMetadata(zip, '0.2.4'))
  await writeFile(zip, '')
  await assert.rejects(writeUpdateMetadata(zip, '0.2.3'))
})
